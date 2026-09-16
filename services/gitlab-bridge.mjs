// =====================================================================
// DSH GitLab 桥接服务（Node）
// 职责：
//   1. 读取/写入 GitLab 配置（URL 明文存 json；令牌 DPAPI 加密存 gitlab-token.enc，
//      不再明文落盘；旧版 json 中的明文令牌首次启动自动迁移）
//   2. 每 30 秒抓取"指派给我的开放 Issue"，原子写入 <仓库>\data\gitlab-tasks.json
//   3. 本地 HTTP 接口（127.0.0.1:3081）：
//        GET  /config            -> { url, tokenConfigured, user? }
//        POST /config            -> { url, token } 保存并立即刷新
//        POST /test              -> 测试连接（不保存）
//        GET  /health            -> 服务健康状态
//        GET  /metrics           -> <仓库>\data\metrics.json 的文件内容（缺失时返回 {}）
//        GET  /tasks             -> <仓库>\data\gitlab-tasks.json 的文件内容（缺失时返回 {}）
//        GET  /default-background-> <仓库>\assets\background.jpg 的图片字节（缺失时 404）
//        POST /background        -> { image: dataURL } 把当前背景保存为默认 background.jpg
//                                  （同时同步到 NANO_BG_SYNC_PATH 指定的插件仓库目录）
//   说明：服务、数据与默认背景全部住在插件仓库里（services\ / data\ / assets\），
//         不再写入 DSH 前端包目录，避免 DSH 升级覆盖 dist 时把数据一起清掉。
//   安全：CORS 白名单（仅 127.0.0.1:3080 / localhost:3080）+ Host 校验（防 DNS rebinding）
// =====================================================================
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 插件仓库根目录：本脚本位于 <仓库>\services\，因此由脚本自身位置推导（仓库可整体移动）
const REPO = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO, "data");     // 任务 / 监控数据目录
const ASSETS_DIR = path.join(REPO, "assets"); // 默认背景图目录
const CONFIG_PATH = path.join(__dirname, "gitlab-config.json");
const TOKEN_ENC_PATH = path.join(__dirname, "gitlab-token.enc");
const OUT_PATH = path.join(DATA_DIR, "gitlab-tasks.json");
const METRICS_PATH = path.join(DATA_DIR, "metrics.json");
const BG_PATH = path.join(ASSETS_DIR, "background.jpg");
const BG_SYNC_PATH = process.env.NANO_BG_SYNC_PATH || ""; // 兼容旧调用：额外的背景同步目录（可选）
const PORT = 3081;
const INTERVAL_MS = 30000;
const TIMEOUT_MS = 15000;
const MAX_BG_DECODED = 6 * 1024 * 1024; // 默认背景解码后上限 6MB
const startedAt = Date.now();

/** 本机 origin 白名单：回环 + 本机所有网卡 IP（兼容经局域网 IP 打开 DSH 页面） */
const LOCAL_ORIGIN_HOSTS = (() => {
  const set = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni && (ni.family === "IPv4" || ni.family === 4 || ni.family === "IPv6" || ni.family === 6)) {
          set.add(String(ni.address).toLowerCase());
        }
      }
    }
  } catch (e) { /* 收集失败则只保留回环 */ }
  return set;
})();

/* ---------------- DPAPI 令牌加密（经 powershell.exe ProtectedData） ---------------- */
function dpapi(script, input) {
  try {
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { input, encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (r.status !== 0) return null;
    return String(r.stdout || "").trim();
  } catch (e) {
    return null;
  }
}

const PROTECT_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "$t = [Console]::In.ReadToEnd(); " +
  "$b = [System.Text.Encoding]::UTF8.GetBytes($t); " +
  "$e = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
  "[Convert]::ToBase64String($e)";

const UNPROTECT_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "$s = [Console]::In.ReadToEnd().Trim(); " +
  "if (-not $s) { exit 1 }; " +
  "$b = [Convert]::FromBase64String($s); " +
  "$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
  "[System.Text.Encoding]::UTF8.GetString($d)";

function protectToken(token) {
  return dpapi(PROTECT_SCRIPT, token);
}
function unprotectToken(b64) {
  return dpapi(UNPROTECT_SCRIPT, b64);
}

/* ---------------- 配置读写 ---------------- */
function loadConfig() {
  let url = "";
  let legacyToken = "";
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    url = String(raw.url || "").trim();
    if (raw.token && !/PASTE_YOUR_TOKEN_HERE/i.test(String(raw.token))) {
      legacyToken = String(raw.token).trim(); // 旧版明文令牌，待迁移
    }
  } catch { /* 配置缺失 */ }

  let token = "";
  if (existsSync(TOKEN_ENC_PATH)) {
    try {
      const b64 = readFileSync(TOKEN_ENC_PATH, "utf8").trim();
      token = unprotectToken(b64) || "";
    } catch { /* 解密失败则视为未配置 */ }
  }
  if (!token && legacyToken) {
    // 一次性迁移：明文令牌 -> 加密文件，并从 json 移除
    const enc = protectToken(legacyToken);
    if (enc) {
      try {
        writeFileSync(TOKEN_ENC_PATH, enc);
        token = legacyToken;
        const clean = { url, tokenConfigured: true };
        writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2) + "\n");
        console.log("[gitlab-bridge] 已把明文令牌迁移为 DPAPI 加密存储");
      } catch (e) { /* 迁移失败则保留内存使用 */ }
    }
  }
  return { url, token };
}

