const { invoke } = window.__TAURI__.core;
const { getCurrentWindow, cursorPosition } = window.__TAURI__.window;
const { PhysicalPosition } = window.__TAURI__.dpi;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const DEFAULT_TARGET_BRANCHES = ["us-develop", "us-pre", "us-release"];
const DEFAULT_RELEASE_APPROVER = "1p0_lwg0y28tpf";
const DEFAULT_DOODLE_COLOR = "#ffb454";
const DINGTALK_CONTACTS = [
  { name: "空我", userId: "1p0_lwg0y28tpf" },
  { name: "晴天", userId: "zhanghaovoo" },
];

/* 整窗拖拽：除交互控件和可选中文本外，按住任何地方都能拖动窗口 */
const NO_DRAG = "button, input, select, a, canvas, .porcelain, .commits, .transcript, .path, .errorline";
let compactDrag = null;

function shouldDragWindow(e) {
  if (e.button !== 0) return;
  if (state?.doodleEnabled && (e.metaKey || e.ctrlKey)) return false;
  if (e.target.closest(NO_DRAG)) return;
  return true;
}

function stopCompactWindowDrag() {
  if (!compactDrag) return;
  compactDrag.active = false;
  if (compactDrag.raf) {
    cancelAnimationFrame(compactDrag.raf);
  }
  window.removeEventListener("mouseup", stopCompactWindowDrag, true);
  compactDrag = null;
}

async function startCompactWindowDrag(e) {
  const win = getCurrentWindow();
  const drag = {
    active: true,
    pending: false,
    raf: 0,
    offsetX: 0,
    offsetY: 0,
  };
  compactDrag = drag;

  try {
    const [cursor, position] = await Promise.all([cursorPosition(), win.outerPosition()]);
    drag.offsetX = cursor.x - position.x;
    drag.offsetY = cursor.y - position.y;
  } catch (_) {
    compactDrag = null;
    await win.startDragging();
    return;
  }

  e.preventDefault();
  window.addEventListener("mouseup", stopCompactWindowDrag, true);

  const tick = async () => {
    if (!drag.active) return;
    if (!drag.pending) {
      drag.pending = true;
      try {
        const cursor = await cursorPosition();
        const x = Math.round(cursor.x - drag.offsetX);
        const y = Math.round(cursor.y - drag.offsetY);
        await win.setPosition(new PhysicalPosition(x, y));
      } catch (_) {
        stopCompactWindowDrag();
        return;
      } finally {
        drag.pending = false;
      }
    }
    if (drag.active) {
      drag.raf = requestAnimationFrame(tick);
    }
  };

  tick();
}

document.addEventListener("mousedown", (e) => {
  if (!shouldDragWindow(e)) return;
  if (state.desktopPinned) {
    startCompactWindowDrag(e);
    return;
  }
  getCurrentWindow().startDragging();
});

const state = {
  dir: null,
  watchedDir: null,
  info: null,
  targetBranches: loadTargetBranches(),
  targets: new Set(),
  dingtalkRecipients: new Set([DEFAULT_RELEASE_APPROVER]),
  isCreating: false,
  desktopPinned: localStorage.getItem("mrkit.desktopPinned") === "1",
  dingtalkDefaults: null,
  doodleEnabled: localStorage.getItem("mrkit.doodle.enabled") === "1",
  doodleColor: localStorage.getItem("mrkit.doodle.color") || DEFAULT_DOODLE_COLOR,
  doodleDrawing: false,
  doodleLast: null,
  updateInfo: null,
  updateStatus: "idle",
  updateError: "",
  isCheckingUpdate: false,
  isInstallingUpdate: false,
};

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setError(msg) {
  $("global-error").textContent = msg || "";
}

function stripHash(oneline) {
  return oneline.replace(/^[0-9a-f]{7,40}\s+/, "");
}

function splitOneline(line) {
  const m = line.match(/^([0-9a-f]{7,40})\s+(.*)$/);
  return m ? { hash: m[1], subject: m[2] } : { hash: "", subject: line };
}

function shortTitle(title, limit = 30) {
  const text = String(title || "").trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

async function notifyUser(title, body) {
  try {
    await invoke("notify_user", { title, body });
  } catch (_) {
    // 通知权限被关闭时不影响主流程，界面里仍会显示结果。
  }
}

async function copyText(text) {
  if (!text) return false;
  try {
    await invoke("plugin:clipboard-manager|write_text", { text });
    return true;
  } catch (_) {
    // Web Clipboard 在 WebView 上可能因权限/焦点失败，作为降级再试一次。
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    return false;
  }
}

function compactError(message) {
  const text = String(message).replace(/\s+/g, " ").trim();
  if (text.includes("git commit 失败")) return "git commit 失败，错误详情已复制";
  if (text.includes("git push") || text.includes("推送失败")) return "推送失败，错误详情已复制";
  if (text.includes("glab") || text.includes("mr create")) return "MR 创建失败，错误详情已复制";
  return "操作失败，错误详情已复制";
}

function compactMessage(message, limit = 360) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + "…";
}

function failureDetail(target, output) {
  const message = compactMessage(output || "未返回错误详情");
  return `${target}: ${message}`;
}

/* ---------- glab 状态灯 ---------- */

function setGlabLamp(cls, text, title) {
  const el = $("glab-badge");
  el.className = "lamp-status " + cls;
  el.innerHTML = `<i class="lamp" data-tauri-drag-region></i>${esc(text)}`;
  el.title = title || "";
}

async function checkGlab() {
  try {
    const s = await invoke("glab_status", { path: state.dir || "." });
    if (!s.installed) {
      setGlabLamp("bad", "glab 未安装", s.detail);
    } else if (!s.authed) {
      setGlabLamp("bad", "glab 未登录", s.detail + "\n请执行: glab auth login --hostname <你的GitLab域名>");
    } else {
      setGlabLamp("good", "glab", s.detail);
    }
  } catch (e) {
    setGlabLamp("bad", "glab 检测失败", String(e));
  }
}

