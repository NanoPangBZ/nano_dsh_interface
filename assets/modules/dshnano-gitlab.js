/* =====================================================================
   dshnano-gitlab — GitLab 任务子窗口模块
   VS Code 风格：标题栏拖动 + 四边吸附（上/下边横向排列）、列表项拖拽排序
   数据来自 dist/assets/gitlab-tasks.json（gitlab-bridge.mjs 每 30s 抓取）
   改进：数据 ts 未变化时跳过重渲染；页面隐藏时暂停轮询。
   ===================================================================== */
"use strict";

import {
  isVisible, escapeHtml, escapeAttr, safeUrl, updateConfig
} from "./dshnano-core.js";

const POLL_MS = 30000; // 与 gitlab-bridge.mjs 抓取周期一致

let gitlabTimer = null;
let gitlabSidebar = null;
let lastSignature = ""; // 上次渲染数据的签名（ts+count+首条 updated），用于跳过无变化渲染

function getOrder() {
  try {
    const arr = JSON.parse(localStorage.getItem("dsh.gitlabOrder") || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function getLayout() {
  try {
    const l = JSON.parse(localStorage.getItem("dsh.gitlabLayout") || "null");
    if (l && (l.mode === "dock" || l.mode === "float")) return l;
  } catch (e) { /* ignore */ }
  return { mode: "dock", side: "right" };
}

function applyLayout(layout) {
  const w = gitlabSidebar;
  if (!w) return;
  w.classList.remove("dsh-gl-dock-left", "dsh-gl-dock-right", "dsh-gl-dock-top", "dsh-gl-dock-bottom", "dsh-gl-float");
  w.style.left = w.style.top = w.style.width = w.style.height = "";
  if (layout.mode === "dock") {
    w.classList.add("dsh-gl-dock-" + layout.side);
  } else {
    w.classList.add("dsh-gl-float");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(0, Math.min(vw - 60, Number(layout.x) || 16));
    const y = Math.max(0, Math.min(vh - 60, Number(layout.y) || 16));
    w.style.left = x + "px";
    w.style.top = y + "px";
  }
}

function buildSidebar() {
  const w = document.createElement("aside");
  w.id = "dsh-gitlab-panel";
  w.innerHTML =
    '<div class="dsh-gitlab-head">' +
    '  <span class="dsh-gitlab-title" data-role="title">GitLab 任务</span>' +
    '  <button type="button" class="dsh-gitlab-close" data-role="close" title="关闭任务面板">×</button>' +
    "</div>" +
    '<div class="dsh-gitlab-body" data-role="body"><div class="dsh-gitlab-empty" data-role="empty">等待数据…</div></div>';

  w.querySelector('[data-role="close"]').addEventListener("click", () => {
    updateConfig({ gitlabTasks: false });
  });

  /* VS Code 风格：标题栏拖动 + 边缘吸附 */
  const head = w.querySelector(".dsh-gitlab-head");
  let panelDrag = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest('[data-role="close"]')) return;
    const rect = w.getBoundingClientRect();
    panelDrag = { x: e.clientX, y: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top };
    w.classList.add("dsh-gitlab-paneldrag");
    applyLayout({ mode: "float", x: rect.left, y: rect.top });
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!panelDrag) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nx = Math.max(0, Math.min(vw - 60, e.clientX - panelDrag.offX));
    const ny = Math.max(0, Math.min(vh - 60, e.clientY - panelDrag.offY));
    w.style.left = nx + "px";
    w.style.top = ny + "px";
  });
  const endPanelDrag = (e) => {
    if (!panelDrag) return;
    panelDrag = null;
    w.classList.remove("dsh-gitlab-paneldrag");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dL = e.clientX;
    const dR = vw - e.clientX;
    const dT = e.clientY;
    const dB = vh - e.clientY;
    const TH = 100; // 吸附阈值
    const min = Math.min(dL, dR, dT, dB);
    let layout;
    if (min <= TH) {
      const side = min === dL ? "left" : min === dR ? "right" : min === dT ? "top" : "bottom";
      layout = { mode: "dock", side };
    } else {
      const rect = w.getBoundingClientRect();
      layout = { mode: "float", x: rect.left, y: rect.top };
    }
    applyLayout(layout);
    try {
      localStorage.setItem("dsh.gitlabLayout", JSON.stringify(layout));
    } catch (err) { /* ignore */ }
  };
  head.addEventListener("pointerup", endPanelDrag);
  head.addEventListener("pointercancel", endPanelDrag);

  /* 列表项拖拽排序（HTML5 DnD，实时重排，松手持久化） */
  const bodyEl = w.querySelector('[data-role="body"]');
  let draggedRef = null;

  bodyEl.addEventListener("dragstart", (e) => {
    const item = e.target.closest(".dsh-gitlab-item");
    if (!item) return;
    draggedRef = item.dataset.ref;
    item.classList.add("dsh-gitlab-dragging");
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", draggedRef);
    } catch (err) { /* ignore */ }
  });

  bodyEl.addEventListener("dragover", (e) => {
    if (!draggedRef) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const over = e.target.closest(".dsh-gitlab-item");
    bodyEl.querySelectorAll(".dsh-gitlab-over").forEach((el) => el.classList.remove("dsh-gitlab-over"));
    if (!over || over.dataset.ref === draggedRef) return;
    const rect = over.getBoundingClientRect();
    /* 吸附上/下边时为横向排列，按 X 轴判断；否则按 Y 轴 */
    const horizontal = w.classList.contains("dsh-gl-dock-top") || w.classList.contains("dsh-gl-dock-bottom");
    const before = horizontal
      ? e.clientX < rect.left + rect.width / 2
      : e.clientY < rect.top + rect.height / 2;
    over.classList.add("dsh-gitlab-over");
    const draggedEl = bodyEl.querySelector(".dsh-gitlab-dragging");
    if (draggedEl) {
      if (before) bodyEl.insertBefore(draggedEl, over);
      else if (over.nextSibling) bodyEl.insertBefore(draggedEl, over.nextSibling);
      else bodyEl.appendChild(draggedEl);
    }
  });

  const finishDrag = () => {
    if (!draggedRef) return;
    draggedRef = null;
    bodyEl.querySelectorAll(".dsh-gitlab-dragging,.dsh-gitlab-over").forEach((el) => {
      el.classList.remove("dsh-gitlab-dragging", "dsh-gitlab-over");
    });
    const refs = [];
    bodyEl.querySelectorAll(".dsh-gitlab-item").forEach((el) => refs.push(el.dataset.ref));
    try {
      localStorage.setItem("dsh.gitlabOrder", JSON.stringify(refs));
    } catch (err) { /* ignore */ }
  };
  bodyEl.addEventListener("dragend", finishDrag);
  bodyEl.addEventListener("drop", (e) => e.preventDefault());

  return w;
}

