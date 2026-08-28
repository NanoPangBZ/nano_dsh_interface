// =====================================================================
// DSH PowerShell 终端桥接服务（Node + node-pty + ws）
// 监听 127.0.0.1:3082。每个 WebSocket 连接 = 一个独立的 pwsh PTY 会话，
// 支持多个终端横向排布。
// 协议（JSON over WebSocket）：
//   客户端 -> 服务端: {type:'input', data} | {type:'resize', cols, rows}
//                     | {type:'restart'}
//   服务端 -> 客户端: {type:'out', data} | {type:'exit', data:{code}}
//                     | {type:'err', data}
// =====================================================================
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const PORT = 3082;

/** 解析 pwsh 完整路径（ConPTY 需要绝对路径） */
function resolvePwsh() {
  const candidates = [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    (process.env.ProgramFiles || "") + "\\PowerShell\\7\\pwsh.exe",
    "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe\\pwsh.exe"
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return "pwsh";
}
const PWSH = resolvePwsh();

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

/** HTTP + WebSocket 共用服务 */
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/pick-folder")) {
    const url = new URL(req.url, "http://x");
    const start = url.searchParams.get("start") || process.env.USERPROFILE || "";
    pickFolder(start).then((path) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(path ? { path } : { cancelled: true }));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[terminal-bridge] ws://127.0.0.1:${PORT} (pwsh: ${PWSH})，每连接独立会话`);
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