/* ---------- 仓库列表 ---------- */

function getRepos() {
  try {
    return JSON.parse(localStorage.getItem("mrkit.repos") || "[]");
  } catch {
    return [];
  }
}

function saveRepos(repos) {
  localStorage.setItem("mrkit.repos", JSON.stringify(repos));
}

function repoName(path) {
  return path.split("/").filter(Boolean).pop() || path;
}

function targetStorageKey(dir = state.dir) {
  return dir ? `mrkit.targets.${dir}` : "mrkit.targets";
}

function dingtalkRecipientsStorageKey(dir = state.dir) {
  return dir ? `mrkit.dingtalkRecipients.${dir}` : "mrkit.dingtalkRecipients";
}

function parseTargetBranches(text) {
  const seen = new Set();
  return String(text || "")
    .split(/[\n,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
}

function loadTargetBranches() {
  const saved = parseTargetBranches(localStorage.getItem("mrkit.targetBranches") || "");
  return saved.length ? saved : [...DEFAULT_TARGET_BRANCHES];
}

function saveTargetBranches(branches) {
  const next = branches.length ? branches : [...DEFAULT_TARGET_BRANCHES];
  localStorage.setItem("mrkit.targetBranches", next.join("\n"));
  state.targetBranches = next;
  state.targets = new Set([...state.targets].filter((t) => state.targetBranches.includes(t)));
  saveTargets();
}

function loadTargets(dir = state.dir) {
  try {
    const saved = JSON.parse(localStorage.getItem(targetStorageKey(dir)) || "[]");
    return new Set(saved.filter((t) => state.targetBranches.includes(t)));
  } catch {
    return new Set();
  }
}

function saveTargets() {
  if (!state.dir) return;
  localStorage.setItem(targetStorageKey(), JSON.stringify([...state.targets]));
}

function loadDingtalkRecipients(dir = state.dir) {
  const key = dingtalkRecipientsStorageKey(dir);
  const raw = localStorage.getItem(key);
  if (raw === null) {
    return new Set([DEFAULT_RELEASE_APPROVER]);
  }
  try {
    const known = new Set(DINGTALK_CONTACTS.map((c) => c.userId));
    const saved = JSON.parse(raw);
    return new Set(saved.filter((id) => known.has(id)));
  } catch {
    return new Set([DEFAULT_RELEASE_APPROVER]);
  }
}

function saveDingtalkRecipients() {
  if (!state.dir) return;
  localStorage.setItem(dingtalkRecipientsStorageKey(), JSON.stringify([...state.dingtalkRecipients]));
}

function selectedTargetsLabel() {
  return state.targetBranches.map((target) => (state.targets.has(target) ? `● ${target}` : `○ ${target}`)).join("  ");
}

function renderDingtalkContacts() {
  const holder = $("dingtalk-contacts");
  if (!holder) return;
  holder.innerHTML = DINGTALK_CONTACTS.map((contact) => {
    const selected = state.dingtalkRecipients.has(contact.userId);
    return `<button class="contact-chip ${selected ? "selected" : ""}" data-dingtalk-user="${esc(contact.userId)}" title="${esc(contact.userId)}">${esc(contact.name)}</button>`;
  }).join("");
  holder.classList.toggle("none-selected", state.dingtalkRecipients.size === 0);
}

function toggleDingtalkContact(userId) {
  if (!DINGTALK_CONTACTS.some((c) => c.userId === userId)) return;
  if (state.dingtalkRecipients.has(userId)) {
    state.dingtalkRecipients.delete(userId);
  } else {
    state.dingtalkRecipients.add(userId);
  }
  saveDingtalkRecipients();
  renderDingtalkContacts();
}

function renderRepoSelect() {
  const options = getRepos()
    .map(
      (p) =>
        `<option value="${esc(p)}" title="${esc(p)}" ${p === state.dir ? "selected" : ""}>${esc(repoName(p))}</option>`
    )
    .join("");
  for (const sel of [$("repo-select"), $("compact-repo-select")]) {
    if (!sel) continue;
    sel.innerHTML = options;
    sel.title = state.dir || "切换仓库";
  }
  renderDingtalkContacts();
  renderCompact();
}

function switchRepo(dir) {
  state.dir = dir;
  state.targets = loadTargets(dir);
  state.dingtalkRecipients = loadDingtalkRecipients(dir);
  localStorage.setItem("mrkit.dir", dir);
  $("mr-title").value = "";
  $("commit-preview").innerHTML = "";
  refresh();
}

async function pickDir() {
  const dir = await invoke("pick_directory");
  if (!dir) return;
  const repos = getRepos();
  if (!repos.includes(dir)) {
    repos.push(dir);
    saveRepos(repos);
  }
  switchRepo(dir);
}

function removeRepo() {
  const repos = getRepos().filter((p) => p !== state.dir);
  saveRepos(repos);
  if (repos.length) {
    switchRepo(repos[0]);
  } else {
    state.dir = null;
    state.info = null;
    state.targets = new Set();
    state.dingtalkRecipients = new Set([DEFAULT_RELEASE_APPROVER]);
    localStorage.removeItem("mrkit.dir");
    $("workspace").hidden = true;
    $("empty-state").hidden = false;
    renderRepoSelect();
    renderTargets();
    syncTrayContext();
  }
}

function renderTargets() {
  const rails = $("target-rails");
  if (rails) {
    rails.innerHTML = state.targetBranches
      .map((target, index) => {
        const tee = index === state.targetBranches.length - 1 ? "└─" : "├─";
        return `<button class="rail ${state.targets.has(target) ? "selected" : ""}" data-target="${esc(target)}"><span class="tee">${tee}</span><i class="lamp"></i><span class="rail-name">${esc(target)}</span></button>`;
      })
      .join("");
  }
  document.querySelectorAll(".rail[data-target]").forEach((btn) => {
    btn.classList.toggle("selected", state.targets.has(btn.dataset.target));
  });
  const compactTargets = $("compact-targets");
  if (compactTargets) {
    compactTargets.innerHTML = state.targetBranches.map(
      (target) =>
        `<button class="compact-chip ${state.targets.has(target) ? "selected" : ""}" data-compact-target="${esc(target)}">${esc(target)}</button>`
    ).join("");
  }
  updateDispatchButton();
  renderCompact();
}

function renderCompact() {
  const repo = state.dir ? repoName(state.dir) : "未选择目录";
  const source = $("source-branch")?.value || state.info?.branch || "-";
  const branch = state.info?.branch || "-";
  $("compact-repo-name").textContent = repo;
  $("compact-source").textContent = source || branch;
  $("compact-branch").textContent = branch;
  $("compact-target-summary").textContent = selectedTargetsLabel();
  $("compact-create").disabled = state.isCreating || !state.dir || state.targets.size === 0;
  $("compact-create").classList.toggle("loading", state.isCreating);
  $("compact-create").textContent = state.isCreating ? "创建中…" : "发起 MR";
}

function syncTrayContext() {
  invoke("update_tray_context", {
    context: {
      dir: state.dir,
      repos: getRepos(),
      branch: state.info?.branch || "",
      source: $("source-branch")?.value || state.info?.branch || "",
      targets: [...state.targets],
      pinned: state.desktopPinned,
    },
  }).catch(() => {});
}

function applyDesktopPinnedClass() {
  document.body.classList.toggle("compact-mode", state.desktopPinned);
  $("compact-widget").hidden = !state.desktopPinned;
  if (state.desktopPinned) {
    closeSettings();
  }
}

async function setDesktopPinned(pinned, nativeApplied = false) {
  state.desktopPinned = pinned;
  localStorage.setItem("mrkit.desktopPinned", pinned ? "1" : "0");
  applyDesktopPinnedClass();
  if (!nativeApplied) {
    await invoke("set_desktop_pin", { pinned });
  }
  syncTrayContext();
}

async function hideCompactWidget() {
  await setDesktopPinned(false);
  await getCurrentWindow().hide();
}

/* ---------- git 状态 ---------- */

async function refresh() {
  if (!state.dir) return;
  setError("");
  $("empty-state").hidden = true;
  $("workspace").hidden = false;
  renderRepoSelect();
  watchRepo();

  let info;
  try {
    info = await invoke("git_info", { path: state.dir });
  } catch (e) {
    setError(String(e));
    return;
  }
  state.info = info;

  if (!info.is_repo) {
    $("git-summary").innerHTML = `<span class="seg warn">${esc(info.error)}</span>`;
    $("changed-files").innerHTML = "";
    $("mr-card").hidden = true;
    renderTargets();
    syncTrayContext();
    return;
  }

  // 状态段：分支 / 工作区 / 同步，全部明文
  const segs = [
    `<span class="seg branch" title="当前分支">${esc(info.branch || "(detached)")}</span>`,
  ];
  segs.push(
    info.dirty_count
      ? `<span class="seg warn">${info.dirty_count} 处未提交</span>`
      : `<span class="seg ok">工作区干净</span>`
  );
  if (info.has_upstream) {
    if (info.ahead) segs.push(`<span class="seg warn">${info.ahead} 条待推送</span>`);
    if (info.behind) segs.push(`<span class="seg warn">落后 ${info.behind} 条</span>`);
    if (!info.ahead && !info.behind) segs.push(`<span class="seg dim">已同步</span>`);
  } else {
    segs.push(`<span class="seg warn">未推送到远程</span>`);
  }
  $("git-summary").innerHTML = segs.join("");

  $("changed-files").innerHTML = info.changed_files
    .map((f) => {
      const st = f.slice(0, 2).trim();
      const file = f.slice(3);
      const cls = /A|\?/.test(st) ? "add" : /D/.test(st) ? "del" : "mod";
      return `<li><span class="st ${cls}">${esc(st)}</span>${esc(file)}</li>`;
    })
    .join("");

  $("mr-card").hidden = false;
  $("mr-title").value = "";
  $("commit-preview").innerHTML = "";
  refreshBranchMrs(info.branch);
  await loadBranches(info.branch);
  renderTargets();
  syncTrayContext();
  checkGlab();
}

/* 监听仓库 HEAD/stash：在终端里 checkout 或 stash 后界面自动刷新 */
function watchRepo() {
  if (!state.dir || state.watchedDir === state.dir) return;
  state.watchedDir = state.dir;
  invoke("watch_repo", { path: state.dir }).catch(() => {});
}

async function loadBranches(current) {
  try {
    const branches = await invoke("list_branches", { path: state.dir });
    const sel = $("source-branch");
    sel.innerHTML = branches
      .map((b) => `<option value="${esc(b)}" ${b === current ? "selected" : ""}>${esc(b)}</option>`)
      .join("");
    renderCompact();
    syncTrayContext();
  } catch (e) {
    setError(String(e));
  }
}

function renderBranchMrs(mrs) {
  const holder = $("branch-mrs");
  if (!holder) return;
  if (!mrs.length) {
    holder.className = "branch-mrs is-empty";
    holder.textContent = "暂无";
    return;
  }

  holder.className = "branch-mrs";
  holder.innerHTML = mrs
    .map((mr) => {
      const conflict = mr.hasConflicts ? `<span class="mr-conflict">冲突</span>` : "";
      const label = `!${esc(mr.iid)} → ${esc(mr.targetBranch || "-")}`;
      const title = `${label} ${mr.title || ""}`.trim();
      return `<div class="mr-row ${mr.hasConflicts ? "conflict" : ""}" title="${esc(title)}"><button class="mr-open" data-url="${esc(mr.url || "")}"><span class="mr-main"><span class="mr-id">${label}</span><span class="mr-title">${esc(shortTitle(mr.title, 68))}</span></span>${conflict}</button><span class="mr-actions"><button class="mr-action approve" data-mr-action="approve" data-iid="${esc(mr.iid)}">通过</button><button class="mr-action close" data-mr-action="close" data-iid="${esc(mr.iid)}">关闭</button></span></div>`;
    })
    .join("");
}

async function refreshBranchMrs(branch = state.info?.branch) {
  const holder = $("branch-mrs");
  if (!holder || !state.dir || !branch) return;
  holder.className = "branch-mrs loading";
  holder.textContent = "MR 检测中…";
  try {
    const mrs = await invoke("open_branch_mrs", {
      path: state.dir,
      remote: state.info?.remote_name || "origin",
      source: branch,
    });
    renderBranchMrs(mrs);
  } catch (e) {
    holder.className = "branch-mrs error";
    holder.textContent = "MR ?";
    holder.title = String(e);
  }
}

async function doFetch() {
  const btn = $("btn-fetch");
  btn.disabled = true;
  btn.textContent = "fetching…";
  try {
    await invoke("git_fetch", { path: state.dir, remote: state.info?.remote_name || "origin" });
    await refresh();
  } catch (e) {
    setError("fetch 失败: " + e);
  } finally {
    btn.disabled = false;
    btn.textContent = "fetch";
  }
}

/* ---------- 派发 ---------- */

function updateDispatchButton() {
  const n = state.targets.size;
  const btn = $("btn-create");
  btn.disabled = state.isCreating || n === 0;
  btn.classList.toggle("loading", state.isCreating);
  btn.textContent = state.isCreating ? "创建中…" : n === 0 ? "发起 MR" : `发起 ${n} 条 MR`;
  renderCompact();
}

function setCreating(creating) {
  state.isCreating = creating;
  updateDispatchButton();
}

function toggleTarget(btn) {
  toggleTargetByName(btn.dataset.target);
}

function toggleTargetByName(t) {
  if (!state.targetBranches.includes(t)) return;
  if (state.targets.has(t)) {
    state.targets.delete(t);
  } else {
    state.targets.add(t);
  }
  saveTargets();
  renderTargets();
  syncTrayContext();
}

async function suggestTitle() {
  if (!state.dir || !state.info) return;
  const source = $("source-branch").value;
  const target = state.targets.values().next().value || state.targetBranches[0] || "us-develop";
  try {
    const commits = await invoke("commits_between", {
      path: state.dir,
      remote: state.info.remote_name || "origin",
      target,
      source,
    });
    $("commit-preview").innerHTML = commits
      .slice(0, 10)
      .map((c) => {
        const { hash, subject } = splitOneline(c);
        return `<li><span class="hash">${esc(hash)}</span><span class="subject">${esc(subject)}</span></li>`;
      })
      .join("");
    if (commits.length) {
      $("mr-title").value = stripHash(commits[0]).slice(0, 72);
    }
  } catch (e) {
    setError(String(e));
  }
}

/* ---------- AI 设置 ---------- */

function loadAiConfig() {
  try {
    return JSON.parse(localStorage.getItem("mrkit.ai") || "{}");
  } catch {
    return {};
  }
}

function loadDingtalkConfig() {
  try {
    return JSON.parse(localStorage.getItem("mrkit.dingtalk") || "{}");
  } catch {
    return {};
  }
}

async function loadDingtalkDefaults() {
  try {
    state.dingtalkDefaults = await invoke("dingtalk_defaults");
  } catch {
    state.dingtalkDefaults = null;
  }
}

function loadUpdateConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem("mrkit.update") || "{}");
    return {
      cask: String(cfg.cask || "mr-kit").trim(),
    };
  } catch {
    return { cask: "mr-kit" };
  }
}

