/* =====================================================================
   dshnano-monitor — 系统监控悬浮窗模块
   CPU / GPU / 内存 / 磁盘读写 / 网络上下行（数据来自 gitlab-bridge 的 /metrics，
   由 metrics-writer.ps1 每 2 秒把 data/metrics.json 原子写入插件仓库）
   改进：页面隐藏时暂停轮询（visibilitychange 恢复时立即刷新）、
        轮询周期与采样周期对齐（2s）。
   ===================================================================== */
"use strict";

import { isVisible, updateConfig } from "./dshnano-core.js";

const POLL_MS = 2000; // 与 metrics-writer.ps1 采样周期一致

/* 指标由 gitlab-bridge 从插件仓库的 data/metrics.json 提供。
   走本地桥服务而不是 DSH 的 /assets 静态路由：DSH 升级覆盖 dist 时监控不再失效。 */
const GITLAB_BRIDGE = "http://127.0.0.1:3081";

let monitorTimer = null;
let monitorWidget = null;

function fmt1(v) {
  return (Math.round(Number(v) * 10) / 10).toFixed(1);
}

function buildWidget() {
  const w = document.createElement("div");
  w.id = "dsh-monitor";
  w.innerHTML =
    '<div class="dsh-mon-head">' +
    '  <span class="dsh-mon-title">系统监控</span>' +
    '  <button type="button" class="dsh-mon-close" data-role="close" title="关闭悬浮窗">×</button>' +
    "</div>" +
    '<div class="dsh-mon-row"><span class="dsh-mon-label">CPU</span><div class="dsh-mon-bar"><i data-role="cpuBar"></i></div><span class="dsh-mon-val" data-role="cpu">--</span></div>' +
    '<div class="dsh-mon-row"><span class="dsh-mon-label">GPU</span><div class="dsh-mon-bar"><i data-role="gpuBar"></i></div><span class="dsh-mon-val" data-role="gpu">--</span></div>' +
    '<div class="dsh-mon-row"><span class="dsh-mon-label">内存</span><div class="dsh-mon-bar"><i data-role="ramBar"></i></div><span class="dsh-mon-val" data-role="ram">--</span></div>' +
    '<div class="dsh-mon-row"><span class="dsh-mon-label">磁盘</span><span class="dsh-mon-val" data-role="disk">--</span></div>' +
    '<div class="dsh-mon-row"><span class="dsh-mon-label">网络</span><span class="dsh-mon-val" data-role="net">--</span></div>';

  w.querySelector('[data-role="close"]').addEventListener("click", () => {
    updateConfig({ monitor: false });
  });

  /* 整个悬浮窗可拖拽 + 记忆位置（关闭按钮除外） */
  let drag = null;
  w.addEventListener("pointerdown", (e) => {
    if (e.target.closest('[data-role="close"]')) return;
    const rect = w.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, l: rect.left, t: rect.top };
    w.classList.add("dsh-mon-dragging");
    w.setPointerCapture(e.pointerId);
  });
  w.addEventListener("pointermove", (e) => {
    if (!drag) return;
    w.style.left = Math.max(0, drag.l + e.clientX - drag.x) + "px";
    w.style.top = Math.max(0, drag.t + e.clientY - drag.y) + "px";
    w.style.right = "auto";
    w.style.bottom = "auto";
  });
  const endDrag = () => {
    if (!drag) return;
    const rect = w.getBoundingClientRect();
    try {
      localStorage.setItem("dsh.monitorPos", JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
    } catch (err) { /* ignore */ }
    w.classList.remove("dsh-mon-dragging");
    drag = null;
  };
  w.addEventListener("pointerup", endDrag);
  w.addEventListener("pointercancel", endDrag);

  try {
    const pos = JSON.parse(localStorage.getItem("dsh.monitorPos") || "null");
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      w.style.left = pos.x + "px";
      w.style.top = pos.y + "px";
      w.style.right = "auto";
      w.style.bottom = "auto";
    }
  } catch (err) { /* ignore */ }

  return w;
}

