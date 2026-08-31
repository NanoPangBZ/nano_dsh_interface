/* =====================================================================
   dshnano-terminal — PowerShell 终端模块
   多会话横向排布，xterm.js 全终端模拟（数据来自 terminal-bridge.mjs
   ws://127.0.0.1:3082，每连接一个独立 pwsh PTY）
   改进：断线指数退避重连（1s→2s→4s→8s→上限 30s，连接成功即复位）；
        面板注入使用结构探测（centerCol），不再依赖固定哈希类名。
   ===================================================================== */
"use strict";

import { structure, updateConfig, escapeHtml, escapeAttr } from "./dshnano-core.js";

let termEl = null;
let termSessions = []; // { id, label, ws, term, fit, ro, pane, reconnect, backoff, closing }
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
    session.backoff = 1000; // 成功即复位退避
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
        setSessionStatus(session, "进程已退出，稍后重连", false);
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

/** 指数退避重连：1s→2s→4s→8s…上限 30s；连接成功后复位 */
function scheduleTermReconnect(session) {
  if (session.closing || session.reconnect) return;
  if (!document.body.classList.contains("dsh-term-open")) return;
  const delay = session.backoff || 1000;
  session.backoff = Math.min(30000, delay * 2);
  setSessionStatus(session, (delay / 1000) + " 秒后重连", false);
  session.reconnect = setTimeout(() => {
    session.reconnect = null;
    connectTermSession(session);
  }, delay);
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

  const session = { id, label, cwd: null, ws: null, term: null, fit: null, ro: null, pane, host, reconnect: null, backoff: 1000, closing: false };
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

/* ==================== 自研目录选择器（扫描列表，无系统弹窗） ==================== */
let dirPicker = null;      // 弹层 DOM
let dirPickerCtx = null;   // { session, path, parent }
let dirPickerKeyHandler = null;

function setDirStatus(text, ok) {
  if (!dirPicker) return;
  const st = dirPicker.querySelector('[data-role="status"]');
  if (st) {
    st.textContent = text;
    st.style.color = ok === false ? "var(--dsw-alias-state-error-primary)" : ok === true ? "var(--dsw-alias-state-success-primary)" : "";
  }
}

function renderDirList(data) {
  if (!dirPicker) return;
  const listEl = dirPicker.querySelector('[data-role="list"]');
  const cwdEl = dirPicker.querySelector('[data-role="cwd"]');
  const upBtn = dirPicker.querySelector('[data-act="up"]');
  const chooseBtn = dirPicker.querySelector('[data-act="choose"]');
  if (!data || !data.ok) {
    listEl.innerHTML = '<div class="dsh-dirpicker-empty">' + escapeHtml((data && data.error) || "加载失败") + "</div>";
    setDirStatus("", false);
    chooseBtn.disabled = true;
    upBtn.disabled = true;
    return;
  }
  dirPickerCtx.path = data.path || "";
  dirPickerCtx.parent = data.parent || null;
  cwdEl.textContent = data.path || "选择盘符";
  cwdEl.title = data.path || "";
  upBtn.disabled = !data.parent;
  chooseBtn.disabled = !data.path;
  setDirStatus("", null);
  if (data.drives && data.drives.length) {
    listEl.innerHTML = data.drives.map((d) =>
      '<div class="dsh-dirpicker-item" data-path="' + escapeAttr(d) + '" title="' + escapeAttr(d) + '">💽 ' + escapeHtml(d) + "</div>"
    ).join("");
  } else if (data.entries && data.entries.length) {
    listEl.innerHTML = data.entries.map((it) =>
      '<div class="dsh-dirpicker-item" data-path="' + escapeAttr(it.path) + '" title="' + escapeAttr(it.path) + '">📁 ' + escapeHtml(it.name) + "</div>"
    ).join("");
  } else {
    listEl.innerHTML = '<div class="dsh-dirpicker-empty">（无子目录）</div>';
  }
}

function navigateDir(p) {
  if (!dirPicker) return;
  setDirStatus("加载中…", null);
  fetch("http://127.0.0.1:3082/list-dir?path=" + encodeURIComponent(p), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => renderDirList(d))
    .catch(() => setDirStatus("✗ 无法连接目录服务", false));
}

function chooseDir() {
  if (!dirPicker || !dirPickerCtx || !dirPickerCtx.path) return;
  const target = dirPickerCtx.path;
  const session = dirPickerCtx.session;
  closeDirPicker();
  if (session && session.ws && session.ws.readyState === 1) {
    const escaped = String(target).replace(/'/g, "''");
    session.ws.send(JSON.stringify({ type: "input", data: "Set-Location -LiteralPath '" + escaped + "'\r" }));
  }
}

function closeDirPicker() {
  if (dirPicker) {
    dirPicker.remove();
    dirPicker = null;
  }
  dirPickerCtx = null;
  if (dirPickerKeyHandler) {
    document.removeEventListener("keydown", dirPickerKeyHandler);
    dirPickerKeyHandler = null;
  }
}

function openDirPicker(session) {
  closeDirPicker();
  dirPickerCtx = { session, path: "", parent: null };
  const el = document.createElement("div");
  el.className = "dsh-dirpicker";
  el.innerHTML =
    '<div class="dsh-dirpicker-head">' +
    '  <span class="dsh-dirpicker-title">选择目录</span>' +
    '  <button type="button" class="dsh-dirpicker-close" data-act="close" title="关闭">×</button>' +
    "</div>" +
    '<div class="dsh-dirpicker-pathbar">' +
    '  <span class="dsh-dirpicker-cwd" data-role="cwd" title="">—</span>' +
    '  <button type="button" class="dsh-dirpicker-edit" data-act="edit" title="手动输入路径">✎</button>' +
    '  <input type="text" class="dsh-dirpicker-input" data-role="input" spellcheck="false" autocomplete="off" hidden />' +
    "</div>" +
    '<div class="dsh-dirpicker-actions">' +
    '  <button type="button" class="dsh-dirpicker-btn" data-act="up">⬆ 返回上一路径</button>' +
    '  <button type="button" class="dsh-dirpicker-btn" data-act="refresh">⟳ 刷新</button>' +
    '  <button type="button" class="dsh-dirpicker-btn dsh-dirpicker-primary" data-act="choose">✓ 选择此目录</button>' +
    "</div>" +
    '<div class="dsh-dirpicker-list" data-role="list"><div class="dsh-dirpicker-empty">加载中…</div></div>' +
    '<div class="dsh-dirpicker-status" data-role="status"></div>';
  document.body.appendChild(el);
  dirPicker = el;

  el.querySelector('[data-act="close"]').addEventListener("click", closeDirPicker);
  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) closeDirPicker(); // 点击弹层外区域关闭
  });
  el.querySelector('[data-act="up"]').addEventListener("click", () => {
    if (dirPickerCtx && dirPickerCtx.parent) navigateDir(dirPickerCtx.parent);
  });
  el.querySelector('[data-act="refresh"]').addEventListener("click", () => {
    navigateDir(dirPickerCtx ? dirPickerCtx.path : "");
  });
  el.querySelector('[data-act="choose"]').addEventListener("click", chooseDir);

  /* 列表项：单击进入目录；双击直接选择 */
  const listEl = el.querySelector('[data-role="list"]');
  listEl.addEventListener("click", (e) => {
    const item = e.target.closest(".dsh-dirpicker-item");
    if (!item || !item.dataset.path) return;
    navigateDir(item.dataset.path);
  });
  listEl.addEventListener("dblclick", (e) => {
    const item = e.target.closest(".dsh-dirpicker-item");
    if (!item || !item.dataset.path) return;
    dirPickerCtx.path = item.dataset.path;
    chooseDir();
  });
  listEl.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  /* 手动输入路径：Enter 校验并选择；Escape 取消 */
  const input = el.querySelector('[data-role="input"]');
  el.querySelector('[data-act="edit"]').addEventListener("click", () => {
    input.value = dirPickerCtx && dirPickerCtx.path ? dirPickerCtx.path : "";
    input.hidden = false;
    input.focus();
    input.select();
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const v = input.value.trim();
      if (!v) { input.hidden = true; return; }
      fetch("http://127.0.0.1:3082/list-dir?path=" + encodeURIComponent(v), { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.ok) {
            dirPickerCtx.path = d.path || v;
            input.hidden = true;
            chooseDir();
          } else {
            setDirStatus("✗ " + ((d && d.error) || "路径无效"), false);
          }
        })
        .catch(() => setDirStatus("✗ 无法连接目录服务", false));
    } else if (e.key === "Escape") {
      input.hidden = true;
    }
  });

  /* 全局 Escape 关闭弹层 */
  dirPickerKeyHandler = (e) => {
    if (e.key === "Escape" && dirPicker) closeDirPicker();
  };
  document.addEventListener("keydown", dirPickerKeyHandler);

  /* 初始加载：当前 cwd（或盘符列表） */
  navigateDir(session && session.cwd ? session.cwd : "");
}

/* 路径条：点击打开目录选择器；✎ 手动输入；Enter 执行 Set-Location */
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
    openDirPicker(session);
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

function buildPanel() {
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
    updateConfig({ terminal: false });
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

/** 注入到会话主列（centerCol）底部；结构未探测到时静默跳过 */
export function injectPanel() {
  if (!document.body.classList.contains("dsh-term-open")) return;
  const host = structure.centerCol;
  if (!host || host.querySelector("#dsh-terminal")) return;
  termEl = buildPanel();
  host.appendChild(termEl);
  /* 恢复终端数量（默认 1，上限 4） */
  let count = 1;
  try {
    count = Math.max(1, Math.min(4, parseInt(localStorage.getItem("dsh.termCount") || "1", 10) || 1));
  } catch (e) { /* ignore */ }
  for (let i = 0; i < count; i++) createTermSession();
}

/** 供 core.apply 分发调用的模块入口 */
export function ensure(on) {
  if (on) {
    document.body.classList.add("dsh-term-open");
    if (!termEl) injectPanel();
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

export function apply(cfg) {
  ensure(cfg ? cfg.terminal !== false : true);
}
