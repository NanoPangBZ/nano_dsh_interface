/* =====================================================================
   dshnano-core — nano_dsh_interface 核心模块
   职责：
     1. 配置读写（localStorage，键 dsh.bgConfig，兼容旧版）
     2. apply 分发：把配置一次性应用到 theme/monitor/gitlab/terminal 四个模块
     3. DSH 内部结构探测：布局/设置面板由 DSH 的客户端插件包渲染，其 CSS-module
        类名形如 <hash>_<语义名>（pI_x6G_centerCol、VOzbGW_panel…）。
        探测顺序为"精确选择器优先，语义后缀兜底"：
          · 精确选择器命中当前已知构建，避免通用后缀误命中别的组件
            （例如 _panel/_content/_root 在 DSH 里各有若干个同后缀类名）；
          · 精确选择器全部失配时（DSH 换了哈希）再按后缀扫描，仍能自适应；
          · 两者都失败则优雅降级：该元素留空，相关样式不生效，其余功能不受影响。
     4. 通用工具：HTML 转义、URL 白名单、防抖、页面可见性辅助
   ===================================================================== */
"use strict";

export const KEY = "dsh.bgConfig";
export const MAX_DATA_URL = 4200000; // 背景图 dataURL 上限（约 3MB 源文件）
export const MASK_DEFAULT = "#0c0f14";

export const DEFAULTS = {
  transparency: 25,      // 0~70 前景透明度
  glass: true,           // 毛玻璃开关
  glassStrength: 24,     // 0~40px
  monitor: true,         // 系统监控悬浮窗
  gitlabTasks: false,    // GitLab 任务子窗口
  terminal: true         // PowerShell 终端
};

export const MASK_PRESETS = [
  "#0c0f14", // 深灰蓝（默认）
  "#000000", // 纯黑
  "#0a1128", // 深蓝
  "#131a2e", // 蓝灰
  "#1a0f2e", // 深紫
  "#0f1f16", // 墨绿
  "#2a0f14", // 酒红
  "#2b1a10", // 棕褐
  "#1c1e22", // 石墨
  "#3a3f47"  // 钢灰
];

/* ---------- 配置读写 ---------- */
export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

export function save(cfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch (e) {
    console.warn("[dshnano] 配置保存失败", e);
  }
}