function render(data) {
  const w = monitorWidget;
  if (!w) return;
  const q = (r) => w.querySelector(r);
  const setBar = (el, val) => {
    const v = Math.max(0, Math.min(100, Number(val) || 0));
    el.style.width = v + "%";
  };
  const cpu = Number(data.cpu);
  const gpu = Number(data.gpu);
  const ram = data.ram || {};
  const disk = data.disk || {};
  const net = data.net || {};

  q('[data-role="cpu"]').textContent = Number.isFinite(cpu) ? Math.round(cpu) + "%" : "--";
  setBar(q('[data-role="cpuBar"]'), cpu);

  q('[data-role="gpu"]').textContent = Number.isFinite(gpu) && gpu >= 0 ? Math.round(gpu) + "%" : "N/A";
  setBar(q('[data-role="gpuBar"]'), gpu >= 0 ? gpu : 0);

  const ramUsed = Number(ram.used);
  const ramTotal = Number(ram.total);
  q('[data-role="ram"]').textContent =
    Number.isFinite(ramUsed) ? fmt1(ramUsed) + "/" + fmt1(ramTotal) + " GB" : "--";
  setBar(q('[data-role="ramBar"]'), ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0);

  q('[data-role="disk"]').textContent =
    Number.isFinite(Number(disk.read)) ? "↓" + fmt1(disk.read) + " ↑" + fmt1(disk.write) + " MB/s" : "--";

  q('[data-role="net"]').textContent =
    Number.isFinite(Number(net.down)) ? "↓" + fmt1(net.down) + " ↑" + fmt1(net.up) + " MB/s" : "--";
}

function tick() {
  if (!isVisible()) return; // 页面隐藏时跳过
  fetch(GITLAB_BRIDGE + "/metrics?t=" + Date.now(), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d) render(d);
    })
    .catch(() => {});
}

/** 把悬浮窗钳制回视口内（窗口缩小 / 位置恢复时防止"跑到窗口外"） */
function clampWidget() {
  const w = monitorWidget;
  if (!w || w.style.display === "none") return;
  /* 未拖动过：默认 right/bottom 锚定，随窗口自动跟随，无需处理 */
  if (w.style.left === "" && w.style.right !== "auto") return;
  const rect = w.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const M = 8;
  const maxLeft = Math.max(0, vw - Math.min(rect.width || 220, vw) - M);
  const maxTop = Math.max(0, vh - Math.min(rect.height || 200, vh) - M);
  const l = Math.min(Math.max(rect.left, M), maxLeft);
  const t = Math.min(Math.max(rect.top, M), maxTop);
  if (Math.abs(l - rect.left) > 0.5 || Math.abs(t - rect.top) > 0.5) {
    w.style.left = l + "px";
    w.style.top = t + "px";
    try {
      localStorage.setItem("dsh.monitorPos", JSON.stringify({ x: Math.round(l), y: Math.round(t) }));
    } catch (e) { /* ignore */ }
  }
}

let resizeGuard = null;
function startResizeGuard() {
  if (resizeGuard) return;
  resizeGuard = () => clampWidget();
  window.addEventListener("resize", resizeGuard);
}

/** 供 core.apply 分发调用的模块入口 */
export function ensure(on) {
  if (on) {
    if (!monitorWidget) {
      monitorWidget = buildWidget();
      document.body.appendChild(monitorWidget);
      clampWidget(); // 记忆的位置可能在缩小后的窗口外，拉回可视区
      startResizeGuard();
    }
    monitorWidget.style.display = "";
    if (!monitorTimer) {
      tick();
      monitorTimer = setInterval(tick, POLL_MS);
    }
  } else {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    if (monitorWidget) monitorWidget.style.display = "none";
  }
}

export function apply(cfg) {
  ensure(cfg ? cfg.monitor !== false : true);
}
