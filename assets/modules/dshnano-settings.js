/* =====================================================================
   dshnano-settings — 主题设置面板 UI 模块
   注入"主题设置"分区到 DSH 设置弹窗左侧导航，包含：
     背景图 / 遮罩调色板 / 透明度 / 毛玻璃 / 功能开关（监控、GitLab、终端）
     GitLab 在线配置（URL + 令牌，经本地桥 127.0.0.1:3081）
     设为默认背景（把当前背景拷贝为默认 background.jpg）
     后台服务健康状态
   ===================================================================== */
"use strict";

import {
  load, save, apply, MASK_DEFAULT, MASK_PRESETS, MAX_DATA_URL,
  escapeHtml, escapeAttr
} from "./dshnano-core.js";

const GITLAB_BRIDGE = "http://127.0.0.1:3081";
const TERMINAL_BRIDGE = "http://127.0.0.1:3082";

export function buildPanel(ctx) {
  const cfg = load();
  const panel = document.createElement("section");
  panel.id = "dsh-theme-panel";
  const pct = Number(cfg.transparency) || 0;
  const name = cfg.name || (cfg.image ? "自定义图片" : "默认图片");
  const glassOn = cfg.glass !== false;
  const strength = Number(cfg.glassStrength) || 24;
  const mask = cfg.maskColor || MASK_DEFAULT;
  const monitorOn = cfg.monitor !== false;
  const gitlabOn = cfg.gitlabTasks === true;
  const termOn = cfg.terminal !== false;

  const swatchesHtml = MASK_PRESETS.map((c) =>
    '<button type="button" class="dsh-bg-swatch' + (mask.toLowerCase() === c ? " dsh-bg-active" : "") +
    '" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>'
  ).join("");

  panel.innerHTML =
    '<div class="dsh-bg-title">主题设置</div>' +
    '<div class="dsh-bg-subtitle">自定义背景图片、前景遮罩色调、面板透明度与对话区毛玻璃效果，修改即时生效。</div>' +
    '<div class="dsh-bg-preview" data-role="preview"></div>' +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">背景图片</span>' +
    '  <span class="dsh-bg-value" data-role="name">' + escapeHtml(name) + "</span>" +
    '  <button type="button" class="dsh-bg-btn" data-action="pick">选择图片</button>' +
    '  <button type="button" class="dsh-bg-btn" data-action="reset"' + (cfg.image ? "" : " disabled") + ">恢复默认</button>" +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label"></span>' +
    '  <span class="dsh-bg-value" data-role="defBgStatus" style="color:var(--dsw-alias-label-tertiary);font-size:12px">当前默认：background.jpg</span>' +
    '  <button type="button" class="dsh-bg-btn" data-action="setDefault"' + (cfg.image ? "" : " disabled") + " title=\"把当前背景拷贝为插件默认背景 background.jpg\">设为默认背景</button>" +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">遮罩颜色</span>' +
    '  <span class="dsh-bg-swatches" data-role="swatches">' + swatchesHtml +
    '    <label class="dsh-bg-custom" title="自定义颜色">' +
    '      <input type="color" data-role="color" value="' + mask + '" />' +
    "    </label>" +
    "  </span>" +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">前景透明度</span>' +
    '  <input type="range" min="0" max="70" step="1" value="' + pct + '" data-role="slider" />' +
    '  <span class="dsh-bg-value dsh-bg-pct" data-role="pct">' + pct + "%</span>" +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">毛玻璃特效</span>' +
    '  <label class="dsh-bg-switch">' +
    '    <input type="checkbox" data-role="glass"' + (glassOn ? " checked" : "") + " />" +
    '    <span class="dsh-bg-track"></span>' +
    "  </label>" +
    '  <span class="dsh-bg-value" data-role="glassState">' + (glassOn ? "开启" : "关闭") + "</span>" +
    "</div>" +
    '<div class="dsh-bg-row" data-role="glassRow"' + (glassOn ? "" : ' style="opacity:.45"') + ">" +
    '  <span class="dsh-bg-label">模糊强度</span>' +
    '  <input type="range" min="0" max="40" step="1" value="' + strength + '" data-role="glassStrength"' + (glassOn ? "" : " disabled") + " />" +
    '  <span class="dsh-bg-value dsh-bg-pct" data-role="glassPct">' + strength + "px</span>" +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">系统监控</span>' +
    '  <label class="dsh-bg-switch">' +
    '    <input type="checkbox" data-role="monitor"' + (monitorOn ? " checked" : "") + " />" +
    '    <span class="dsh-bg-track"></span>' +
    "  </label>" +
    '  <span class="dsh-bg-value" data-role="monitorState">' + (monitorOn ? "开启" : "关闭") + "</span>" +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">GitLab 任务</span>' +
    '  <label class="dsh-bg-switch">' +
    '    <input type="checkbox" data-role="gitlab"' + (gitlabOn ? " checked" : "") + " />" +
    '    <span class="dsh-bg-track"></span>' +
    "  </label>" +
    '  <span class="dsh-bg-value" data-role="gitlabState">' + (gitlabOn ? "开启" : "关闭") + "</span>" +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">PowerShell 终端</span>' +
    '  <label class="dsh-bg-switch">' +
    '    <input type="checkbox" data-role="terminal"' + (termOn ? " checked" : "") + " />" +
    '    <span class="dsh-bg-track"></span>' +
    "  </label>" +
    '  <span class="dsh-bg-value" data-role="terminalState">' + (termOn ? "开启" : "关闭") + "</span>" +
    "</div>" +
    '<div class="dsh-bg-sep"></div>' +
    '<div class="dsh-bg-title">GitLab 配置</div>' +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">地址</span>' +
    '  <input type="text" data-role="glUrl" placeholder="http://192.168.1.12/" />' +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <span class="dsh-bg-label">令牌</span>' +
    '  <input type="password" data-role="glToken" placeholder="粘贴 Personal Access Token" />' +
    "</div>" +
    '<div class="dsh-bg-row">' +
    '  <button type="button" class="dsh-bg-btn" data-role="glSave">保存并连接</button>' +
    '  <button type="button" class="dsh-bg-btn" data-role="glTest">测试连接</button>' +
    "</div>" +
    '<div class="dsh-bg-status" data-role="glStatus">加载中…</div>' +
    '<div class="dsh-bg-sep"></div>' +
    '<div class="dsh-bg-title">后台服务状态</div>' +
    '<div class="dsh-bg-status" data-role="svcStatus">检测中…</div>' +
    '<div class="dsh-bg-hint">背景图上限约 3MB；遮罩颜色覆盖在背景图上，可整体改变界面色调。透明度越高，背景图越明显。毛玻璃作用于对话区与输入区。系统监控悬浮窗显示 CPU/GPU/内存/磁盘/网络，可拖动。GitLab 任务为可拖动子窗口，拖到四边自动吸附，吸附上/下边时任务横向排列；地址与令牌保存到本机（令牌经 DPAPI 加密）。"设为默认背景"把当前背景保存为插件默认图 background.jpg。配置保存在本机浏览器（localStorage）。</div>' +
    '<input type="file" accept="image/*" hidden data-role="file" />';

  const fileInput = panel.querySelector('[data-role="file"]');
  const nameEl = panel.querySelector('[data-role="name"]');
  const resetBtn = panel.querySelector('[data-action="reset"]');
  const setDefaultBtn = panel.querySelector('[data-action="setDefault"]');
  const defBgStatus = panel.querySelector('[data-role="defBgStatus"]');

  panel.querySelector('[data-action="pick"]').addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      if (url.length > MAX_DATA_URL) {
        nameEl.textContent = "图片过大（源文件约 >3MB），未应用";
        return;
      }
      const next = { ...load(), image: url, name: file.name };
      save(next);
      apply(next);
      nameEl.textContent = file.name;
      resetBtn.disabled = false;
      setDefaultBtn.disabled = false;
    };
    reader.onerror = () => {
      nameEl.textContent = "读取失败，请重试";
    };
    reader.readAsDataURL(file);
  });

  resetBtn.addEventListener("click", () => {
    const next = { ...load(), image: undefined, name: undefined };
    save(next);
    apply(next);
    nameEl.textContent = "默认图片";
    resetBtn.disabled = true;
    setDefaultBtn.disabled = true;
  });

  /* 设为默认背景：把当前背景（dataURL）POST 给 gitlab-bridge 写盘 */
  setDefaultBtn.addEventListener("click", () => {
    const cur = load();
    if (!cur.image) {
      defBgStatus.textContent = "当前使用的就是默认背景";
      return;
    }
    defBgStatus.textContent = "保存中…";
    fetch(GITLAB_BRIDGE + "/background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: cur.image })
    })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok) {
          /* 保存成功后：切换回默认背景引用（background.jpg 已被替换） */
          const next = { ...load(), image: undefined, name: undefined };
          save(next);
          apply(next);
          nameEl.textContent = "默认图片";
          resetBtn.disabled = true;
          setDefaultBtn.disabled = true;
          defBgStatus.textContent = "✓ 已保存为默认背景（background.jpg）";
        } else {
          defBgStatus.textContent = "✗ " + ((d && d.error) || "保存失败");
        }
      })
      .catch(() => {
        defBgStatus.textContent = "✗ 桥接服务未运行（127.0.0.1:3081）";
      });
  });

  /* 遮罩调色板 */
  const swatchesEl = panel.querySelector('[data-role="swatches"]');
  const colorInput = panel.querySelector('[data-role="color"]');

  function syncSwatches(color) {
    swatchesEl.querySelectorAll(".dsh-bg-swatch").forEach((s) => {
      s.classList.toggle("dsh-bg-active", s.dataset.color.toLowerCase() === color.toLowerCase());
    });
  }

  swatchesEl.addEventListener("click", (e) => {
    const swatch = e.target.closest(".dsh-bg-swatch");
    if (!swatch) return;
    const color = swatch.dataset.color;
    const next = { ...load(), maskColor: color };
    save(next);
    apply(next);
    colorInput.value = color;
    syncSwatches(color);
  });

  colorInput.addEventListener("input", () => {
    const color = colorInput.value;
    const next = { ...load(), maskColor: color };
    save(next);
    apply(next);
    syncSwatches(color);
  });

  const slider = panel.querySelector('[data-role="slider"]');
  const pctEl = panel.querySelector('[data-role="pct"]');
  slider.addEventListener("input", () => {
    const next = { ...load(), transparency: Number(slider.value) };
    save(next);
    apply(next);
    pctEl.textContent = slider.value + "%";
  });

  const glassInput = panel.querySelector('[data-role="glass"]');
  const glassState = panel.querySelector('[data-role="glassState"]');
  const glassRow = panel.querySelector('[data-role="glassRow"]');
  const glassSlider = panel.querySelector('[data-role="glassStrength"]');
  const glassPct = panel.querySelector('[data-role="glassPct"]');

  function syncGlassRow() {
    const on = glassInput.checked;
    glassState.textContent = on ? "开启" : "关闭";
    glassRow.style.opacity = on ? "" : ".45";
    glassSlider.disabled = !on;
  }

  glassInput.addEventListener("change", () => {
    syncGlassRow();
    const next = { ...load(), glass: glassInput.checked };
    save(next);
    apply(next);
  });

  glassSlider.addEventListener("input", () => {
    const next = { ...load(), glassStrength: Number(glassSlider.value) };
    save(next);
    apply(next);
    glassPct.textContent = glassSlider.value + "px";
  });

  const monitorInput = panel.querySelector('[data-role="monitor"]');
  const monitorState = panel.querySelector('[data-role="monitorState"]');
  monitorInput.addEventListener("change", () => {
    monitorState.textContent = monitorInput.checked ? "开启" : "关闭";
    const next = { ...load(), monitor: monitorInput.checked };
    save(next);
    apply(next);
  });

  const gitlabInput = panel.querySelector('[data-role="gitlab"]');
  const gitlabState = panel.querySelector('[data-role="gitlabState"]');
  gitlabInput.addEventListener("change", () => {
    gitlabState.textContent = gitlabInput.checked ? "开启" : "关闭";
    const next = { ...load(), gitlabTasks: gitlabInput.checked };
    save(next);
    apply(next);
  });

  const termInput = panel.querySelector('[data-role="terminal"]');
  const termState = panel.querySelector('[data-role="terminalState"]');
  termInput.addEventListener("change", () => {
    termState.textContent = termInput.checked ? "开启" : "关闭";
    const next = { ...load(), terminal: termInput.checked };
    save(next);
    apply(next);
  });

  /* GitLab 配置（URL + 令牌，经本地桥接 3081；令牌在服务端 DPAPI 加密存储） */
  const glUrl = panel.querySelector('[data-role="glUrl"]');
  const glToken = panel.querySelector('[data-role="glToken"]');
  const glStatus = panel.querySelector('[data-role="glStatus"]');
  const glSaveBtn = panel.querySelector('[data-role="glSave"]');
  const glTestBtn = panel.querySelector('[data-role="glTest"]');

  function setGlStatus(text, ok) {
    glStatus.textContent = text;
    glStatus.style.color = ok === true ? "var(--dsw-alias-state-success-primary)" : ok === false ? "var(--dsw-alias-state-error-primary)" : "";
  }

  function glPost(path, payload) {
    return fetch(GITLAB_BRIDGE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((r) => r.json());
  }

  fetch(GITLAB_BRIDGE + "/config", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      glUrl.value = d.url || "";
      glToken.placeholder = d.tokenConfigured ? "已配置（加密存储），留空保持不变" : "粘贴 Personal Access Token";
      setGlStatus(d.user ? "已连接：" + d.user : "未连接（请在下方填写配置）", d.user ? true : false);
    })
    .catch(() => setGlStatus("桥接服务未运行（127.0.0.1:3081），无法在线配置", false));

  glTestBtn.addEventListener("click", () => {
    setGlStatus("测试中…");
    glPost("/test", { url: glUrl.value.trim(), token: glToken.value.trim() })
      .then((d) => setGlStatus(d.ok ? "✓ 连接成功：" + d.user : "✗ " + (d.error || "连接失败"), d.ok))
      .catch(() => setGlStatus("✗ 桥接服务未运行", false));
  });

  glSaveBtn.addEventListener("click", () => {
    setGlStatus("保存中…");
    glPost("/config", { url: glUrl.value.trim(), token: glToken.value.trim() })
      .then((d) => {
        if (d.ok) {
          setGlStatus("✓ 已保存并连接：" + d.user, true);
          glToken.value = "";
          glToken.placeholder = "已配置（加密存储），留空保持不变";
          gitlabInput.checked = true;
          gitlabState.textContent = "开启";
          const next = { ...load(), gitlabTasks: true };
          save(next);
          apply(next);
          if (ctx && ctx.refreshGitlab) ctx.refreshGitlab();
        } else {
          setGlStatus("✗ " + (d.error || "保存失败"), false);
        }
      })
      .catch(() => setGlStatus("✗ 桥接服务未运行", false));
  });

  /* 后台服务健康状态 */
  const svcStatus = panel.querySelector('[data-role="svcStatus"]');
  Promise.all([
    fetch(GITLAB_BRIDGE + "/health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(TERMINAL_BRIDGE + "/health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  ]).then(([gl, tb]) => {
    const parts = [];
    parts.push(gl ? "✓ gitlab-bridge（任务抓取）" : "✗ gitlab-bridge 未运行");
    parts.push(tb ? "✓ terminal-bridge（终端）" : "✗ terminal-bridge 未运行");
    svcStatus.textContent = parts.join("　");
    svcStatus.style.color = gl && tb ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)";
  });

  return panel;
}