let config = loadConfig();

function saveConfig({ url, token } = {}) {
  config.url = String(url || "").trim();
  const newToken = String(token || "").trim();
  if (newToken) {
    const enc = protectToken(newToken);
    if (!enc) throw new Error("令牌加密失败（DPAPI 不可用）");
    writeFileSync(TOKEN_ENC_PATH, enc);
    config.token = newToken;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify({ url: config.url, tokenConfigured: !!config.token }, null, 2) + "\n");
}

/** 确保目录存在（原子写入前调用，目录缺失时自动创建） */
function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) { /* 已存在或创建失败：交由后续写入报错 */ }
}

function writeOut(obj) {
  const json = JSON.stringify(obj);
  ensureDir(DATA_DIR);
  const tmp = OUT_PATH + ".tmp";
  writeFileSync(tmp, json);
  renameSync(tmp, OUT_PATH);
}

/* ---------------- 数据文件读取（供 HTTP 直接吐给前端） ---------------- */
/** 读取 JSON 文件原文；文件缺失、为空或内容损坏时回退为 {}（避免前端刷 404 错误） */
function readJsonFile(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    if (!text.trim()) return "{}";
    JSON.parse(text); // 校验：写盘是原子的，这里只兜底外部损坏
    return text;
  } catch (e) {
    return "{}";
  }
}

/* ---------------- GitLab 抓取 ---------------- */
async function fetchIssues() {
  const base = config.url.replace(/\/+$/, "");
  const token = config.token || process.env.GITLAB_TOKEN || "";
  if (!base || !token) {
    return { error: "未配置 GitLab 地址或令牌，请在 设置 → 主题设置 → GitLab 配置 中填写", user: null, count: 0, issues: [] };
  }
  const headers = { "PRIVATE-TOKEN": token, Accept: "application/json" };
  const timeout = { signal: AbortSignal.timeout(TIMEOUT_MS) };
  try {
    const meRes = await fetch(`${base}/api/v4/user`, { headers, ...timeout });
    if (!meRes.ok) {
      return { error: `用户接口 ${meRes.status}${meRes.status === 401 ? "（令牌无效或权限不足）" : ""}`, user: null, count: 0, issues: [] };
    }
    const me = await meRes.json();
    const issuesRes = await fetch(
      `${base}/api/v4/issues?assignee_id=${me.id}&state=opened&scope=assigned_to_me&per_page=100`,
      { headers, ...timeout }
    );
    if (!issuesRes.ok) {
      return { error: `任务接口 ${issuesRes.status}${issuesRes.status === 401 ? "（令牌无效或权限不足）" : ""}`, user: me.username, count: 0, issues: [] };
    }
    const issues = await issuesRes.json();
    const baseOrigin = new URL(base).origin;
    const list = (Array.isArray(issues) ? issues : []).map((it) => {
      let url = it.web_url || "";
      try {
        const u = new URL(url);
        url = baseOrigin + u.pathname + u.search;
      } catch { /* 保持原样 */ }
      return {
        iid: it.iid,
        ref: (it.references && it.references.full) || "#" + it.iid,
        title: it.title || "",
        labels: Array.isArray(it.labels) ? it.labels : [],
        due: it.due_date || null,
        url,
        updated: it.updated_at || null
      };
    });
    return { error: null, user: me.username, count: list.length, issues: list };
  } catch (e) {
    return { error: String((e && e.message) || e), user: null, count: 0, issues: [] };
  }
}

async function refresh() {
  const result = await fetchIssues();
  writeOut({ ts: Math.floor(Date.now() / 1000), ...result });
  return result;
}

