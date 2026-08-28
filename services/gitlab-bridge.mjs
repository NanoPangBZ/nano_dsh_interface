// =====================================================================
// DSH GitLab 桥接服务（Node）
// 职责：
//   1. 读取/写入 gitlab-config.json（URL + 令牌，供设置面板配置）
//   2. 每 30 秒抓取"指派给我的开放 Issue"，写 dist/assets/gitlab-tasks.json
//   3. 本地 HTTP 接口（127.0.0.1:3081）：
//        GET  /config        -> { url, tokenConfigured, user? }
//        POST /config        -> { url, token } 保存并立即刷新
//        POST /test          -> 测试连接（不保存）
//   带 CORS，供 Web GUI（127.0.0.1:3080）调用。
// =====================================================================
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "gitlab-config.json");
const OUT_PATH = path.join(__dirname, "dist", "assets", "gitlab-tasks.json");
const PORT = 3081;
const INTERVAL_MS = 30000;
const TIMEOUT_MS = 15000;

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { url: String(raw.url || "").trim(), token: String(raw.token || "").trim() };
  } catch {
    return { url: "", token: "" };
  }
}

let config = loadConfig();

function saveConfig({ url, token } = {}) {
  config = {
    url: String(url || "").trim(),
    token: String(token || "").trim()
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function writeOut(obj) {
  const json = JSON.stringify(obj);
  const tmp = OUT_PATH + ".tmp";
  writeFileSync(tmp, json);
  renameSync(tmp, OUT_PATH);
}

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

// ---------------- HTTP 配置接口 ----------------
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

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
          // /test：用提交的值试连，不保存
          const prev = config;
          saveConfig({ url: data.url, token: data.token });
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
  send(404, { error: "not found" });
});

let lastUser = null;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gitlab-bridge] listening on http://127.0.0.1:${PORT}`);
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
