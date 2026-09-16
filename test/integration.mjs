/* =====================================================================
   test/integration.mjs — 用 jsdom 加载**真实构建产物** lib/client.js，
   模拟 DSH 宿主的 __ModuleLoader__ / cordis ctx，验证四项功能都被挂载。

   这不是单元测试：它执行的就是宿主会送到浏览器的那个文件，
   所以能证明「注册格式 + apply 装配 + 结构探测 + 插槽注册」整条链路。

   运行：node test/integration.mjs
   ===================================================================== */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundlePath = path.join(root, "lib", "client.js");

let failed = 0;
function check(name, cond, extra = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "\u2713" : "\u2717"} ${name}${extra ? "  \u2014 " + extra : ""}`);
}

/* ---------- 1) 搭一个最小 DSH 宿主 DOM ----------
   三个列用 DSH 0.1.5-rc.1 的**真实类名**，用来检验结构探测。 */
const virtualConsole = new VirtualConsole();
const caught = [];
virtualConsole.on("jsdomError", (e) => caught.push(e.message));
virtualConsole.on("error", (...a) => caught.push(a.join(" ")));

const dom = new JSDOM(
  `<!doctype html><html><head></head><body>
     <div id="root">
       <div class="pI_x6G_frame">
         <div class="pI_x6G_sidebarCol"></div>
         <div class="pI_x6G_centerCol"></div>
         <div class="pI_x6G_rightbarCol"></div>
       </div>
     </div>
   </body></html>`,
  { url: "http://127.0.0.1:3080/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole }
);
const { window } = dom;

/* ---------- 2) 打桩：宿主全局 ---------- */
const METRICS = {
  ts: 1789027000, cpu: 12.5, gpu: 3.1,
  ram: { used: 15.2, total: 31.8 },
  disk: { read: 1.5, write: 0.25, total: 476, free: 174 },
  net: { down: 0.4, up: 0.1 }
};
const TASKS = {
  ts: 1789027000, count: 2,
  issues: [
    { iid: 7, title: "修复终端重连", web_url: "http://gitlab.local/issues/7", ref: "proj#7", updated: "2026-09-10", labels: ["bug"], due: null },
    { iid: 9, title: "补监控 GPU 指标", web_url: "http://gitlab.local/issues/9", ref: "proj#9", updated: "2026-09-09", labels: [], due: null }
  ]
};
const fetched = [];
window.fetch = async (url) => {
  fetched.push(String(url));
  const body = String(url).includes("/tasks") ? TASKS : METRICS;
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

/* WebSocket 桩：终端连不上真实桥，保持 CONNECTING 即可 */
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor() { this.readyState = 0; }
  addEventListener() {} removeEventListener() {} send() {} close() {}
}
window.WebSocket = FakeWebSocket;

/* 先把配置写进 localStorage：默认开监控 + 开 GitLab 任务（默认是关的） */
window.localStorage.setItem("dsh.bgConfig", JSON.stringify({ monitor: true, gitlabTasks: true, terminal: true }));

/* 抓住产物注册的 factory */
let registration = null;
window.__ModuleLoader__ = { load: (r) => { registration = r; } };

/* ---------- 3) 执行真实产物 ---------- */
console.log("\n[1] 产物格式与注册");
/* 必须用 vm.runInContext 在 jsdom 的 realm 里执行：window.eval 不提供 window 作用域 */
vm.runInContext(readFileSync(bundlePath, "utf8"), dom.getInternalVMContext(), { filename: "lib/client.js" });
check("调用了 window.__ModuleLoader__.load 注册 factory", !!registration);
check("注册 id 等于包名", registration && registration.id === "nano-dsh-interface", registration && registration.id);
check("factory 是函数", registration && typeof registration.factory === "function");

/* ---------- 4) 物化 factory（模拟宿主 require） ---------- */
for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node",
  "MutationObserver", "localStorage", "getComputedStyle", "requestAnimationFrame",
  "cancelAnimationFrame", "Event", "CustomEvent"]) {
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* ignore */ }
}
globalThis.fetch = window.fetch;

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const act = React.act || (await import("react-dom/test-utils")).act;
globalThis.IS_REACT_ACT_ENVIRONMENT = true; // 声明这是测试环境，避免 act 警告

const externals = [];
const plugin = registration.factory((spec) => {
  externals.push(spec);
  if (spec === "react") return React;
  throw new Error("bundle 请求了未经声明的外部模块: " + spec);
});

console.log("\n[2] 插件导出契约");
check("导出 apply", typeof plugin.apply === "function");
check("导出 inject", Array.isArray(plugin.inject));
check("inject 只依赖 slots 服务", JSON.stringify(plugin.inject) === '["slots"]', JSON.stringify(plugin.inject));
check("唯一外部依赖是 react（其余全打进 bundle）", JSON.stringify([...new Set(externals)]) === '["react"]', JSON.stringify([...new Set(externals)]));

/* ---------- 5) 模拟 cordis ctx 并 apply ---------- */
console.log("\n[3] apply(ctx) 装配四项功能");
const effects = [];
const injectedSlots = [];
let slotReg = null;
const ctx = {
  effect(fn, label) { const d = fn(); effects.push({ label, dispose: typeof d === "function" ? d : null }); return d; },
  slots: {
    inject(name, cb) { injectedSlots.push(name); cb(); },
    register(opts, comp) { slotReg = { opts, comp }; return () => {}; }
  }
};
plugin.apply(ctx);

/* 主题设置：注册官方 settings.section 插槽 */
check("向 settings.section 插槽注册", injectedSlots.includes("settings.section"), injectedSlots.join(","));
check("插槽条目 name/id/label 正确",
  slotReg && slotReg.opts.name === "settings.section" && slotReg.opts.id === "nano-dsh-interface" && slotReg.opts.label === "主题设置",
  slotReg ? JSON.stringify({ name: slotReg.opts.name, id: slotReg.opts.id, label: slotReg.opts.label }) : "未注册");

/* 样式注入（客户端插件没有 CSS 通道，靠 <style> + data-plugin 供 HMR 回收） */
const styles = window.document.head.querySelectorAll('style[data-plugin="nano-dsh-interface"]');
check("注入 2 个 style 标签并打了 HMR 归属标记", styles.length === 2, `count=${styles.length}`);
check("style 标签带 data-plugin-css", styles.length === 2 && /nano-dsh-interface\/(xterm|plugin)/.test(styles[0].getAttribute("data-plugin-css")));

/* 主题：CSS 变量写到 documentElement */
const de = window.document.documentElement;
check("主题写入 --dsh-panel-alpha", !!de.style.getPropertyValue("--dsh-panel-alpha"), de.style.getPropertyValue("--dsh-panel-alpha"));
check("主题写入 --dsh-glass-filter", /blur\(/.test(de.style.getPropertyValue("--dsh-glass-filter")), de.style.getPropertyValue("--dsh-glass-filter"));

/* 结构探测：精确选择器命中并打上稳定标记类 */
check("centerCol 被探测并打标", !!window.document.querySelector(".pI_x6G_centerCol.dshn-centerCol"));
check("detailsCol 正确落到新版 rightbarCol", !!window.document.querySelector(".pI_x6G_rightbarCol.dshn-detailsCol"));
check("sidebarCol 被探测并打标", !!window.document.querySelector(".pI_x6G_sidebarCol.dshn-sidebarCol"));

/* 系统监控悬浮窗 */
check("系统监控悬浮窗已挂到 body", !!window.document.getElementById("dsh-monitor"));

/* GitLab 任务子窗口 */
check("GitLab 任务子窗口已挂到 body", !!window.document.getElementById("dsh-gitlab-panel"));

/* PowerShell 终端（注入会话主列） */
check("body 标记 dsh-term-open", window.document.body.classList.contains("dsh-term-open"));
check("终端面板注入到 centerCol", !!window.document.querySelector(".pI_x6G_centerCol #dsh-terminal"));

/* ---------- 6) 渲染插槽组件 → 主题设置面板 ---------- */
console.log("\n[4] 渲染设置分区组件");
const host = window.document.createElement("div");
window.document.body.appendChild(host);
const rootReact = createRoot(host);
await act(async () => { rootReact.render(React.createElement(slotReg.comp)); });
check("渲染出 #dsh-theme-panel", !!window.document.getElementById("dsh-theme-panel"));
check("面板含背景/遮罩/透明度/毛玻璃/开关与 GitLab 配置控件",
  !!window.document.querySelector('#dsh-theme-panel [data-action="setDefault"]') &&
  !!window.document.querySelector('#dsh-theme-panel [data-role="swatches"]') &&
  !!window.document.querySelector('#dsh-theme-panel [data-role="slider"]') &&
  !!window.document.querySelector('#dsh-theme-panel [data-role="glass"]') &&
  !!window.document.querySelector('#dsh-theme-panel [data-role="glUrl"]'));

/* ---------- 7) 数据轮询真的打到了本地桥 ---------- */
console.log("\n[5] 数据来源指向本地桥服务");
await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
const monitorText = (window.document.getElementById("dsh-monitor") || {}).textContent || "";
check("监控数据已渲染（cpu/ram 有值）", /12\.5/.test(monitorText) || /15\.2/.test(monitorText), monitorText.slice(0, 80).replace(/\s+/g, " "));
check("监控请求指向 127.0.0.1:3081/metrics", fetched.some((u) => u.includes("127.0.0.1:3081/metrics")), fetched.find((u) => u.includes("/metrics")) || "无");
check("任务请求指向 127.0.0.1:3081/tasks", fetched.some((u) => u.includes("127.0.0.1:3081/tasks")), fetched.find((u) => u.includes("/tasks")) || "无");
check("没有请求 DSH 的 /assets 静态路由", !fetched.some((u) => u.includes("/assets/")));

/* ---------- 8) 清理：disposer 不留残骸 ---------- */
console.log("\n[6] ctx.effect 清理");
let disposed = 0;
for (const e of effects) { if (e.dispose) { try { e.dispose(); disposed++; } catch { /* ignore */ } } }
check(`执行了 ${disposed} 个 disposer（应 ≥2）`, disposed >= 2, `labels=${effects.map((e) => e.label).join(" | ")}`);

if (caught.length) {
  console.log("\n  \u2139 jsdom 捕获的非致命错误（jsdom 无布局，xterm 构造等预期会报）:");
  for (const c of [...new Set(caught)].slice(0, 4)) console.log("      " + String(c).split("\n")[0].slice(0, 140));
}

console.log(`\n${failed === 0 ? "\u2713 全部通过" : "\u2717 失败 " + failed + " 项"}\n`);
process.exit(failed === 0 ? 0 : 1);
