/* 诊断：产物里的 xterm 是否解析成了可用构造函数？
   这是"终端启动不成功"的头号嫌疑：
   assets/vendor/*.js 是 UMD，若被当成 ESM 解析，Terminal 会是 undefined，
   而终端模块遇到 window.Terminal === undefined 会静默 return（面板在、会话不在）。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dom = new JSDOM(
  `<!doctype html><html><head></head><body><div id="root"><div class="pI_x6G_centerCol"></div></div></body></html>`,
  { url: "http://127.0.0.1:3080/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole: new VirtualConsole() }
);
const { window } = dom;
window.fetch = async () => ({ ok: true, json: async () => ({}) });
class FakeWS { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} }
window.WebSocket = FakeWS;
window.localStorage.setItem("dsh.bgConfig", JSON.stringify({ terminal: true }));
let registration = null;
window.__ModuleLoader__ = { load: (r) => { registration = r; } };
vm.runInContext(readFileSync(path.join(root, "lib", "client.js"), "utf8"), dom.getInternalVMContext(), { filename: "lib/client.js" });

for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node",
  "MutationObserver", "localStorage", "getComputedStyle", "requestAnimationFrame",
  "cancelAnimationFrame", "Event", "CustomEvent"]) {
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
}
const React = (await import("react")).default;
const plugin = registration.factory((s) => { if (s === "react") return React; throw new Error("外部模块 " + s); });

const effects = [];
const ctx = {
  effect(fn) { const d = fn(); effects.push(d); return d; },
  slots: { inject: (n, cb) => cb(), register: () => () => {} }
};
plugin.apply(ctx);

console.log("\n=== 产物中的 xterm 解析结果 ===");
console.log("  typeof window.Terminal        :", typeof window.Terminal);
console.log("  typeof window.FitAddon        :", typeof window.FitAddon);
console.log("  window.FitAddon?.FitAddon     :", typeof (window.FitAddon && window.FitAddon.FitAddon));

let ctorOk = false, ctorErr = "";
if (typeof window.Terminal === "function") {
  try { const t = new window.Terminal({ cols: 80, rows: 24 }); ctorOk = !!t; } catch (e) { ctorErr = String(e.message).slice(0, 160); }
}
console.log("  能构造 Terminal 实例          :", ctorOk, ctorErr);

console.log("\n=== 终端会话是否真的被创建 ===");
const body = window.document.body;
console.log("  body.dsh-term-open            :", body.classList.contains("dsh-term-open"));
const panel = window.document.querySelector(".pI_x6G_centerCol #dsh-terminal");
console.log("  centerCol 内有 #dsh-terminal  :", !!panel);
if (panel) {
  const panes = panel.querySelectorAll(".dsh-term-pane").length;
  const xtermHost = panel.querySelectorAll(".dsh-term-xterm").length;
  console.log("  终端分栏数 .dsh-term-pane     :", panes);
  console.log("  分栏内 xterm 容器数           :", xtermHost);
  console.log("  状态栏文本                    :", (panel.querySelector('[data-role="termStatus"]') || {}).textContent);
}
console.log("\n=== 结论 ===");
if (typeof window.Terminal !== "function") console.log("  ✗ xterm 未解析成构造函数 —— 终端必然起不来（根因）");
else if (!ctorOk) console.log("  ✗ Terminal 是函数但构造失败 —— 见上方错误");
else if (!panel) console.log("  ✗ 终端面板未注入 centerCol —— 结构探测未命中");
else if (panel.querySelectorAll(".dsh-term-pane").length === 0) console.log("  ✗ 面板在但没有会话 —— createTermSession 提前返回");
else console.log("  ✓ xterm 与面板均正常，问题更可能在浏览器侧（DOM 结构/WS/桥）");

/* 终端模块会挂重连定时器，会吊住事件循环；诊断脚本拿完结论就退出。 */
process.exit(0);
