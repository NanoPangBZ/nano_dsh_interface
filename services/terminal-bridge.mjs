// =====================================================================
// DSH PowerShell 终端桥接服务（Node + node-pty + ws）
// 监听 127.0.0.1:3082。每个 WebSocket 连接 = 一个独立的 pwsh PTY 会话，
// 支持多个终端横向排布。
// 协议（JSON over WebSocket）：
//   客户端 -> 服务端: {type:'input', data} | {type:'resize', cols, rows}
//                     | {type:'restart'}
//   服务端 -> 客户端: {type:'out', data} | {type:'exit', data:{code}}
//                     | {type:'err', data}
// HTTP 接口：
//   GET /health      服务健康状态（供设置面板"后台服务状态"）
//   GET /pick-folder 原生文件夹选择框
// 健壮性改进：
//   - pwsh 路径动态探测（where.exe 优先，含 WindowsApps 常见版本兜底）
//   - node-pty 缺失时服务仍可启动，/health 报告缺失，WS 返回明确错误
//   - CORS 白名单（仅 127.0.0.1:3080 / localhost:3080）+ Host 校验（防 DNS rebinding）
// =====================================================================
import { createRequire } from "node:module";
import { existsSync, statSync, readdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const PORT = 3082;
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

/** 解析 pwsh 完整路径（ConPTY 需要绝对路径） */
function resolvePwsh() {
  // 1) PATH 探测（最通用）
  try {
    const r = spawnSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (r.status === 0 && r.stdout) {
      const first = String(r.stdout).split(/\r?\n/)[0].trim();
      if (first && existsSync(first)) return first;
    }
  } catch (e) { /* ignore */ }
  // 2) 已知路径兜底
  const candidates = [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    (process.env.ProgramFiles || "") + "\\PowerShell\\7\\pwsh.exe"
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // 3) 注册表查询（HKLM 安装路径）
  try {
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe' -ErrorAction SilentlyContinue).'(default)'"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const p = r.stdout ? String(r.stdout).trim() : "";
    if (p && existsSync(p)) return p;
  } catch (e) { /* ignore */ }
  // 4) 交给系统 PATH
  return "pwsh";
}
const PWSH = resolvePwsh();

/** node-pty 缺失时降级：服务仍可启动（/health 报告），WS 返回明确错误 */
let pty = null;
let ptyError = null;
try {
  pty = require("node-pty");
} catch (e) {
  ptyError = String((e && e.message) || e);
  console.error(`[terminal-bridge] node-pty 不可用: ${ptyError}`);
}

const wss = new WebSocketServer({ noServer: true });

/** 用原生 Windows 文件夹选择框（FolderBrowserDialog，STA 线程）选目录 */
function pickFolder(start) {
  return new Promise((resolve) => {
    const startLit = "'" + String(start || "").replace(/'/g, "''") + "'";
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      "$d.Description = '选择终端工作目录'; " +
      `$d.SelectedPath = ${startLit}; ` +
      "$d.ShowNewFolderButton = $true; " +
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }";
    const ps = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false });
    let out = "";
    ps.stdout.on("data", (c) => (out += String(c)));
    ps.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      try { ps.kill(); } catch (e) { /* ignore */ }
      resolve(null);
    }, 180000);
    ps.on("close", () => {
      clearTimeout(timer);
      const path = out.trim();
      resolve(path.length > 0 ? path : null);
    });
    ps.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * 自研目录扫描（无系统弹窗）：列出 path 下的子目录 + 父路径。
 * path 为空/无效时返回本机盘符列表。
 * 返回：{ ok, drives?, path?, parent?, entries?, error? }
 */
function listDir(p) {
  let target = String(p || "").trim().replace(/^"|"$/g, "");
  if (!target) {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c) + ":\\";
      try { if (existsSync(letter)) drives.push(letter); } catch (e) { /* ignore */ }
    }
    return { ok: true, drives, path: "", parent: null, entries: [] };
  }
  let st = null;
  try {
    st = statSync(target);
  } catch (e) {
    return { ok: false, error: "路径不存在或无法访问：" + target };
  }
  if (!st.isDirectory()) target = path.dirname(target); // 指向文件 → 取其父目录
  const parsed = path.parse(target);
  const parent = parsed.root === target ? null : parsed.dir; // 盘符根无上级
  let names = [];
  try {
    names = readdirSync(target, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
  } catch (e) {
    return { ok: false, error: "无法读取目录（权限不足）：" + target };
  }
  return {
    ok: true,
    drives: null,
    path: target,
    parent,
    entries: names.map((name) => ({ name, path: path.join(target, name) }))
  };
}

