/* =====================================================================
   DSH 自定义主题 — 设置面板配置脚本
   功能：
     1. 设置面板左侧导航注入"主题设置"分区（非子卡片，独立分区）
     2. 本地选择背景图片（dataURL 存 localStorage，>3MB 拒绝）
     3. 前景透明度滑杆（0~70%，实时生效）
     4. 对话区毛玻璃开关 + 模糊强度滑杆（0~40px，实时生效）
     5. 全部通过 CSS 变量实时响应，刷新后由 index.html 内联脚本恢复
   ===================================================================== */
(() => {
  "use strict";

  const KEY = "dsh.bgConfig";
  const DEFAULT_TRANSPARENCY = 25; // 0~70
  const DEFAULT_GLASS = true; // 毛玻璃开关
  const DEFAULT_GLASS_STRENGTH = 24; // 0~40px
  const DEFAULT_MONITOR = true; // 系统监控悬浮窗
  const DEFAULT_GITLAB_TASKS = false; // GitLab 任务子窗口（需后台抓取器运行）
  const DEFAULT_TERMINAL = true; // PowerShell 终端（需 terminal-bridge 运行）
  const MAX_DATA_URL = 4200000; // 约 3MB 源文件
  const MASK_DEFAULT = "#0c0f14"; // 遮罩默认色调
  const MASK_PRESETS = [
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
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        transparency: DEFAULT_TRANSPARENCY,
        glass: DEFAULT_GLASS,
        glassStrength: DEFAULT_GLASS_STRENGTH,
        monitor: DEFAULT_MONITOR,
        gitlabTasks: DEFAULT_GITLAB_TASKS,
        terminal: DEFAULT_TERMINAL,
        ...parsed
      };
    } catch (e) {
      return {
        transparency: DEFAULT_TRANSPARENCY,
        glass: DEFAULT_GLASS,
        glassStrength: DEFAULT_GLASS_STRENGTH,
        monitor: DEFAULT_MONITOR,
        gitlabTasks: DEFAULT_GITLAB_TASKS,
        terminal: DEFAULT_TERMINAL
      };
    }
  }

  function save(cfg) {
    try {
      localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch (e) {
      console.warn("[dsh-theme] 配置保存失败", e);
    }
  }

  /* ---------- 应用配置（实时） ---------- */
  function apply(cfg) {
    const s = document.documentElement.style;
    if (cfg && cfg.image) {
      s.setProperty("--dsh-bg-image", 'url("' + cfg.image + '")');
    } else {
      s.removeProperty("--dsh-bg-image");
    }
    const t = Number(cfg && cfg.transparency);
    const alpha = Number.isFinite(t) ? 1 - Math.min(70, Math.max(0, t)) / 100 : 0.75;
    s.setProperty("--dsh-panel-alpha", String(Math.max(0.25, Math.min(1, alpha))));

    const glassOn = cfg ? cfg.glass !== false : true;
    const strength = Number(cfg && cfg.glassStrength);
    const px = Number.isFinite(strength) ? Math.min(40, Math.max(0, strength)) : DEFAULT_GLASS_STRENGTH;
    s.setProperty("--dsh-glass-filter", glassOn ? "blur(" + px + "px) saturate(1.15)" : "none");

    /* 遮罩色调（未设置时使用 CSS 默认值） */
    if (cfg && cfg.maskColor) {
      s.setProperty("--dsh-mask-color", cfg.maskColor);
    } else {
      s.removeProperty("--dsh-mask-color");
    }

    /* 系统监控悬浮窗开关 */
    ensureMonitor(cfg ? cfg.monitor !== false : true);

    /* GitLab 任务子窗口开关 */
    ensureGitlabTasks(cfg ? cfg.gitlabTasks === true : false);

    /* PowerShell 终端开关 */
    ensureTerminal(cfg ? cfg.terminal !== false : true);
  }

  /* ==================== 系统监控悬浮窗 ==================== */
  let monitorTimer = null;
  let monitorWidget = null;

  function fmt1(v) {
    return (Math.round(Number(v) * 10) / 10).toFixed(1);
  }

  function buildMonitorWidget() {
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
      const next = { ...load(), monitor: false };
      save(next);
      apply(next);
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

  function renderMonitor(data) {
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

  function ensureMonitor(on) {
    if (on) {
      if (!monitorWidget) {
        monitorWidget = buildMonitorWidget();
        document.body.appendChild(monitorWidget);
      }
      monitorWidget.style.display = "";
      if (!monitorTimer) {
        const tick = () => {
          fetch("/assets/metrics.json?t=" + Date.now(), { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (d) renderMonitor(d);
            })
            .catch(() => {});
        };
        tick();
        monitorTimer = setInterval(tick, 1000);
      }
    } else {
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
      if (monitorWidget) monitorWidget.style.display = "none";
    }
  }

  /* ==================== GitLab 任务侧边栏 ==================== */
  let gitlabTimer = null;
  let gitlabSidebar = null;

  function getGitlabOrder() {
    try {
      const arr = JSON.parse(localStorage.getItem("dsh.gitlabOrder") || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  /* 子窗口布局：float(x,y) 或 dock(left|right|top|bottom) */
  function getGitlabLayout() {
    try {
      const l = JSON.parse(localStorage.getItem("dsh.gitlabLayout") || "null");
      if (l && (l.mode === "dock" || l.mode === "float")) return l;
    } catch (e) { /* ignore */ }
    return { mode: "dock", side: "right" };
  }

  function applyGitlabLayout(layout) {
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

  function buildGitlabSidebar() {
    const w = document.createElement("aside");
    w.id = "dsh-gitlab-panel";
    w.innerHTML =
      '<div class="dsh-gitlab-head">' +
      '  <span class="dsh-gitlab-title" data-role="title">GitLab 任务</span>' +
      '  <button type="button" class="dsh-gitlab-close" data-role="close" title="关闭任务面板">×</button>' +
      "</div>" +
      '<div class="dsh-gitlab-body" data-role="body"><div class="dsh-gitlab-empty" data-role="empty">等待数据…</div></div>';

    w.querySelector('[data-role="close"]').addEventListener("click", () => {
      const next = { ...load(), gitlabTasks: false };
      save(next);
      apply(next);
    });

    /* VS Code 风格：标题栏拖动 + 边缘吸附（拖到四边附近自动吸附） */
    const head = w.querySelector(".dsh-gitlab-head");
    let panelDrag = null;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest('[data-role="close"]')) return;
      const rect = w.getBoundingClientRect();
      panelDrag = { x: e.clientX, y: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top };
      w.classList.add("dsh-gitlab-paneldrag");
      applyGitlabLayout({ mode: "float", x: rect.left, y: rect.top });
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
      applyGitlabLayout(layout);
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
      /* 持久化当前顺序（按 data-ref） */
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

  function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
  }

  function renderGitlabTasks(data) {
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
    const saved = getGitlabOrder().filter((r) => byRef.has(r));
    const rest = issues.filter((it) => !saved.includes(it.ref));
    const sorted = saved.map((r) => byRef.get(r)).concat(rest);

    const items = sorted.map((it) => {
      const labels = Array.isArray(it.labels) && it.labels.length
        ? '<span class="dsh-gitlab-labels">' + it.labels.map((l) => '<i>' + escapeHtml(l) + "</i>").join("") + "</span>"
        : "";
      const due = it.due ? '<span class="dsh-gitlab-due">截止 ' + escapeHtml(it.due) + "</span>" : "";
      return (
        '<a class="dsh-gitlab-item" draggable="true" data-ref="' + escapeAttr(it.ref || "") + '" href="' + escapeAttr(it.url || "#") + '" target="_blank" rel="noreferrer">' +
        '<span class="dsh-gitlab-ref">' + escapeHtml(it.ref || "#" + it.iid) + "</span>" +
        '<span class="dsh-gitlab-title2">' + escapeHtml(it.title || "") + "</span>" +
        labels + due +
        "</a>"
      );
    }).join("");
    bodyEl.innerHTML = items + '<div class="dsh-gitlab-more">共 ' + issues.length + " 个，拖动可排序，点击在 GitLab 打开</div>";
  }

  function ensureGitlabTasks(on) {
    if (on) {
      if (!gitlabSidebar) {
        gitlabSidebar = buildGitlabSidebar();
        document.body.appendChild(gitlabSidebar);
        applyGitlabLayout(getGitlabLayout());
      }
      gitlabSidebar.style.display = "";
      if (!gitlabTimer) {
        const tick = () => {
          fetch("/assets/gitlab-tasks.json?t=" + Date.now(), { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => renderGitlabTasks(d))
            .catch(() => {});
        };
        tick();
        gitlabTimer = setInterval(tick, 20000);
      }
    } else {
      if (gitlabTimer) {
        clearInterval(gitlabTimer);
        gitlabTimer = null;
      }
      if (gitlabSidebar) gitlabSidebar.style.display = "none";
    }
  }

  /* 立即拉取一次任务数据并渲染（保存配置后调用） */
  function refreshGitlabNow() {
    fetch("/assets/gitlab-tasks.json?t=" + Date.now(), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => renderGitlabTasks(d))
      .catch(() => {});
  }

  /* ==================== PowerShell 终端（多会话，横向排布） ==================== */
  let termEl = null;
  let termSessions = []; // { id, label, ws, term, fit, ro, pane, tab, reconnect, closing }
  let termSeq = 0;
  let termActiveId = null;

  function setTermStatus(text, on) {
    if (!termEl) return;
    termEl.classList.toggle("dsh-term-on", !!on);
    termEl.querySelector('[data-role="termStatus"]').textContent = text;
  }

  function getActiveTerm() {
    return termSessions.find((s) => s.id === termActiveId) || termSessions[0] || null;
  }

  function setSessionStatus(session, text, on) {
    /* 同步该终端标题栏的状态点 */
    const dot = session.pane && session.pane.querySelector('[data-role="paneDot"]');
    if (dot) dot.style.background = on ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)";
    const active = getActiveTerm();
    if (active && active.id === session.id) setTermStatus(text, on);
  }

  function fitTermSession(session) {
    if (!session || !session.fit || !session.term || !termEl || termEl.style.display === "none") return;
    try {
      session.fit.fit();
      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(JSON.stringify({ type: "resize", cols: session.term.cols, rows: session.term.rows }));
      }
    } catch (e) { /* ignore */ }
  }

  function initTermXterm(session) {
    if (typeof window.Terminal === "undefined") {
      session.host.textContent = "xterm.js 未加载（vendor 资源缺失）";
      return;
    }
    const term = new window.Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: "rgba(13, 17, 23, 0.55)",
        foreground: "#e6edf3",
        cursor: "#4176e6",
        cursorAccent: "#ffffff",
        selection: "rgba(65, 118, 230, 0.35)",
        black: "#0f1115",
        red: "#f25a5a",
        green: "#22c55e",
        yellow: "#f59e0b",
        blue: "#4176e6",
        magenta: "#b197fc",
        cyan: "#22d3ee",
        white: "#e6edf3",
        brightBlack: "#81858c",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#fbbf24",
        brightBlue: "#60a5fa",
        brightMagenta: "#c4b5fd",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff"
      }
    });
    if (typeof window.FitAddon !== "undefined") {
      session.fit = new window.FitAddon.FitAddon();
      term.loadAddon(session.fit);
    }
    term.open(session.host);
    session.term = term;
    /* 键盘逐键透传（方向键/Tab 补全/快捷键由 PSReadLine 在 PTY 侧处理） */
    term.onData((data) => {
      if (session.ws && session.ws.readyState === 1) session.ws.send(JSON.stringify({ type: "input", data }));
    });
    /* 点击聚焦 + 容器尺寸变化自适应 */
    session.pane.addEventListener("pointerdown", () => {
      activateTermSession(session.id);
      term.focus();
    });
    if (typeof ResizeObserver !== "undefined") {
      session.ro = new ResizeObserver(() => fitTermSession(session));
      session.ro.observe(session.host);
    }
    requestAnimationFrame(() => fitTermSession(session));
  }

  function connectTermSession(session) {
    if (session.closing) return;
    if (session.ws && (session.ws.readyState === 0 || session.ws.readyState === 1)) return;
    if (session.reconnect) return;
    setSessionStatus(session, "连接中…", false);
    try {
      session.ws = new WebSocket("ws://127.0.0.1:3082");
    } catch (e) {
      setSessionStatus(session, "无法连接终端服务", false);
      scheduleTermReconnect(session);
      return;
    }
    session.ws.onopen = () => {
      setSessionStatus(session, "已连接", true);
      fitTermSession(session);
      if (getActiveTerm() && getActiveTerm().id === session.id && session.term) session.term.focus();
    };
    session.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "out") {
          if (session.term) session.term.write(msg.data);
        } else if (msg.type === "cwd") {
          session.cwd = msg.data;
          const label = session.pane.querySelector('[data-role="cwdLabel"]');
          if (label && label.style.display !== "none") label.textContent = msg.data;
        } else if (msg.type === "exit") {
          setSessionStatus(session, "进程已退出，3 秒后重连", false);
          if (session.term) session.term.writeln("\r\n\x1b[31m[进程已退出]\x1b[0m");
          scheduleTermReconnect(session);
        } else if (msg.type === "err") {
          setSessionStatus(session, "错误: " + msg.data, false);
        }
      } catch (e) { /* ignore */ }
    };
    session.ws.onclose = () => {
      session.ws = null;
      if (!session.closing && document.body.classList.contains("dsh-term-open")) scheduleTermReconnect(session);
      else setSessionStatus(session, "已关闭", false);
    };
    session.ws.onerror = () => { /* onclose 处理重连 */ };
  }

  function scheduleTermReconnect(session) {
    if (session.closing || session.reconnect) return;
    if (!document.body.classList.contains("dsh-term-open")) return;
    session.reconnect = setTimeout(() => {
      session.reconnect = null;
      connectTermSession(session);
    }, 3000);
  }

  function updatePaneUI() {
    termSessions.forEach((s) => {
      s.pane.classList.toggle("dsh-term-pane-active", s.id === termActiveId);
    });
    const panes = termEl.querySelector('[data-role="termPanes"]');
    let empty = panes.querySelector(".dsh-term-empty");
    if (termSessions.length === 0) {
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "dsh-term-empty";
        empty.textContent = "没有终端，点击 ＋ 添加";
        panes.appendChild(empty);
      }
      empty.style.display = "";
      setTermStatus("空", false);
    } else if (empty) {
      empty.style.display = "none";
    }
  }

  function activateTermSession(id) {
    if (!termSessions.some((s) => s.id === id)) return;
    termActiveId = id;
    updatePaneUI();
    const s = getActiveTerm();
    if (s && s.term) s.term.focus();
    if (s) {
      setSessionStatus(s, s.ws && s.ws.readyState === 1 ? "已连接" : "连接中…", s.ws && s.ws.readyState === 1);
    }
  }

  function createTermSession() {
    termSeq++;
    const id = termSeq;
    const label = "终端 " + id;

    const pane = document.createElement("div");
    pane.className = "dsh-term-pane";
    pane.innerHTML =
      '<div class="dsh-term-panehead" data-role="paneHead" title="点击激活此终端">' +
      '  <span class="dsh-term-panedot" data-role="paneDot"></span>' +
      '  <span class="dsh-term-panelabel" data-role="paneLabel">' + label + "</span>" +
      '  <button type="button" class="dsh-term-panex" data-role="paneX" title="关闭此终端">×</button>' +
      "</div>" +
      '<div class="dsh-term-cwdbar" data-role="cwd" title="点击选择文件夹；✎ 手动输入路径">' +
      '  <span class="dsh-term-cwdicon">📁</span>' +
      '  <span class="dsh-term-cwdlabel" data-role="cwdLabel">—</span>' +
      '  <button type="button" class="dsh-term-cwdbtn" data-role="cwdEdit" title="手动输入路径">✎</button>' +
      '  <input type="text" class="dsh-term-cwdinput" data-role="cwdInput" spellcheck="false" autocomplete="off" />' +
      "</div>";
    const host = document.createElement("div");
    host.className = "dsh-term-xterm";
    pane.appendChild(host);
    const panesEl = termEl.querySelector('[data-role="termPanes"]');
    const empty = panesEl.querySelector(".dsh-term-empty");
    if (empty) empty.remove();
    panesEl.appendChild(pane);

    const session = { id, label, cwd: null, ws: null, term: null, fit: null, ro: null, pane, host, reconnect: null, closing: false };
    termSessions.push(session);

    /* 标题栏：点击激活；× 关闭 */
    const paneHead = pane.querySelector('[data-role="paneHead"]');
    paneHead.addEventListener("click", (e) => {
      if (e.target.closest('[data-role="paneX"]')) {
        closeTermSession(id);
        return;
      }
      activateTermSession(id);
    });

    bindCwdBar(session);
    initTermXterm(session);
    connectTermSession(session);
    activateTermSession(id);
    return session;
  }

  /* 打开原生文件夹选择框（经终端桥 127.0.0.1:3082/pick-folder） */
  function openFolderDialog(session) {
    const start = session.cwd || "";
    fetch("http://127.0.0.1:3082/pick-folder?start=" + encodeURIComponent(start), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.path && session.ws && session.ws.readyState === 1) {
          const escaped = String(d.path).replace(/'/g, "''");
          session.ws.send(JSON.stringify({ type: "input", data: "Set-Location -LiteralPath '" + escaped + "'\r" }));
        }
      })
      .catch(() => {});
  }

  /* 路径条：点击弹原生文件夹选择框；✎ 手动输入；Enter 执行 Set-Location */
  function bindCwdBar(session) {
    const bar = session.pane.querySelector('[data-role="cwd"]');
    const label = session.pane.querySelector('[data-role="cwdLabel"]');
    const input = session.pane.querySelector('[data-role="cwdInput"]');
    let editing = false;

    const show = () => {
      editing = false;
      input.style.display = "none";
      label.style.display = "";
      label.textContent = session.cwd || "—";
    };
    const startEdit = () => {
      editing = true;
      label.style.display = "none";
      input.style.display = "";
      input.value = session.cwd || "";
      input.focus();
      input.select();
    };
    const commit = () => {
      editing = false;
      const v = input.value.trim();
      show();
      if (v && v !== session.cwd && session.ws && session.ws.readyState === 1) {
        const escaped = v.replace(/'/g, "''");
        session.ws.send(JSON.stringify({ type: "input", data: "Set-Location -LiteralPath '" + escaped + "'\r" }));
      }
    };

    bar.addEventListener("click", (e) => {
      if (e.target.closest('[data-role="cwdEdit"]')) {
        if (!editing) startEdit();
        return;
      }
      if (e.target === input || editing) return;
      openFolderDialog(session);
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") show();
    });
    input.addEventListener("blur", () => {
      if (editing) commit();
    });
  }

  function closeTermSession(id) {
    const idx = termSessions.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const s = termSessions[idx];
    s.closing = true;
    if (s.reconnect) {
      clearTimeout(s.reconnect);
      s.reconnect = null;
    }
    if (s.ws) {
      try { s.ws.close(); } catch (e) { /* ignore */ }
      s.ws = null;
    }
    if (s.ro) s.ro.disconnect();
    if (s.term) {
      try { s.term.dispose(); } catch (e) { /* ignore */ }
    }
    s.pane.remove();
    termSessions.splice(idx, 1);
    if (termActiveId === id) termActiveId = termSessions.length ? termSessions[termSessions.length - 1].id : null;
    updatePaneUI();
    if (termActiveId) activateTermSession(termActiveId);
    try {
      localStorage.setItem("dsh.termCount", String(Math.max(1, termSessions.length)));
    } catch (e) { /* ignore */ }
  }

  function buildTerminalPanel() {
    const el = document.createElement("div");
    el.id = "dsh-terminal";
    /* 恢复上次高度 */
    try {
      const saved = parseInt(localStorage.getItem("dsh.termHeight") || "", 10);
      if (Number.isFinite(saved) && saved >= 120) el.style.height = saved + "px";
    } catch (e) { /* ignore */ }
    el.innerHTML =
      '<div class="dsh-term-resizer" data-role="termResize" title="拖动调整终端高度"></div>' +
      '<div class="dsh-term-head">' +
      '  <span class="dsh-term-title">PowerShell 终端</span>' +
      '  <span class="dsh-term-dot"></span>' +
      '  <span class="dsh-term-status" data-role="termStatus">连接中…</span>' +
      '  <button type="button" class="dsh-term-add" data-role="termAdd" title="添加终端">＋</button>' +
      '  <span class="dsh-term-spacer"></span>' +
      '  <button type="button" class="dsh-term-btn" data-role="termClear">清屏</button>' +
      '  <button type="button" class="dsh-term-btn" data-role="termRestart">重启</button>' +
      '  <button type="button" class="dsh-term-btn" data-role="termClose" title="关闭终端面板">×</button>' +
      "</div>" +
      '<div class="dsh-term-panes" data-role="termPanes"></div>';

    /* 拖拽调整高度 */
    const resizer = el.querySelector('[data-role="termResize"]');
    let resizing = null;
    resizer.addEventListener("pointerdown", (e) => {
      resizing = { y: e.clientY, h: el.getBoundingClientRect().height };
      resizer.classList.add("dsh-term-resizing");
      resizer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    resizer.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const vh = window.innerHeight;
      const h = Math.max(120, Math.min(Math.floor(vh * 0.7), resizing.h + (resizing.y - e.clientY)));
      el.style.height = h + "px";
      termSessions.forEach((s) => fitTermSession(s));
    });
    const endResize = () => {
      if (!resizing) return;
      resizing = null;
      resizer.classList.remove("dsh-term-resizing");
      try {
        localStorage.setItem("dsh.termHeight", String(parseInt(el.style.height, 10) || 240));
      } catch (err) { /* ignore */ }
      termSessions.forEach((s) => fitTermSession(s));
    };
    resizer.addEventListener("pointerup", endResize);
    resizer.addEventListener("pointercancel", endResize);

    el.querySelector('[data-role="termAdd"]').addEventListener("click", () => createTermSession());
    el.querySelector('[data-role="termClose"]').addEventListener("click", () => {
      const next = { ...load(), terminal: false };
      save(next);
      apply(next);
    });
    el.querySelector('[data-role="termClear"]').addEventListener("click", () => {
      const s = getActiveTerm();
      if (!s) return;
      if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "input", data: "\x0c" }));
      else if (s.term) s.term.clear();
    });
    el.querySelector('[data-role="termRestart"]').addEventListener("click", () => {
      const s = getActiveTerm();
      if (s && s.ws && s.ws.readyState === 1) {
        s.ws.send(JSON.stringify({ type: "restart" }));
        setSessionStatus(s, "重启中…", false);
      }
    });

    return el;
  }

  function injectTerminalPanel() {
    if (!document.body.classList.contains("dsh-term-open")) return;
    const host = document.querySelector(".pI_x6G_centerCol");
    if (!host || host.querySelector("#dsh-terminal")) return;
    termEl = buildTerminalPanel();
    host.appendChild(termEl);
    /* 恢复终端数量（默认 1，上限 4） */
    let count = 1;
    try {
      count = Math.max(1, Math.min(4, parseInt(localStorage.getItem("dsh.termCount") || "1", 10) || 1));
    } catch (e) { /* ignore */ }
    for (let i = 0; i < count; i++) createTermSession();
  }

  function ensureTerminal(on) {
    if (on) {
      document.body.classList.add("dsh-term-open");
      if (!termEl) injectTerminalPanel();
      else {
        termEl.style.display = "";
        if (termSessions.length === 0) createTermSession();
        termSessions.forEach((s) => {
          fitTermSession(s);
          connectTermSession(s);
        });
      }
    } else {
      document.body.classList.remove("dsh-term-open");
      termSessions.forEach((s) => {
        if (s.reconnect) {
          clearTimeout(s.reconnect);
          s.reconnect = null;
        }
        if (s.ws) {
          try { s.ws.close(); } catch (e) { /* ignore */ }
          s.ws = null;
        }
      });
      if (termEl) termEl.style.display = "none";
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- 主题设置面板内容 ---------- */
  function buildThemePanel() {
    const cfg = load();
    const panel = document.createElement("section");
    panel.id = "dsh-theme-panel";
    const pct = Number(cfg.transparency) || 0;
    const name = cfg.name || (cfg.image ? "自定义图片" : "默认图片");
    const glassOn = cfg.glass !== false;
    const strength = Number(cfg.glassStrength) || DEFAULT_GLASS_STRENGTH;
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
      '<div class="dsh-bg-hint">背景图上限约 3MB；遮罩颜色覆盖在背景图上，可整体改变界面色调。透明度越高，背景图越明显。毛玻璃作用于对话区与输入区。系统监控悬浮窗显示 CPU/GPU/内存/磁盘/网络，可拖动。GitLab 任务为可拖动子窗口，拖到四边自动吸附，吸附上/下边时任务横向排列；地址与令牌保存到本机 gitlab-config.json。配置保存在本机浏览器（localStorage）。</div>' +
      '<input type="file" accept="image/*" hidden data-role="file" />';

    const fileInput = panel.querySelector('[data-role="file"]');
    const nameEl = panel.querySelector('[data-role="name"]');
    const resetBtn = panel.querySelector('[data-action="reset"]');

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

    /* 系统监控悬浮窗开关 */
    const monitorInput = panel.querySelector('[data-role="monitor"]');
    const monitorState = panel.querySelector('[data-role="monitorState"]');
    monitorInput.addEventListener("change", () => {
      monitorState.textContent = monitorInput.checked ? "开启" : "关闭";
      const next = { ...load(), monitor: monitorInput.checked };
      save(next);
      apply(next);
    });

    /* GitLab 任务悬浮窗开关 */
    const gitlabInput = panel.querySelector('[data-role="gitlab"]');
    const gitlabState = panel.querySelector('[data-role="gitlabState"]');
    gitlabInput.addEventListener("change", () => {
      gitlabState.textContent = gitlabInput.checked ? "开启" : "关闭";
      const next = { ...load(), gitlabTasks: gitlabInput.checked };
      save(next);
      apply(next);
    });

    /* PowerShell 终端开关 */
    const termInput = panel.querySelector('[data-role="terminal"]');
    const termState = panel.querySelector('[data-role="terminalState"]');
    termInput.addEventListener("change", () => {
      termState.textContent = termInput.checked ? "开启" : "关闭";
      const next = { ...load(), terminal: termInput.checked };
      save(next);
      apply(next);
    });

    /* GitLab 配置（URL + 令牌，经本地桥接 127.0.0.1:3081） */
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
      return fetch("http://127.0.0.1:3081" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then((r) => r.json());
    }

    fetch("http://127.0.0.1:3081/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        glUrl.value = d.url || "";
        glToken.placeholder = d.tokenConfigured ? "已配置，留空保持不变" : "粘贴 Personal Access Token";
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
            glToken.placeholder = "已配置，留空保持不变";
            /* 同步开关状态 + 打开侧边栏 + 立即刷新 */
            gitlabInput.checked = true;
            gitlabState.textContent = "开启";
            const next = { ...load(), gitlabTasks: true };
            save(next);
            apply(next);
            refreshGitlabNow();
          } else {
            setGlStatus("✗ " + (d.error || "保存失败"), false);
          }
        })
        .catch(() => setGlStatus("✗ 桥接服务未运行", false));
    });

    return panel;
  }

  /* ---------- 导航分区：注入"主题设置"到左侧列表 + 内容切换 ---------- */
  let themeActive = false;
  let suppress = false;

  function sync() {
    const panel = document.querySelector(".VOzbGW_panel");
    if (!panel) return;
    const navList = panel.querySelector(".VOzbGW_navList");
    const content = panel.querySelector(".VOzbGW_content");
    const options = panel.querySelector(".VOzbGW_options");
    if (!navList || !content || !options) return;

    /* 左侧导航项 */
    let cell = navList.querySelector("#dsh-theme-nav");
    if (!cell) {
      cell = document.createElement("button");
      cell.type = "button";
      cell.id = "dsh-theme-nav";
      cell.className = "VOzbGW_navCell";
      const label = document.createElement("span");
      label.className = "VOzbGW_navLabel";
      label.textContent = "主题设置";
      cell.appendChild(label);
      suppress = true;
      navList.appendChild(cell);
      suppress = false;
    }

    /* 右侧内容：主题面板 ↔ React 分区内容 */
    let themeEl = content.querySelector("#dsh-theme-panel");
    if (themeActive) {
      if (!themeEl) {
        themeEl = buildThemePanel();
        suppress = true;
        content.insertBefore(themeEl, options);
        suppress = false;
      }
      themeEl.style.display = "";
      options.style.display = "none";
      /* 清除其他分区的高亮，避免两个选中项 */
      navList.querySelectorAll(".VOzbGW_navCell").forEach((c) => {
        if (c.id !== "dsh-theme-nav") c.classList.remove("VOzbGW_active");
      });
      cell.classList.add("VOzbGW_active");
    } else {
      if (themeEl) {
        suppress = true;
        themeEl.remove();
        suppress = false;
      }
      options.style.display = "";
      cell.classList.remove("VOzbGW_active");
    }
  }

  /* 文档级捕获点击：识别左侧导航点击（React 分区 vs 主题设置） */
  document.addEventListener(
    "click",
    (e) => {
      const cell = e.target.closest(".VOzbGW_navCell");
      if (!cell) return;
      const active = cell.id === "dsh-theme-nav";
      if (active !== themeActive) {
        themeActive = active;
        sync();
      }
    },
    true
  );

  /* 设置弹窗是运行时渲染的，观察 DOM 变化，出现/重渲染时同步 */
  const observer = new MutationObserver(() => {
    if (suppress) return;
    /* 终端开启时，确保面板已注入中心列（React 重渲染可能清掉） */
    if (document.body.classList.contains("dsh-term-open")) injectTerminalPanel();
    const panel = document.querySelector(".VOzbGW_panel");
    if (!panel) {
      themeActive = false;
      return;
    }
    sync();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  /* ---------- 初始应用（恢复已保存的配置） ---------- */
  apply(load());
})();