function saveUpdateConfig(cfg) {
  localStorage.setItem("mrkit.update", JSON.stringify(cfg));
}

/* ---------- 主题 ---------- */

const themeMedia = window.matchMedia("(prefers-color-scheme: light)");

function themePref() {
  return localStorage.getItem("mrkit.theme") || "system";
}

function skinPref() {
  return localStorage.getItem("mrkit.skin") || "amber";
}

function applyTheme() {
  const pref = themePref();
  const mode = pref === "system" ? (themeMedia.matches ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.skin = skinPref();
  document.querySelectorAll("[data-theme-value]").forEach((b) => {
    b.classList.toggle("selected", b.dataset.themeValue === pref);
  });
  document.querySelectorAll("[data-skin-value]").forEach((b) => {
    b.classList.toggle("selected", b.dataset.skinValue === skinPref());
  });
}

function setThemePref(pref) {
  localStorage.setItem("mrkit.theme", pref);
  applyTheme();
}

function setSkinPref(pref) {
  localStorage.setItem("mrkit.skin", pref);
  applyTheme();
}

themeMedia.addEventListener("change", applyTheme);

/* ---------- 涂鸦 ---------- */

function doodleCanvas() {
  return $("doodle-canvas");
}

function resizeDoodleCanvas() {
  const canvas = doodleCanvas();
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function applyDoodleState() {
  const canvas = doodleCanvas();
  if (!canvas) return;
  canvas.hidden = !state.doodleEnabled;
  document.body.classList.toggle("doodle-enabled", state.doodleEnabled);
  $("btn-doodle-toggle").textContent = state.doodleEnabled ? "关闭" : "开启";
  document.querySelectorAll("[data-doodle-color]").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.doodleColor === state.doodleColor);
  });
  if (state.doodleEnabled) {
    resizeDoodleCanvas();
  }
}