/* ---------- 输出安全 ---------- */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 属性上下文转义（含单引号），用于 href/data-ref 等 */
export function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/** URL 白名单：仅允许 http/https，其余返回 "#"（防 javascript: 注入） */
export function safeUrl(value) {
  const v = String(value || "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  return "#";
}

/* =====================================================================
   DSH 结构探测
   语义后缀：centerCol / frame / detailsCol / sidebarCol / root / card /
            composerSeat / panel / navList / navCell / content / options
   ===================================================================== */
const LEGACY_SELECTORS = {
  centerCol: ".pI_x6G_centerCol",
  frame: ".pI_x6G_frame",
  /* DSH 0.1.5 起右侧栏由 detailsCol 更名为 rightbarCol；两个都试，兼容新旧构建。 */
  detailsCol: ".pI_x6G_rightbarCol, .pI_x6G_detailsCol",
  sidebarCol: ".pI_x6G_sidebarCol",
  root: ".wSkVaW_root",
  card: ".uV2eYG_card",
  composerSeat: ".wSkVaW_composerSeat",
  panel: ".VOzbGW_panel",
  navList: ".VOzbGW_navList",
  navCell: ".VOzbGW_navCell",
  content: ".VOzbGW_content",
  options: ".VOzbGW_options"
};

const SUFFIXES = Object.keys(LEGACY_SELECTORS);

/** 查找所有 class 中形如 <hash>_<suffix> 的元素（哈希前缀本身可含下划线） */
export function findAllBySuffix(suffix, scope = document) {
  const re = new RegExp("(?:^|\\s)[A-Za-z0-9_]{4,}_(?:" + suffix + ")(?:$|\\s)");
  const out = [];
  const all = scope.querySelectorAll("[class]");
  for (const el of all) {
    const cls = el.getAttribute && el.getAttribute("class");
    if (cls && re.test(cls)) out.push(el);
  }
  return out;
}

/** 查找单个：class 中形如 <hash>_<suffix> 的 token */
function findBySuffix(suffix) {
  return findAllBySuffix(suffix)[0] || null;
}

/** 从 el 向上查找第一个 class 含 <hash>_<suffix> 的祖先（含自身），兼容任意哈希 */
export function closestBySuffix(el, suffix) {
  const re = new RegExp("(?:^|\\s)[A-Za-z0-9_]{4,}_(?:" + suffix + ")(?:$|\\s)");
  while (el && el.nodeType === 1) {
    if (el.id === "dsh-theme-nav") return el;
    const cls = el.getAttribute && el.getAttribute("class");
    if (cls && re.test(cls)) return el;
    el = el.parentElement;
  }
  return null;
}

/** 结构缓存：settings 面板相关 + 布局相关，随 observer 刷新 */
export const structure = {
  panel: null, navList: null, navCell: null, content: null, options: null,
  centerCol: null, frame: null, detailsCol: null, sidebarCol: null,
  root: null, card: null, composerSeat: null,
  /** 探测是否成功（决定设置面板注入是否可用） */
  settingsOk: false
};

/** 刷新结构缓存。suffix 数组限定本次需要刷新的项。
    找到的布局元素会打上稳定标记类 dshn-<suffix>，供 CSS 使用（哈希无关）。 */
export function refreshStructure(suffixes = SUFFIXES) {
  let changed = false;
  for (const s of suffixes) {
    const el = document.querySelector(LEGACY_SELECTORS[s] || "") || findBySuffix(s);
    if (structure[s] !== el) { structure[s] = el; changed = true; }
    if (el && el.classList) el.classList.add("dshn-" + s); // 幂等打标
  }
  structure.settingsOk = !!(structure.panel && structure.navList && structure.content && structure.options);
  return changed;
}

/** 从 className 中移除形如 <hash>_<suffix> 的 token（用于清除 React 的 _active 高亮） */
export function removeClassTokens(el, suffix) {
  if (!el || !el.classList) return;
  const re = new RegExp("(?:^|\\s)[A-Za-z0-9_]{4,}_(?:" + suffix + ")(?=$|\\s)", "g");
  const cls = el.getAttribute("class");
  if (!cls) return;
  const next = cls.replace(re, "").replace(/\s{2,}/g, " ").trim();
  if (next !== cls) el.setAttribute("class", next);
}

/* ---------- 通用工具 ---------- */
/** 防抖：fn 在 wait ms 内只执行最后一次 */
export function debounce(fn, wait = 150) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, wait);
  };
}

/** 页面可见性：返回当前是否可见；onShow 在恢复可见时触发（用于立即刷新数据） */
export function isVisible() {
  return !document.hidden;
}

export function onVisible(cb) {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) cb();
  });
}

/* ---------- apply 分发 ----------
   由入口模块注入各功能模块的 apply 实现，避免循环依赖 */
let featureAppliers = [];
export function registerApplier(fn) {
  featureAppliers.push(fn);
}
export function apply(cfg) {
  for (const fn of featureAppliers) {
    try { fn(cfg); } catch (e) { console.warn("[dshnano] apply 子模块异常", e); }
  }
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/* ---------- 配置快捷更新桥 ----------
   由入口注入 load+save+apply 的实现，供各模块"关闭/切换"时使用：
   updateConfig({ monitor: false }) == load -> 合并 -> save -> apply */
let configBridge = null;
export function setConfigBridge(fn) {
  configBridge = fn;
}
export function updateConfig(patch) {
  if (configBridge) configBridge(patch);
  else console.warn("[dshnano] updateConfig: 配置桥尚未注入");
}