function render(data) {
  const w = gitlabSidebar;
  if (!w) return;
  const titleEl = w.querySelector('[data-role="title"]');
  const bodyEl = w.querySelector('[data-role="body"]');

  if (!data || data.error) {
    titleEl.textContent = "GitLab 任务";
    bodyEl.innerHTML = '<div class="dsh-gitlab-empty">' + escapeHtml(data && data.error ? "连接失败：" + data.error : "等待数据…") + "</div>";
    return;
  }
  const user = data.user ? " · " + data.user : "";
  titleEl.textContent = "GitLab 任务" + user;
  const issues = Array.isArray(data.issues) ? data.issues : [];
  if (issues.length === 0) {
    bodyEl.innerHTML = '<div class="dsh-gitlab-empty">暂无指派给你的开放 Issue 🎉</div>';
    return;
  }

  /* 按本地保存的顺序排序（未知项按 API 顺序追加） */
  const byRef = new Map(issues.map((it) => [it.ref, it]));
  const saved = getOrder().filter((r) => byRef.has(r));
  const rest = issues.filter((it) => !saved.includes(it.ref));
  const sorted = saved.map((r) => byRef.get(r)).concat(rest);

  const items = sorted.map((it) => {
    const labels = Array.isArray(it.labels) && it.labels.length
      ? '<span class="dsh-gitlab-labels">' + it.labels.map((l) => "<i>" + escapeHtml(l) + "</i>").join("") + "</span>"
      : "";
    const due = it.due ? '<span class="dsh-gitlab-due">截止 ' + escapeHtml(it.due) + "</span>" : "";
    return (
      '<a class="dsh-gitlab-item" draggable="true" data-ref="' + escapeAttr(it.ref || "") + '" href="' + escapeAttr(safeUrl(it.url)) + '" target="_blank" rel="noreferrer">' +
      '<span class="dsh-gitlab-ref">' + escapeHtml(it.ref || "#" + it.iid) + "</span>" +
      '<span class="dsh-gitlab-title2">' + escapeHtml(it.title || "") + "</span>" +
      labels + due +
      "</a>"
    );
  }).join("");
  bodyEl.innerHTML = items + '<div class="dsh-gitlab-more">共 ' + issues.length + " 个，拖动可排序，点击在 GitLab 打开</div>";
}

/** 数据签名：ts + count + 各条 updated，用于判断是否值得重渲染 */
function signature(data) {
  if (!data || data.error) return "err:" + (data && data.error);
  const issues = Array.isArray(data.issues) ? data.issues : [];
  return [data.ts, issues.length, issues.map((i) => i.updated || i.iid).join(",")].join("|");
}

function tick() {
  if (!isVisible()) return; // 页面隐藏时暂停轮询
  fetch("/assets/gitlab-tasks.json?t=" + Date.now(), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      const sig = signature(d);
      if (sig !== lastSignature) {
        lastSignature = sig;
        render(d);
      }
    })
    .catch(() => {});
}

/** 立即拉取一次并渲染（保存配置后调用） */
export function refreshNow() {
  fetch("/assets/gitlab-tasks.json?t=" + Date.now(), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      lastSignature = signature(d);
      render(d);
    })
    .catch(() => {});
}

/** 供 core.apply 分发调用的模块入口 */
export function ensure(on) {
  if (on) {
    if (!gitlabSidebar) {
      gitlabSidebar = buildSidebar();
      document.body.appendChild(gitlabSidebar);
      applyLayout(getLayout());
    }
    gitlabSidebar.style.display = "";
    if (!gitlabTimer) {
      tick();
      gitlabTimer = setInterval(tick, POLL_MS);
    }
  } else {
    if (gitlabTimer) {
      clearInterval(gitlabTimer);
      gitlabTimer = null;
    }
    if (gitlabSidebar) gitlabSidebar.style.display = "none";
  }
}

export function apply(cfg) {
  ensure(cfg ? cfg.gitlabTasks === true : false);
}