function setDoodleEnabled(enabled) {
  state.doodleEnabled = enabled;
  localStorage.setItem("mrkit.doodle.enabled", enabled ? "1" : "0");
  if (enabled) {
    closeSettings();
  }
  applyDoodleState();
}

function setDoodleColor(color) {
  state.doodleColor = color;
  localStorage.setItem("mrkit.doodle.color", color);
  applyDoodleState();
}

function clearDoodle() {
  const canvas = doodleCanvas();
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function doodlePoint(e) {
  const rect = doodleCanvas().getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function startDoodle(e) {
  if (!state.doodleEnabled) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.button !== 0) return;
  if (e.target.closest(".doodle-bar, .settings")) return;
  e.preventDefault();
  state.doodleDrawing = true;
  state.doodleLast = doodlePoint(e);
}

function moveDoodle(e) {
  if (!state.doodleEnabled || !state.doodleDrawing) return;
  e.preventDefault();
  const point = doodlePoint(e);
  const ctx = doodleCanvas().getContext("2d");
  ctx.strokeStyle = state.doodleColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(state.doodleLast.x, state.doodleLast.y);
  ctx.lineTo(point.x, point.y);
  ctx.stroke();
  state.doodleLast = point;
}

function stopDoodle(e) {
  if (e) {
    e.preventDefault();
  }
  state.doodleDrawing = false;
  state.doodleLast = null;
}

/* ---------- 自动更新 ---------- */

function renderUpdateBanner() {
  const banner = $("update-banner");
  if (!banner) return;
  banner.hidden = !state.updateInfo;
  renderUpdatePill();
  if (!state.updateInfo) return;
  const latestVersion = state.updateInfo.current_version || state.updateInfo.currentVersion || state.updateInfo.version;
  const installedVersion = state.updateInfo.version || "";
  $("update-title").textContent = installedVersion
    ? `发现新版本 ${latestVersion}`
    : `可安装 ${latestVersion}`;
  $("update-notes").textContent =
    state.updateInfo.notes || (installedVersion ? `当前版本 ${installedVersion}` : "");
  $("btn-update-install").disabled = state.isInstallingUpdate;
  $("btn-update-install").textContent = state.isInstallingUpdate
    ? installedVersion
      ? "升级中…"
      : "安装中…"
    : installedVersion
      ? "立即升级"
      : "立即安装";
}

function renderUpdatePill() {
  const pill = $("topbar-update");
  if (!pill) return;
  pill.classList.toggle("checking", state.updateStatus === "checking");
  pill.classList.toggle("error", state.updateStatus === "error");
  if (state.updateInfo) {
    const latestVersion = state.updateInfo.current_version || state.updateInfo.currentVersion || state.updateInfo.version;
    pill.hidden = false;
    pill.textContent = `更新 ${latestVersion}`;
    pill.title = state.updateInfo.notes || "发现可用更新";
    return;
  }
  if (state.updateStatus === "checking") {
    pill.hidden = false;
    pill.textContent = "检查更新…";
    pill.title = "正在检查 Homebrew 更新";
    return;
  }
  if (state.updateStatus === "error") {
    pill.hidden = false;
    pill.textContent = "更新检查失败";
    pill.title = state.updateError || "更新检查失败";
    return;
  }
  pill.hidden = true;
}

async function checkForUpdates({ manual = false } = {}) {
  const cfg = loadUpdateConfig();
  const status = $("update-status");
  if (!cfg.cask) {
    if (manual && status) {
      status.textContent = "请先填写 Cask 名称";
    }
    return null;
  }
  if (state.isCheckingUpdate) return state.updateInfo;
  state.isCheckingUpdate = true;
  state.updateStatus = "checking";
  state.updateError = "";
  renderUpdatePill();
  if (manual && status) status.textContent = "检查中…";
  try {
    const update = await invoke("check_homebrew_update", { cask: cfg.cask });
    state.updateInfo = update;
    state.updateStatus = update ? "available" : "idle";
    renderUpdateBanner();
    if (update) {
      const lastNotified = localStorage.getItem("mrkit.update.notifiedVersion");
      const latestVersion = update.current_version || update.currentVersion || update.version;
      if (manual || lastNotified !== latestVersion) {
        await notifyUser("MR Kit：发现新版本", `${latestVersion} ${update.version ? "可升级" : "可安装"}`);
        localStorage.setItem("mrkit.update.notifiedVersion", latestVersion);
      }
      if (status) status.textContent = update.version ? `发现 ${latestVersion}` : `可安装 ${latestVersion}`;
    } else if (manual && status) {
      status.textContent = "已经是最新版本";
    }
    return update;
  } catch (e) {
    state.updateStatus = "error";
    state.updateError = String(e);
    renderUpdatePill();
    if (status) status.textContent = String(e);
    return null;
  } finally {
    state.isCheckingUpdate = false;
    renderUpdatePill();
    if (manual && status) {
      setTimeout(() => {
        if (state.updateStatus !== "error") status.textContent = "";
      }, 2500);
    }
  }
}

async function installUpdate() {
  if (!state.updateInfo || state.isInstallingUpdate) return;
  const cfg = loadUpdateConfig();
  if (!cfg.cask) {
    setError("请先填写 Cask 名称");
    return;
  }
  state.isInstallingUpdate = true;
  renderUpdateBanner();
  try {
    await invoke("install_homebrew_update", { cask: cfg.cask });
  } catch (e) {
    setError(String(e));
    state.isInstallingUpdate = false;
    renderUpdateBanner();
  }
}

/* ---------- 设置页 ---------- */

function renderSettings() {
  const cfg = loadAiConfig();
  const dingtalk = loadDingtalkConfig();
  const dingtalkDefaults = state.dingtalkDefaults || {};
  const update = loadUpdateConfig();
  $("target-branches").value = state.targetBranches.join("\n");
  $("ai-provider").value = cfg.provider || "claude";
  $("custom-base").value = cfg.custom?.baseUrl || "";
  $("custom-key").value = cfg.custom?.apiKey || "";
  $("custom-model").value = cfg.custom?.model || "";
  $("dingtalk-webhook").value = dingtalk.webhook || dingtalkDefaults.webhook || "";
  $("update-cask").value = update.cask;
  updateProviderFields();
}

function showSettingsPage(page) {
  document.querySelectorAll("[data-settings-page]").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.settingsPage === page);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== page;
  });
}

