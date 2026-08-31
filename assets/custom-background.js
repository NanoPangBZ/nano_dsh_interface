/* =====================================================================
   custom-background.js — nano_dsh_interface 入口（ES module）
   装配 core/theme/monitor/gitlab/terminal/settings 六个模块：
     1. 注册 apply 分发与配置桥
     2. 注入"主题设置"导航分区（哈希类名无关，结构探测失败时优雅降级）
     3. 防抖 MutationObserver：React 重渲染后恢复面板/终端注入
     4. 启动时应用已保存配置
   ===================================================================== */
"use strict";

import {
  load, save, apply, setConfigBridge,
  refreshStructure, structure, debounce, onVisible,
  registerApplier, findAllBySuffix, closestBySuffix, removeClassTokens
} from "./modules/dshnano-core.js";
import * as Theme from "./modules/dshnano-theme.js";
import * as Monitor from "./modules/dshnano-monitor.js";
import * as Gitlab from "./modules/dshnano-gitlab.js";
import * as Terminal from "./modules/dshnano-terminal.js";
import * as Settings from "./modules/dshnano-settings.js";

/* ---------- 装配：apply 分发 + 配置桥 ---------- */
registerApplier(Theme.apply);
registerApplier(Monitor.apply);
registerApplier(Gitlab.apply);
registerApplier(Terminal.apply);

setConfigBridge((patch) => {
  const next = { ...load(), ...patch };
  save(next);
  apply(next);
});

/* ---------- 设置面板导航注入 ---------- */
let themeActive = false;
let suppress = false;
let themePanelEl = null;
let themeNavCell = null;

function syncSettingsPanel() {
  refreshStructure(["panel", "navList", "navCell", "content", "options"]);
  const panel = structure.panel;
  if (!panel) {
    themeActive = false;
    return;
  }
  const navList = structure.navList;
  const content = structure.content;
  const options = structure.options;
  if (!navList || !content || !options) return;

  /* 左侧导航项（幂等） */
  themeNavCell = navList.querySelector("#dsh-theme-nav");
  if (!themeNavCell) {
    themeNavCell = document.createElement("button");
    themeNavCell.type = "button";
    themeNavCell.id = "dsh-theme-nav";
    themeNavCell.className = "dsh-theme-navcell";
    const label = document.createElement("span");
    label.textContent = "主题设置";
    themeNavCell.appendChild(label);
    suppress = true;
    navList.appendChild(themeNavCell);
    suppress = false;
  }

  /* 右侧内容：主题面板 ↔ React 分区内容 */
  themePanelEl = content.querySelector("#dsh-theme-panel");
  if (themeActive) {
    if (!themePanelEl) {
      themePanelEl = Settings.buildPanel({ refreshGitlab: () => Gitlab.refreshNow() });
      suppress = true;
      content.insertBefore(themePanelEl, options);
      suppress = false;
    }
    themePanelEl.style.display = "";
    options.style.display = "none";
    /* 清除 React 分区的高亮（_active token 是哈希的，按后缀移除），避免两个选中项 */
    findAllBySuffix("navCell", navList).forEach((c) => {
      if (c.id !== "dsh-theme-nav") removeClassTokens(c, "active");
    });
    themeNavCell.classList.add("dshn-nav-active");
  } else {
    if (themePanelEl) {
      suppress = true;
      themePanelEl.remove();
      themePanelEl = null;
      suppress = false;
    }
    options.style.display = "";
    themeNavCell.classList.remove("dshn-nav-active");
  }
}

/* 文档级捕获点击：识别左侧导航点击（React 分区 vs 主题设置）。
   导航项类名是哈希的，用语义后缀 _navCell 匹配，兼容任意哈希。 */
document.addEventListener(
  "click",
  (e) => {
    const cell = closestBySuffix(e.target, "navCell");
    if (!cell) return;
    const active = cell.id === "dsh-theme-nav";
    if (active !== themeActive) {
      themeActive = active;
      syncSettingsPanel();
    }
  },
  true
);

/* 设置弹窗是运行时渲染的：防抖观察 DOM，出现/重渲染时同步。
   防抖避免 React 高频更新（消息流、状态切换）触发大量重扫。 */
const observer = new MutationObserver(
  debounce(() => {
    if (suppress) return;
    /* 每次全量刷新结构缓存（防抖后开销可控），保证设置面板/终端注入点最新 */
    refreshStructure();
    /* 终端开启时，确保面板已注入中心列（React 重渲染可能清掉） */
    if (document.body.classList.contains("dsh-term-open")) Terminal.injectPanel();
    if (!structure.panel) {
      themeActive = false;
      return;
    }
    syncSettingsPanel();
  }, 150)
);
observer.observe(document.body, { childList: true, subtree: true });

/* 页面恢复可见时刷新一次数据（轮询在隐藏时已暂停） */
onVisible(() => {
  Gitlab.refreshNow();
});

/* ---------- 初始应用（恢复已保存的配置） ---------- */
refreshStructure();
apply(load());
