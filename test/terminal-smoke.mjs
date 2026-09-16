/* =====================================================================
   test/terminal-smoke.mjs — PowerShell 终端端到端冒烟测试
   =====================================================================
   真的连上 ws://127.0.0.1:3082，开一个 PTY 会话、敲一条命令、读回输出。
   这验证的是「桥服务 + node-pty + pwsh + 协议」整条链路，比只看挂载强得多。

   断言用的标记必须在**输入**里不连续出现，否则 PTY 回显会假通过：
   发送  Write-Output ('NANO' + '_PTY_' + (40 + 2))
   期待  NANO_PTY_42

   前置：先运行 start-services.ps1
   运行：node test/terminal-smoke.mjs
   ===================================================================== */
import WebSocket from "ws";

const URL = "ws://127.0.0.1:3082";
const CMD = "Write-Output ('NANO' + '_PTY_' + (40 + 2))";
const MARKER = "NANO_PTY_42";
const TIMEOUT_MS = 20000;

let failed = 0;
function check(name, cond, extra = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "\u2713" : "\u2717"} ${name}${extra ? "  \u2014 " + extra : ""}`);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* 先探一次健康接口，PTY 不可用时给出明确原因 */
try {
  const res = await fetch("http://127.0.0.1:3082/health");
  const h = await res.json();
  console.log("\n[1] 桥服务健康");
  check("HTTP 200", res.ok);
  check("PTY 可用", h.pty === "ok", `pty=${h.pty}${h.ptyError ? " err=" + h.ptyError : ""}`);
  check("探测到 pwsh", typeof h.pwsh === "string" && h.pwsh.length > 0, h.pwsh);
} catch (e) {
  console.log("\n[1] 桥服务健康");
  check("能连上 127.0.0.1:3082", false, String(e.message));
  console.log("\n先运行 start-services.ps1 再试。\n");
  process.exit(1);
}

/* ---------- 真实 PTY 会话 ---------- */
console.log("\n[2] 真实 PTY 会话");
const ws = new WebSocket(URL);
let out = "";
let sawErr = null;
const sawTypes = new Set();

const opened = await new Promise((resolve) => {
  ws.on("open", () => resolve(true));
  ws.on("error", (e) => { sawErr = e.message; resolve(false); });
  setTimeout(() => resolve(false), 5000);
});
check("WebSocket 已连接", opened, sawErr || "");

if (!opened) {
  console.log(`\n\u2717 失败 ${failed} 项\n`);
  process.exit(1);
}

ws.on("message", (raw) => {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.type) sawTypes.add(m.type);
  if (m.type === "err") sawErr = m.data;
  if (typeof m.data === "string") out += m.data;
});

/* 等 shell 出提示符 */
await delay(2000);
check("收到过服务端消息", sawTypes.size > 0, [...sawTypes].join(",") || "无");
check("未收到错误消息", sawErr === null, sawErr || "");

/* 敲命令，轮询等待输出 */
ws.send(JSON.stringify({ type: "input", data: CMD + "\r" }));
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline && !out.includes(MARKER)) await delay(200);

console.log("\n[3] 命令往返");
check(`shell 执行并回显了输出标记 ${MARKER}`, out.includes(MARKER),
  out.includes(MARKER) ? "" : `已收到 ${out.length} 字符但未见标记`);

/* 再来一条，验证会话可复用（不是一次性） */
out = "";
ws.send(JSON.stringify({ type: "input", data: "Write-Output ('SECOND' + '_' + 'ROUND')\r" }));
const d2 = Date.now() + TIMEOUT_MS;
while (Date.now() < d2 && !out.includes("SECOND_ROUND")) await delay(200);
check("同一会话可继续执行命令", out.includes("SECOND_ROUND"));

/* 目录扫描接口（自研目录浏览器依赖） */
console.log("\n[4] 目录扫描接口");
try {
  const r = await fetch("http://127.0.0.1:3082/list-dir?path=" + encodeURIComponent("C:\\"));
  const d = await r.json();
  check("GET /list-dir 返回 200", r.ok);
  check("返回目录数组", Array.isArray(d.dirs) || Array.isArray(d.entries) || Array.isArray(d), JSON.stringify(d).slice(0, 90));
} catch (e) {
  check("GET /list-dir 可用", false, String(e.message));
}

/* 先关 WS 让桥服务回收 PTY，再自然退出。
   直接 process.exit() 会和 node-pty 的 libuv 句柄收尾竞争，
   触发 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 并给出错误的退出码。 */
ws.close();
await delay(1200);
const code = failed === 0 ? 0 : 1;
console.log(`\n${failed === 0 ? "\u2713 全部通过" : "\u2717 失败 " + failed + " 项"}\n`);
process.exitCode = code;
/* 兜底：万一还有句柄吊住事件循环 */
setTimeout(() => process.exit(code), 3000).unref();