/** CORS + Host 校验：仅允许本机页面访问（回环 + 本机网卡 IP 的 origin） */
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

/** HTTP + WebSocket 共用服务 */
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  if (!isLoopbackHost(req)) { send(403, { error: "forbidden host" }); return; }
  if (isAllowedOrigin(req)) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    send(200, {
      ok: true,
      name: "terminal-bridge",
      pty: pty ? "ok" : "missing",
      ptyError,
      pwsh: PWSH,
      uptime: Math.floor((Date.now() - startedAt) / 1000)
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/list-dir")) {
    const url = new URL(req.url, "http://x");
    try {
      send(200, listDir(url.searchParams.get("path") || ""));
    } catch (e) {
      send(500, { ok: false, error: "目录扫描异常：" + String((e && e.message) || e) });
    }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/pick-folder")) {
    const url = new URL(req.url, "http://x");
    const start = url.searchParams.get("start") || process.env.USERPROFILE || "";
    pickFolder(start).then((path) => {
      send(200, path ? { path } : { cancelled: true });
    });
    return;
  }
  send(404, { error: "not found" });
});

server.on("upgrade", (req, socket, head) => {
  if (!isLoopbackHost(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[terminal-bridge] ws://127.0.0.1:${PORT} (pwsh: ${PWSH}${pty ? "" : " | node-pty 缺失!"})`);
});

/* 兜底：任何未捕获异常只记录不退出（HTTP handler 已逐点 try/catch，此为最后防线） */
process.on("uncaughtException", (e) => {
  console.error("[terminal-bridge] uncaughtException:", e && e.stack ? e.stack : e);
});
process.on("unhandledRejection", (e) => {
  console.error("[terminal-bridge] unhandledRejection:", e && e.stack ? e.stack : e);
});

/** 提示符：发出 CWD 的 OSC 1337;CurrentDir 标记（iTerm2 标准协议，ConPTY 可透传），
    同时保持接近原生的 "PS <path>> " 提示符 */
const PROMPT_SETUP =
  "function prompt { [Console]::Write([char]27 + ']1337;CurrentDir=' + $PWD.Path + [char]7); 'PS ' + $PWD.Path + '> ' }";
const CWD_PREFIX = "\x1b]1337;CurrentDir=";

function spawnShell() {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    PAGER: "cat",
    GIT_PAGER: "cat"
  };
  const p = pty.spawn(PWSH, ["-NoLogo", "-NoProfile"], {
    name: "xterm-256color",
    cols: 100,
    rows: 28,
    cwd: process.env.USERPROFILE || process.cwd(),
    env
  });
  p.write(PROMPT_SETUP + "; Clear-Host\r");
  return p;
}

/** 从 PTY 输出中剥离 CWD OSC，剩余部分原样转发 */
function createOutputParser(onCwd, onOut) {
  let buf = "";
  return (data) => {
    buf += data;
    let idx;
    while ((idx = buf.indexOf(CWD_PREFIX)) >= 0) {
      const end = buf.indexOf("\x07", idx);
      if (end < 0) break; // OSC 未完整，等待下一块
      const path = buf.slice(idx + CWD_PREFIX.length, end);
      try {
        onCwd(path);
      } catch (e) { /* ignore */ }
      buf = buf.slice(0, idx) + buf.slice(end + 1);
    }
    if (buf.length > 0) {
      onOut(buf);
      buf = "";
    }
  };
}

wss.on("connection", (ws) => {
  if (!pty) {
    ws.send(JSON.stringify({
      type: "err",
      data: "terminal-bridge 缺少 node-pty 依赖（" + (ptyError || "未知错误") + "），请在插件仓库执行: npm install"
    }));
    return;
  }
  let shell = spawnShell();

  const send = (type, data) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
  };
  const bind = (p) => {
    const onData = createOutputParser(
      (path) => send("cwd", path),
      (text) => send("out", text)
    );
    p.onData(onData);
    p.onExit(({ exitCode }) => send("exit", { code: exitCode }));
  };
  bind(shell);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === "input") {
        shell.write(String(msg.data));
      } else if (msg.type === "resize") {
        const cols = Math.max(20, Number(msg.cols) || 100);
        const rows = Math.max(5, Number(msg.rows) || 28);
        shell.resize(cols, rows);
      } else if (msg.type === "restart") {
        try {
          shell.kill();
        } catch (e) { /* ignore */ }
        shell = spawnShell();
        bind(shell);
      }
    } catch (e) {
      send("err", String((e && e.message) || e));
    }
  });
  ws.on("close", () => {
    try {
      shell.kill();
    } catch (e) { /* ignore */ }
  });
  ws.on("error", () => {});
});