/* ---------------- 默认背景写入 ---------------- */
function saveDefaultBackground(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || "").trim());
  if (!m) throw new Error("无效的图片数据（需要 data:image/*;base64 格式）");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length === 0) throw new Error("图片数据为空");
  if (buf.length > MAX_BG_DECODED) throw new Error("图片过大（解码后 >6MB）");
  // 原子写入 <仓库>\assets\background.jpg
  ensureDir(ASSETS_DIR);
  const tmp = BG_PATH + ".tmp";
  writeFileSync(tmp, buf);
  renameSync(tmp, BG_PATH);
  // 兼容旧调用：额外同步到 NANO_BG_SYNC_PATH（现在通常与上面是同一个目录，幂等）
  if (BG_SYNC_PATH) {
    try {
      const syncPath = path.join(BG_SYNC_PATH, "background.jpg");
      const syncTmp = syncPath + ".tmp";
      writeFileSync(syncTmp, buf);
      renameSync(syncTmp, syncPath);
    } catch (e) {
      console.warn(`[gitlab-bridge] 同步默认背景到插件目录失败: ${e.message}`);
    }
  }
  return { ok: true, bytes: buf.length };
}

/* ---------------- HTTP 服务 ---------------- */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器请求（本机脚本/curl）放行
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOCAL_ORIGIN_HOSTS.has(host);
  } catch (e) {
    return false;
  }
}
function isLoopbackHost(req) {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  if (!isLoopbackHost(req)) { send(403, { error: "forbidden host" }); return; }
  if (isAllowedOrigin(req)) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // 新增数据路由：容忍前端拼 ?t=<时间戳> 的缓存戳，只取路径部分
  const pathname = String(req.url || "").split("?")[0];

  // GET /metrics：直接回吐 <仓库>\data\metrics.json（metrics-writer.ps1 每 2 秒原子写入）
  if (req.method === "GET" && pathname === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readJsonFile(METRICS_PATH));
    return;
  }
  // GET /tasks：直接回吐 <仓库>\data\gitlab-tasks.json（本服务每 30 秒原子写入）
  if (req.method === "GET" && pathname === "/tasks") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readJsonFile(OUT_PATH));
    return;
  }
  // GET /default-background：回吐 <仓库>\assets\background.jpg 的原始字节（缺失时 404）
  if (req.method === "GET" && pathname === "/default-background") {
    let buf = null;
    try { buf = readFileSync(BG_PATH); } catch (e) { buf = null; }
    if (!buf || buf.length === 0) { send(404, { error: "default background not found" }); return; }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
    res.end(buf);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    // 结构保持兼容（ok/name/uptime/tokenConfigured），额外补一个数据目录字段
    send(200, { ok: true, name: "gitlab-bridge", uptime: Math.floor((Date.now() - startedAt) / 1000), tokenConfigured: !!config.token, dataDir: DATA_DIR });
    return;
  }
  if (req.method === "GET" && req.url === "/config") {
    send(200, { url: config.url, tokenConfigured: !!config.token, user: lastUser });
    return;
  }
  if (req.method === "POST" && (req.url === "/config" || req.url === "/test")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        if (req.url === "/config") {
          saveConfig({ url: data.url, token: data.token });
          const result = await refresh();
          send(200, { ok: !result.error, user: result.user, error: result.error });
        } else {
          // /test：用提交的值试连，不保存（纯内存替换，不落盘）
          const prev = config;
          config = {
            url: String(data.url || "").trim(),
            token: String(data.token || "").trim() || prev.token
          };
          const result = await fetchIssues();
          config = prev;
          send(200, { ok: !result.error, user: result.user, error: result.error });
        }
      } catch (e) {
        send(400, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/background") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const r = saveDefaultBackground(data.image);
        send(200, r);
      } catch (e) {
        send(400, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return;
  }
  send(404, { error: "not found" });
});

let lastUser = null;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gitlab-bridge] listening on http://127.0.0.1:${PORT} (数据目录: ${DATA_DIR})${BG_SYNC_PATH ? " (背景同步: " + BG_SYNC_PATH + ")" : ""}`);
  refresh().then((r) => {
    lastUser = r.user;
    if (r.error) console.log(`[gitlab-bridge] 初次抓取提示: ${r.error}`);
    else console.log(`[gitlab-bridge] 初次抓取成功: ${r.user} 共 ${r.count} 条`);
  });
});

setInterval(async () => {
  const r = await refresh();
  lastUser = r.user;
  if (r.error) console.log(`[gitlab-bridge] ${r.error}`);
}, INTERVAL_MS);

/* 兜底：任何未捕获异常只记录不退出 */
process.on("uncaughtException", (e) => {
  console.error("[gitlab-bridge] uncaughtException:", e && e.stack ? e.stack : e);
});
process.on("unhandledRejection", (e) => {
  console.error("[gitlab-bridge] unhandledRejection:", e && e.stack ? e.stack : e);
});