function updateProviderFields() {
  const p = $("ai-provider").value;
  document.querySelectorAll(".provider-fields").forEach((el) => {
    el.hidden = el.dataset.provider !== p;
  });
}

function saveSettings() {
  const cfg = {
    provider: $("ai-provider").value,
    custom: {
      baseUrl: $("custom-base").value.trim(),
      apiKey: $("custom-key").value.trim(),
      model: $("custom-model").value.trim(),
    },
  };
  localStorage.setItem("mrkit.ai", JSON.stringify(cfg));
  localStorage.setItem(
    "mrkit.dingtalk",
    JSON.stringify({
      webhook: $("dingtalk-webhook").value.trim(),
    })
  );
  saveTargetBranches(parseTargetBranches($("target-branches").value));
  saveUpdateConfig({
    cask: $("update-cask").value.trim(),
  });
  renderTargets();
  const status = $("settings-status");
  const generalStatus = $("general-status");
  const dingtalkStatus = $("dingtalk-status");
  const updateStatus = $("update-status");
  for (const el of [status, generalStatus, dingtalkStatus, updateStatus]) {
    if (!el) continue;
    el.textContent = "已保存";
    setTimeout(() => (el.textContent = ""), 1500);
  }
}

function openSettings() {
  renderSettings();
  showSettingsPage("general");
  $("settings").hidden = false;
}

