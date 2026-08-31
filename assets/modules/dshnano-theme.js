/* =====================================================================
   dshnano-theme — 主题模块
   背景图 / 遮罩色调 / 前景面板透明度 / 对话区毛玻璃
   全部通过 CSS 变量实时生效（刷新后由 index.html 内联脚本提前恢复）
   ===================================================================== */
"use strict";

import { clamp } from "./dshnano-core.js";

/** 把 CSS 变量写回 documentElement（首帧恢复与实时调整共用） */
export function applyCssVars(cfg) {
  const s = document.documentElement.style;
  if (cfg && cfg.image) {
    s.setProperty("--dsh-bg-image", 'url("' + cfg.image + '")');
  } else {
    s.removeProperty("--dsh-bg-image");
  }
  const t = Number(cfg && cfg.transparency);
  const alpha = Number.isFinite(t) ? 1 - clamp(t, 0, 70) / 100 : 0.75;
  s.setProperty("--dsh-panel-alpha", String(clamp(alpha, 0.25, 1)));

  const glassOn = cfg ? cfg.glass !== false : true;
  const strength = Number(cfg && cfg.glassStrength);
  const px = Number.isFinite(strength) ? clamp(strength, 0, 40) : 24;
  s.setProperty("--dsh-glass-filter", glassOn ? "blur(" + px + "px) saturate(1.15)" : "none");

  if (cfg && cfg.maskColor) {
    s.setProperty("--dsh-mask-color", cfg.maskColor);
  } else {
    s.removeProperty("--dsh-mask-color");
  }
}

/** 供 core.apply 分发调用的模块入口 */
export function apply(cfg) {
  applyCssVars(cfg);
}
