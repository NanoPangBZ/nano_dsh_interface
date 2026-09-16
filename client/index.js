/* =====================================================================
   nano-dsh-interface — 浏览器半边（客户端插件入口）
   =====================================================================
   与旧版（补丁 DSH dist/index.html + 全局 <script>）的区别：
     · 由 DSH 模块系统经 /plugins/<id>/client.js 加载，DSH 升级不再被清空
     · "主题设置"改为注册官方 settings.section 插槽，不再靠探测类名注入设置导航
     · 样式经 ctx.effect 注入并登记 dataset.pluginCss，HMR 可回收
   仍保留的能力：
     · 主题（背景/遮罩/透明度/毛玻璃）需要给 DSH 内部布局打标，故保留结构探测
     · 系统监控悬浮窗、GitLab 任务子窗口、PowerShell 终端（数据来自本地桥服务）
   ===================================================================== */
"use strict";

import React from "react";

import {
  load, save, apply as applyConfig, setConfigBridge,
  refreshStructure, debounce, registerApplier
} from "../assets/modules/dshnano-core.js";
import * as Theme from "../assets/modules/dshnano-theme.js";
import * as Monitor from "../assets/modules/dshnano-monitor.js";
import * as Gitlab from "../assets/modules/dshnano-gitlab.js";
import * as Terminal from "../assets/modules/dshnano-terminal.js";
import * as Settings from "../assets/modules/dshnano-settings.js";

/* 终端模拟器从 vendor 直接打进本插件包，不再依赖 index.html 里的 <script> 标签。
   两者都是 UMD 产物（见 assets/vendor/package.json 的 type:commonjs 声明），
   命名导出无法被静态分析，故用命名空间导入在运行时取。 */
import * as xtermModule from "../assets/vendor/xterm.js";
import * as fitModule from "../assets/vendor/xterm-addon-fit.js";

const XTerminal = xtermModule.Terminal || (xtermModule.default && xtermModule.default.Terminal);
const FitAddon = fitModule.FitAddon || (fitModule.default && fitModule.default.FitAddon);

import xtermCss from "../assets/vendor/xterm.css";
import pluginCss from "../assets/custom-background.css";

export const PLUGIN_ID = "nano-dsh-interface";

/** 本插件需要的客户端服务：slots 用于注册设置分区。 */
export const inject = ["slots"];

/* ---------- 样式注入（沿用官方范式，便于 HMR 回收） ---------- */
const STYLES = [
  ["xterm", xtermCss],
  ["plugin", pluginCss]
];

function installStyles(ctx) {
  if (typeof document === "undefined") return;
  for (const [name, css] of STYLES) {
    ctx.effect(() => {
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => { tag.remove(); };
    }, `${PLUGIN_ID}: ${name} stylesheet`);
  }
}

/* ---------- "主题设置"分区：官方 settings.section 插槽 ----------
   面板本体是既有的纯 DOM 构件（Settings.buildPanel），这里用 ref 回调把它
   挂进插槽渲染出的容器，避免为了一个面板把整套 UI 改写成 React。 */
function ThemeSettingsSection() {
  const mount = React.useCallback((el) => {
    if (!el || el.dataset.nanoMounted === "1") return;
    el.dataset.nanoMounted = "1";
    el.appendChild(Settings.buildPanel({ refreshGitlab: () => Gitlab.refreshNow() }));
  }, []);
  return React.createElement("div", { className: "nano-settings-host", ref: mount });
}

/* ---------- 插件体 ---------- */
export function apply(ctx) {
  installStyles(ctx);

  /* 既有终端模块按 window.Terminal / window.FitAddon 取用，这里还原同样的全局，
     使 dshnano-terminal.js 无需改动。 */
  window.Terminal = XTerminal;
  window.FitAddon = { FitAddon };

  registerApplier(Theme.apply);
  registerApplier(Monitor.apply);
  registerApplier(Gitlab.apply);
  registerApplier(Terminal.apply);

  setConfigBridge((patch) => {
    const next = { ...load(), ...patch };
    save(next);
    applyConfig(next);
  });

  /* 运行时：应用配置 + 观察 DOM 变化（React 重渲染会清掉终端面板，
     也要求重新探测布局结构）。清理逻辑交给 ctx.effect，插件卸载时不留残骸。 */
  ctx.effect(() => {
    refreshStructure();
    applyConfig(load());

    const observer = new MutationObserver(debounce(() => {
      refreshStructure();
      if (document.body.classList.contains("dsh-term-open")) Terminal.injectPanel();
    }, 150));
    observer.observe(document.body, { childList: true, subtree: true });

    const onVisibility = () => { if (!document.hidden) Gitlab.refreshNow(); };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      Monitor.ensure(false);
      Gitlab.ensure(false);
      Terminal.ensure(false);
    };
  }, `${PLUGIN_ID}: runtime`);

  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: PLUGIN_ID,
    order: 100,
    label: "主题设置"
  }, ThemeSettingsSection));
}