function closeSettings() {
  $("settings").hidden = true;
}

/** Claude/Codex 由后端读取本机配置；自定义渠道走 API。 */
function effectiveAiConfig() {
  const cfg = loadAiConfig();
  const provider = cfg.provider || "claude";
  if (provider === "claude" || provider === "openai") {
    return { provider, baseUrl: "", apiKey: "", model: "" };
  }
  const custom = cfg.custom || {};
  const baseUrl = custom.baseUrl || "";
  const apiKey = custom.apiKey || "";
  const model = custom.model || "";
  if (!apiKey || !baseUrl || !model) {
    openSettings();
    showSettingsPage("ai");
    setError("请先在设置中完成自定义 AI 渠道配置");
    return null;
  }
  return { provider, baseUrl, apiKey, model };
}

function effectiveDingtalkConfig() {
  const cfg = loadDingtalkConfig();
  const defaults = state.dingtalkDefaults || {};
  const webhook = String(cfg.webhook || defaults.webhook || "").trim();
  const userIds = [...state.dingtalkRecipients];
  if (!webhook) return null;
  return { webhook, userIds: userIds.filter(Boolean) };
}

async function aiTitle() {
  if (!state.dir) return;
  const btn = $("btn-ai-title");
  btn.disabled = true;
  btn.textContent = "生成中…";
  setError("");
  try {
    const title = await generateStagedAiTitle();
    $("mr-title").value = title.slice(0, 72);
  } catch (e) {
    setError("AI 标题失败: " + e);
  } finally {
    btn.disabled = false;
    btn.textContent = "AI 标题";
  }
}

async function generateStagedAiTitle() {
  const config = effectiveAiConfig();
  if (!config) {
    throw new Error("请先完成 AI 渠道配置");
  }
  const title = await invoke("ai_title", { path: state.dir, config });
  return title.slice(0, 72);
}

async function autoCommitDirtyChanges(source, status) {
  if (!state.info?.dirty_count) return "";
  if (source !== state.info.branch) {
    throw new Error("当前工作区有未提交改动，请选择当前分支作为源分支后再发起 MR");
  }

  status.textContent = "暂存改动…";
  await invoke("stage_all", { path: state.dir });

  status.textContent = "AI 生成提交标题…";
  const title = await generateStagedAiTitle();
  $("mr-title").value = title;

  status.textContent = "提交改动…";
  await invoke("commit_staged", { path: state.dir, title });
  await refresh();
  return title;
}

async function pushCurrentSourceIfNeeded(source, status) {
  if (source !== state.info?.branch) return;
  if (state.info.has_upstream && state.info.ahead === 0) return;

  status.textContent = "推送源分支…";
  await invoke("push_branch", {
    path: state.dir,
    remote: state.info.remote_name || "origin",
    branch: source,
  });
  await refresh();
}

function transcriptItem(target, ok, url, output) {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "fail";
  const link = url
    ? `<a href="#" data-url="${esc(url)}">${esc(url)}</a><button class="copy-link" data-copy-url="${esc(url)}">复制</button>`
    : "";
  const note = ok && output ? `<span class="skip-text">${esc(output)}</span>` : "";
  const copyError =
    !ok && output ? `<button class="copy-link" data-copy-error="${esc(output)}">复制错误</button>` : "";
  const detail = !ok && !url && output ? `<pre>${esc(output)}</pre>` : "";
  li.innerHTML = `<span class="mark">${ok ? "✓" : "✗"}</span><b>${esc(target)}</b>${link}${note}${copyError}${detail}`;
  return li;
}

function transcriptNotice(label, ok, text) {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "skip";
  li.innerHTML = `<span class="mark">${ok ? "✓" : "•"}</span><b>${esc(label)}</b><span class="skip-text">${esc(text)}</span>`;
  return li;
}

async function notifyApprover(target, source, title, url) {
  const config = effectiveDingtalkConfig();
  if (!config) {
    return { ok: false, text: `未配置钉钉 webhook，未通知 ${DEFAULT_RELEASE_APPROVER}` };
  }
  if (!config.userIds.length) {
    return { ok: false, text: "未选择钉钉联系人" };
  }
  try {
    const text = await invoke("notify_dingtalk_approval", {
      config,
      target,
      source,
      title,
      url,
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

async function handleMrAction(btn) {
  if (!state.dir) return;
  const action = btn.dataset.mrAction;
  const iid = btn.dataset.iid;
  if (!iid) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === "approve" ? "通过中…" : "关闭中…";
  setError("");
  try {
    await invoke(action === "approve" ? "approve_mr" : "close_mr", {
      path: state.dir,
      iid,
    });
    await refreshBranchMrs(state.info?.branch);
  } catch (e) {
    setError(String(e));
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function createMrs() {
  if (state.isCreating) return;
  setError("");
  const results = $("mr-results");
  const status = $("create-status");

  if (state.targets.size === 0) {
    setError("请先点亮至少一个目标分支");
    return;
  }
  const source = $("source-branch").value;
  if (!source) {
    setError("没有可用的源分支");
    return;
  }

  setCreating(true);
  status.textContent = "准备创建…";
  results.innerHTML = "";
  await notifyUser("MR Kit：开始创建", `正在发起 ${state.targets.size} 条 MR`);
  let created = 0;
  let failed = 0;
  let skipped = 0;
  const createdUrls = [];
  const failureDetails = [];

  try {
    await autoCommitDirtyChanges(source, status);
    await pushCurrentSourceIfNeeded(source, status);

    let title = $("mr-title").value.trim();
    if (!title) {
      await suggestTitle();
      title = $("mr-title").value.trim();
    }
    if (!title) {
      throw new Error("请填写 MR 标题，或点击「AI 标题」生成");
    }

    const targets = [...state.targets];
    const remote = state.info.remote_name || "origin";
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      status.textContent = `${target} (${i + 1}/${targets.length})…`;
      // 预检：目标..源 无提交差异则跳过，不让 glab 报错
      try {
        const commits = await invoke("commits_between", { path: state.dir, remote, target, source });
        if (commits.length === 0) {
          const li = document.createElement("li");
          li.className = "skip";
          li.innerHTML = `<span class="mark">•</span><b>${esc(target)}</b><span class="skip-text">与 ${esc(remote)}/${esc(target)} 无提交差异，跳过</span>`;
          results.appendChild(li);
          skipped += 1;
          continue;
        }
      } catch (_) {
        // 预检失败不拦截，交给 glab 判断
      }
      try {
        const r = await invoke("create_mr", { path: state.dir, source, target, title });
        results.appendChild(transcriptItem(target, r.ok, r.url, r.output));
        if (r.ok) {
          created += 1;
          if (r.url) createdUrls.push(r.url);
          if (target !== "us-develop") {
            const notice = await notifyApprover(target, source, title, r.url);
            results.appendChild(transcriptNotice("钉钉", notice.ok, notice.text));
            if (!notice.ok) {
              failureDetails.push(`钉钉: ${notice.text}`);
            }
          }
        } else {
          failed += 1;
          failureDetails.push(failureDetail(target, r.output));
        }
      } catch (e) {
        const message = String(e);
        results.appendChild(transcriptItem(target, false, "", message));
        failed += 1;
        failureDetails.push(failureDetail(target, message));
      }
    }
    const detail = [
      created ? `${created} 条 MR 已就绪` : "",
      skipped ? `${skipped} 条跳过` : "",
      failed ? `${failed} 条失败` : "",
    ]
      .filter(Boolean)
      .join("，");
    const copied = await copyText(createdUrls.join("\n"));
    let copyHint = createdUrls.length ? (copied ? "，链接已复制" : "，链接复制失败") : "";
    if (failed && !createdUrls.length && failureDetails.length) {
      const copiedErrors = await copyText(failureDetails.join("\n\n"));
      copyHint = copiedErrors ? "，错误详情已复制" : "";
    }
    const failureHint = failureDetails.length ? `\n${failureDetails[0]}` : "";
    if (failureDetails.length) {
      setError(failureDetails[0]);
    }
    await refreshBranchMrs(source);
    await notifyUser(
      failed ? "MR Kit：创建完成，有失败" : "MR Kit：创建完成",
      `${detail || "没有可创建的 MR"}${copyHint}${failureHint}`
    );
  } catch (e) {
    const message = String(e);
    setError(message);
    const copied = await copyText(message);
    await notifyUser("MR Kit：创建失败", copied ? compactError(message) : "操作失败，请回到 MR Kit 查看详情");
  } finally {
    status.textContent = "";
    setCreating(false);
  }
}

/* ---------- 事件绑定 ---------- */

window.addEventListener("DOMContentLoaded", async () => {
  await loadDingtalkDefaults();

  $("btn-add-repo").addEventListener("click", pickDir);
  $("btn-remove-repo").addEventListener("click", removeRepo);
  $("btn-pick-empty").addEventListener("click", pickDir);
  $("repo-select").addEventListener("change", (e) => switchRepo(e.target.value));
  $("dingtalk-contacts").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-dingtalk-user]");
    if (btn) toggleDingtalkContact(btn.dataset.dingtalkUser);
  });
  $("btn-refresh").addEventListener("click", refresh);
  $("btn-fetch").addEventListener("click", doFetch);
  $("btn-ai-title").addEventListener("click", aiTitle);
  $("btn-pin-desktop").addEventListener("click", () => setDesktopPinned(true));
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-settings-close").addEventListener("click", closeSettings);
  $("btn-general-save").addEventListener("click", saveSettings);
  $("btn-settings-save").addEventListener("click", saveSettings);
  $("btn-dingtalk-save").addEventListener("click", saveSettings);
  $("btn-update-save").addEventListener("click", saveSettings);
  $("btn-update-check").addEventListener("click", async () => {
    saveSettings();
    await checkForUpdates({ manual: true });
  });
  $("topbar-update").addEventListener("click", () => {
    if (state.updateInfo) {
      installUpdate();
    } else {
      openSettings();
      showSettingsPage("update");
    }
  });
  $("btn-update-install").addEventListener("click", installUpdate);
  $("btn-update-dismiss").addEventListener("click", () => {
    state.updateInfo = null;
    renderUpdateBanner();
  });
  $("ai-provider").addEventListener("change", updateProviderFields);
  $("btn-create").addEventListener("click", createMrs);
  $("source-branch").addEventListener("change", () => {
    renderCompact();
    syncTrayContext();
  });
  $("compact-repo-select").addEventListener("change", (e) => switchRepo(e.target.value));
  $("compact-create").addEventListener("click", createMrs);
  $("compact-expand").addEventListener("click", () => setDesktopPinned(false));
  $("compact-hide").addEventListener("click", hideCompactWidget);
  $("compact-targets").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-compact-target]");
    if (btn) toggleTargetByName(btn.dataset.compactTarget);
  });

  document.querySelectorAll("[data-settings-page]").forEach((btn) => {
    btn.addEventListener("click", () => showSettingsPage(btn.dataset.settingsPage));
  });

  document.querySelectorAll("[data-theme-value]").forEach((btn) => {
    btn.addEventListener("click", () => setThemePref(btn.dataset.themeValue));
  });
  document.querySelectorAll("[data-skin-value]").forEach((btn) => {
    btn.addEventListener("click", () => setSkinPref(btn.dataset.skinValue));
  });
  document.querySelectorAll("[data-doodle-color]").forEach((btn) => {
    btn.addEventListener("click", () => setDoodleColor(btn.dataset.doodleColor));
  });
  $("btn-doodle-toggle").addEventListener("click", () => setDoodleEnabled(!state.doodleEnabled));
  $("btn-doodle-clear").addEventListener("click", clearDoodle);
  document.addEventListener("pointerdown", startDoodle, true);
  document.addEventListener("pointermove", moveDoodle, true);
  window.addEventListener("pointerup", stopDoodle, true);
  window.addEventListener("pointercancel", stopDoodle, true);
  window.addEventListener("resize", resizeDoodleCanvas);
  applyTheme();
  applyDoodleState();

  $("target-rails").addEventListener("click", (e) => {
    const btn = e.target.closest(".rail[data-target]");
    if (btn) toggleTarget(btn);
  });

  $("branch-mrs").addEventListener("click", (e) => {
    const actionBtn = e.target.closest("button[data-mr-action]");
    if (actionBtn) {
      e.preventDefault();
      handleMrAction(actionBtn);
      return;
    }

    const btn = e.target.closest("button[data-url]");
    if (!btn?.dataset.url) return;
    e.preventDefault();
    invoke("open_url", { url: btn.dataset.url });
  });

  listen("mrkit:switch-repo", (event) => {
    const dir = getRepos()[Number(event.payload)];
    if (dir) switchRepo(dir);
  });
  listen("mrkit:toggle-target", (event) => toggleTargetByName(String(event.payload || "")));
  listen("mrkit:repo-changed", () => {
    // 创建 MR 过程中不打断；结束后下一次变化仍会触发
    if (!state.isCreating) refresh();
  });
  listen("mrkit:create-mr", () => createMrs());
  listen("mrkit:desktop-pin-state", (event) => {
    state.desktopPinned = Boolean(event.payload);
    localStorage.setItem("mrkit.desktopPinned", state.desktopPinned ? "1" : "0");
    applyDesktopPinnedClass();
    syncTrayContext();
  });

  // MR 链接用系统浏览器打开
  $("mr-results").addEventListener("click", (e) => {
    const copy = e.target.closest("button[data-copy-url]");
    if (copy) {
      e.preventDefault();
      copyText(copy.dataset.copyUrl).then((ok) => {
        copy.textContent = ok ? "已复制" : "复制失败";
        setTimeout(() => (copy.textContent = "复制"), 1200);
      });
      return;
    }

    const copyError = e.target.closest("button[data-copy-error]");
    if (copyError) {
      e.preventDefault();
      copyText(copyError.dataset.copyError).then((ok) => {
        copyError.textContent = ok ? "已复制" : "复制失败";
        setTimeout(() => (copyError.textContent = "复制错误"), 1200);
      });
      return;
    }

    const a = e.target.closest("a[data-url]");
    if (a) {
      e.preventDefault();
      invoke("open_url", { url: a.dataset.url });
    }
  });

  // 恢复仓库列表与上次选中的仓库
  const last = localStorage.getItem("mrkit.dir");
  const repos = getRepos();
  if (last && !repos.includes(last)) {
    repos.push(last);
    saveRepos(repos);
  }
  const initial = last || repos[0];
  if (initial) {
    state.dir = initial;
    state.targets = loadTargets(initial);
    state.dingtalkRecipients = loadDingtalkRecipients(initial);
    refresh();
  } else {
    renderRepoSelect();
    renderTargets();
    syncTrayContext();
    checkGlab();
  }
  applyDesktopPinnedClass();
  if (state.desktopPinned) {
    setDesktopPinned(true);
  }
  setTimeout(() => checkForUpdates(), 1200);
  setInterval(() => checkForUpdates(), 1000 * 60 * 60 * 4);
});
