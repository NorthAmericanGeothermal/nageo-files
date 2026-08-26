// NAGeo Files — app.js (Supabase-backed — replaces the old Cloudflare Worker)
const SUPABASE_URL = "https://hpgwwegjsxyxovdattoc.supabase.co";
const SUPABASE_KEY = "sb_publishable_D2PqYQoJjZ8koEM9NPvmeg_KB_Wa66H";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const HCP_CUSTOMERS_URL = SUPABASE_URL + "/functions/v1/nageo-files-hcp-customers";
const SEARCH_EMAILS_URL = SUPABASE_URL + "/functions/v1/nageo-files-search-emails";
const STORAGE_BUCKET = "nageo-files-documents";
const REG_KEY = "nageo_files_reg";
// Same shared Gmail OAuth app + redirect used by NAGeo GRECs' "Connect Gmail"
// button — connecting here adds to the exact same gmail_accounts pool, so an
// account connected from Files shows up in GRECs/Leads too, and vice versa.
const GOOGLE_CLIENT_ID = "924555050056-jp3k8vpo89tb14vfghjqefrb1aaik21e.apps.googleusercontent.com";
const GOOGLE_OAUTH_REDIRECT_URI = SUPABASE_URL + "/functions/v1/lead-gmail-oauth";
// gmail_accounts.rep_id is a uuid column with a foreign key into `reps` —
// lead-gmail-oauth's callback writes whatever comes back as `state` straight
// into it, so a made-up UUID isn't enough, it has to be a real rep's id.
// Files doesn't have per-user logins/real reps, so every account connected
// from this tool gets tagged with this one existing rep's id (Michael's,
// from an already-connected gmail_accounts row) — purely as a placeholder
// FK target, not an access restriction: every tool still searches the whole
// shared pool regardless of which rep_id an account is tagged with.
const NAGEO_FILES_PLACEHOLDER_REP_ID = "3edad42d-01ff-4f58-b8e3-53e4ef634f68";
// Name of the protected, auto-created folder each customer gets the first
// time a saved search email needs somewhere to live. Locked — the app
// blocks renaming/deleting/moving it or its contents, and blocks manual
// uploads/new-folders inside it. See getOrCreateEmailsFolder / saveEmailsToFolder.
const EMAILS_FOLDER_NAME = "📧 Emails";
// ── STATE ──
let regCode = localStorage.getItem(REG_KEY) || "";
let allCustomers = [];
let filteredCustomers = [];
let currentCustomer = null;
let currentFolderId = null;
let currentFolderIsSystem = false; // true while viewing inside the locked Emails folder
let breadcrumbs = []; // [{id, name, isSystem}]
let ctxTarget = null; // {type:'folder'|'file', data}
let renameTarget = null;
let deleteTarget = null;
let searchTimer = null;
// Bulk select state
let selectMode = false;
let selectedItems = new Map(); // key "folder:id" or "file:id" -> {type, data}
let lastFolders = [];
let lastFiles = [];
// Drag & drop move state
let dragData = null; // {type, id, name}
// ── INIT ──
document.addEventListener("DOMContentLoaded", () => {
  if (regCode) {
    showApp();
  } else {
    showReg();
  }
  wireEvents();
});
function wireEvents() {
  // Registration
  document.getElementById("regBtn").addEventListener("click", tryRegister);
  document.getElementById("regInput").addEventListener("keydown", e => { if (e.key === "Enter") tryRegister(); });
  document.getElementById("regInput").addEventListener("input", function() {
    // Auto-format as user types
    let v = this.value.replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
    this.value = v;
  });
  // Global settings (Gmail accounts + Sync All Customers) — available from
  // anywhere in the app, not tied to any particular customer.
  document.getElementById("globalSettingsBtn").addEventListener("click", openGlobalSettingsModal);
  document.getElementById("connectGmailBtn").addEventListener("click", connectGmailAccount);
  document.getElementById("refreshGmailPoolBtn").addEventListener("click", loadGmailPool);
  document.getElementById("sweepAllBtn").addEventListener("click", startSweepAllCustomers);
  document.getElementById("sweepStopBtn").addEventListener("click", function () { sweepCancelled = true; });
  // Sign out
  document.getElementById("signOutBtn").addEventListener("click", () => {
    if (confirm("This will sign out this device. You'll need the registration code again.")) {
      localStorage.removeItem(REG_KEY);
      location.reload();
    }
  });
  // Hamburger (mobile)
  document.getElementById("hamburgerBtn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
  // Customer search
  document.getElementById("customerSearch").addEventListener("input", function() {
    filterCustomers(this.value);
  });
  // Global search
  document.getElementById("globalSearch").addEventListener("input", function() {
    clearTimeout(searchTimer);
    const q = this.value.trim();
    if (!q) { hideSearchResults(); return; }
    searchTimer = setTimeout(() => globalSearch(q), 300);
  });
  document.addEventListener("click", e => {
    if (!e.target.closest("#globalSearch") && !e.target.closest("#searchResults")) {
      hideSearchResults();
    }
  });
  // New folder
  document.getElementById("newFolderBtn").addEventListener("click", () => openModal("modalNewFolder"));
  document.getElementById("newFolderName").addEventListener("keydown", e => { if (e.key === "Enter") createFolder(); });
  document.getElementById("createFolderBtn").addEventListener("click", createFolder);
  // Upload
  document.getElementById("uploadBtn").addEventListener("click", () => document.getElementById("fileInput").click());
  document.getElementById("fileInput").addEventListener("change", function() {
    if (this.files.length) uploadFiles(Array.from(this.files));
    this.value = "";
  });
  // Camera
  document.getElementById("cameraBtn").addEventListener("click", () => document.getElementById("cameraInput").click());
  document.getElementById("cameraInput").addEventListener("change", function() {
    if (this.files.length) uploadFiles(Array.from(this.files));
    this.value = "";
  });
  // Bulk select
  document.getElementById("selectModeBtn").addEventListener("click", toggleSelectMode);
  document.getElementById("selectAllBtn").addEventListener("click", selectAllInView);
  document.getElementById("selectCancelBtn").addEventListener("click", () => { if (selectMode) toggleSelectMode(); });
  document.getElementById("selectDownloadBtn").addEventListener("click", bulkDownloadSelected);
  document.getElementById("selectDeleteBtn").addEventListener("click", confirmBulkDelete);
  // Search emails
  document.getElementById("searchEmailBtn").addEventListener("click", openSearchEmailsModal);
  document.getElementById("searchEmailsAddBtn").addEventListener("click", addSearchEmail);
  document.getElementById("searchEmailsAddInput").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addSearchEmail(); } });
  document.getElementById("searchEmailsGoBtn").addEventListener("click", function () { startEmailSearch(); });
  document.getElementById("searchEmailsStopBtn").addEventListener("click", function () { emailSearchCancelled = true; });
  // Drag and drop (file system → upload)
  const fc = document.getElementById("fileContent");
  fc.addEventListener("dragover", e => { e.preventDefault(); document.getElementById("dropOverlay").classList.add("active"); });
  fc.addEventListener("dragleave", e => { if (!fc.contains(e.relatedTarget)) document.getElementById("dropOverlay").classList.remove("active"); });
  fc.addEventListener("drop", e => {
    e.preventDefault();
    document.getElementById("dropOverlay").classList.remove("active");
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files);
  });
  // Context menu actions
  document.getElementById("ctxOpen").addEventListener("click", () => {
    if (!ctxTarget) return;
    closeCtx();
    if (ctxTarget.type === "folder") openFolder(ctxTarget.data);
    else previewFile(ctxTarget.data);
  });
  document.getElementById("ctxPreview").addEventListener("click", () => {
    if (!ctxTarget || ctxTarget.type !== "file") return;
    closeCtx(); previewFile(ctxTarget.data);
  });
  document.getElementById("ctxDownload").addEventListener("click", () => {
    if (!ctxTarget || ctxTarget.type !== "file") return;
    closeCtx(); downloadFile(ctxTarget.data);
  });
  document.getElementById("ctxRename").addEventListener("click", () => {
    if (!ctxTarget) return;
    const d = ctxTarget.data; const t = ctxTarget.type;
    closeCtx();
    renameTarget = { type: t, data: d };
    document.getElementById("renameInput").value = d.name;
    openModal("modalRename");
    setTimeout(() => { document.getElementById("renameInput").select(); }, 100);
  });
  document.getElementById("ctxDelete").addEventListener("click", () => {
    if (!ctxTarget) return;
    const d = ctxTarget.data; const t = ctxTarget.type;
    closeCtx();
    deleteTarget = { type: t, data: d };
    document.getElementById("deleteMsg").textContent =
      t === "folder"
        ? `Delete the folder "${d.name}" and ALL files inside it? This cannot be undone.`
        : `Delete the file "${d.name}"? This cannot be undone.`;
    openModal("modalDelete");
  });
  document.getElementById("renameInput").addEventListener("keydown", e => { if (e.key === "Enter") doRename(); });
  document.getElementById("renameOkBtn").addEventListener("click", doRename);
  document.getElementById("deleteOkBtn").addEventListener("click", doDelete);
  // Close ctx on outside click
  document.addEventListener("click", e => {
    if (!e.target.closest("#ctxMenu")) closeCtx();
  });
}
// ── REGISTRATION ──
async function tryRegister() {
  const input = document.getElementById("regInput").value.trim().toUpperCase();
  document.getElementById("regErr").style.display = "none";
  document.getElementById("regBtn").textContent = "Checking…";
  document.getElementById("regBtn").disabled = true;
  try {
    const { data, error } = await sb.from("nageo_files_settings").select("registration_code").eq("id", 1).single();
    if (error) throw error;
    if (data && data.registration_code === input) {
      localStorage.setItem(REG_KEY, "true");
      regCode = "true";
      showApp();
    } else {
      document.getElementById("regErr").textContent = "❌ That code isn't right. Please try again or ask your manager.";
      document.getElementById("regErr").style.display = "block";
    }
  } catch (e) {
    document.getElementById("regErr").textContent = "❌ Can't connect to server. Check your internet and try again.";
    document.getElementById("regErr").style.display = "block";
  } finally {
    document.getElementById("regBtn").textContent = "Unlock This Device";
    document.getElementById("regBtn").disabled = false;
  }
}
function showReg() {
  document.getElementById("regScreen").style.display = "flex";
  document.getElementById("app").classList.remove("visible");
}
function showApp() {
  document.getElementById("regScreen").style.display = "none";
  document.getElementById("app").classList.add("visible");
  loadCustomers();
}
// ── CUSTOMERS ──
async function loadCustomers() {
  document.getElementById("customerList").innerHTML = '<div class="sidebar-msg">Loading customers from HCP…<br><small style="opacity:.6">This may take a moment</small></div>';
  try {
    const res = await fetch(HCP_CUSTOMERS_URL, {
      headers: { "Authorization": "Bearer " + SUPABASE_KEY, "apikey": SUPABASE_KEY },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    let all = data.customers || [];
    all.sort((a, b) => a.name.localeCompare(b.name));
    allCustomers = all;
    filteredCustomers = all;
    renderCustomerList(all);
  } catch (e) {
    document.getElementById("customerList").innerHTML = `<div class="sidebar-msg">❌ Could not load customers.<br><small>${e.message}</small><br><br><button onclick="loadCustomers()" style="padding:8px 16px;background:var(--blue);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;">Try Again</button></div>`;
  }
}
function customerTagFor(customerId) {
  const c = allCustomers.find(x => x.id === customerId);
  return c ? c.customer_id : customerId;
}
function filterCustomers(q) {
  if (!q.trim()) {
    filteredCustomers = allCustomers;
    renderCustomerList(allCustomers);
    return;
  }
  const lq = q.toLowerCase();
  filteredCustomers = allCustomers.filter(c =>
    c.name.toLowerCase().includes(lq) ||
    c.customer_id.includes(lq) ||
    c.address.toLowerCase().includes(lq) ||
    c.email.toLowerCase().includes(lq) ||
    c.phone.includes(lq)
  );
  renderCustomerList(filteredCustomers);
}
function renderCustomerList(customers) {
  const el = document.getElementById("customerList");
  if (!customers.length) {
    el.innerHTML = '<div class="sidebar-msg">No customers found.<br><small>Try a different search term.</small></div>';
    return;
  }
  el.innerHTML = customers.map(c => `
    <div class="customer-item${currentCustomer && currentCustomer.id === c.id ? ' active' : ''}" onclick="selectCustomer('${c.id}')">
      <div class="customer-avatar">${initials(c.name)}</div>
      <div class="customer-info">
        <div class="customer-name">${esc(c.name)}</div>
        <div class="customer-meta">#${esc(c.customer_id)}${c.address ? ' · ' + esc(c.address) : ''}</div>
      </div>
    </div>
  `).join("");
}
function selectCustomer(id) {
  const c = allCustomers.find(x => x.id === id);
  if (!c) return;
  currentCustomer = c;
  currentFolderId = null;
  currentFolderIsSystem = false;
  breadcrumbs = [];
  exitSelectMode();
  renderCustomerList(filteredCustomers); // refresh active state
  document.getElementById("emptyState").style.display = "none";
  document.getElementById("fileBrowser").classList.add("show");
  document.getElementById("fcName").textContent = c.name;
  document.getElementById("fcMeta").textContent = `#${c.customer_id}${c.address ? ' · ' + c.address : ''}`;
  // Close sidebar on mobile
  document.getElementById("sidebar").classList.remove("open");
  loadFileView();
}
// ── FILE BROWSER ──
async function loadFileView() {
  renderBreadcrumb();
  updateSystemFolderUI();
  selectedItems.clear();
  updateSelectBar();
  document.getElementById("fileContent").innerHTML = `
    <div class="drop-overlay" id="dropOverlay">
      <div class="drop-overlay-big">📂</div>
      <div class="drop-overlay-text">Drop files here to upload</div>
    </div>
    <div style="padding:2rem;text-align:center;color:var(--text3);">Loading…</div>
  `;
  rewireDrop();
  try {
    let foldersQuery = sb.from("nageo_files_folders").select("*").eq("customer_id", currentCustomer.id);
    let filesQuery = sb.from("nageo_files_files").select("*").eq("customer_id", currentCustomer.id);
    if (currentFolderId) {
      foldersQuery = foldersQuery.eq("parent_id", currentFolderId);
      filesQuery = filesQuery.eq("folder_id", currentFolderId);
    } else {
      foldersQuery = foldersQuery.is("parent_id", null);
      filesQuery = filesQuery.is("folder_id", null);
    }
    const [foldersRes, filesRes] = await Promise.all([
      foldersQuery.order("name"),
      filesQuery.order("name"),
    ]);
    if (foldersRes.error) throw foldersRes.error;
    if (filesRes.error) throw filesRes.error;
    lastFolders = foldersRes.data || [];
    lastFiles = filesRes.data || [];
    renderFileView(lastFolders, lastFiles);
  } catch (e) {
    document.getElementById("fileContent").innerHTML = `<div style="padding:2rem;text-align:center;color:var(--red);">❌ Could not load files.<br><small>${e.message}</small></div>`;
  }
}
function renderFileView(folders, files) {
  const el = document.getElementById("fileContent");
  el.classList.toggle("select-mode", selectMode);
  let html = `
    <div class="drop-overlay" id="dropOverlay">
      <div class="drop-overlay-big">📂</div>
      <div class="drop-overlay-text">Drop files here to upload</div>
    </div>
  `;
  if (!folders.length && !files.length) {
    html += `
      <div class="folder-empty-area">
        <div class="folder-empty-icon">📂</div>
        <div class="folder-empty-strong">This folder is empty</div>
        <div class="folder-empty-p">Tap <strong>📁 New Folder</strong> to create a folder,<br>or <strong>⬆️ Upload Files</strong> to add files here.</div>
      </div>
    `;
    el.innerHTML = html;
    rewireDrop();
    return;
  }
  if (folders.length) {
    html += `<div class="section-label">📁 Folders</div><div class="file-grid">`;
    folders.forEach(f => {
      const key = "folder:" + f.id;
      const selected = selectedItems.has(key);
      const dataAttr = JSON.stringify(f).replace(/"/g,'&quot;');
      const isSys = !!f.is_system;
      const clickHandler = (selectMode && !isSys)
        ? `toggleItemSelect('folder', ${dataAttr})`
        : `openFolder(${dataAttr})`;
      // System folder: not draggable, and not a drop target either — omitting
      // the drag/drop attrs entirely means the browser just refuses drops on
      // it by default, which is exactly the "can't be modified" behavior we want.
      const dragAttrs = (selectMode || isSys) ? '' : `draggable="true" ondragstart="handleDragStart(event,'folder',${dataAttr})" ondragend="handleDragEnd(event)" ondragover="handleDragOverFolder(event,${dataAttr})" ondragleave="handleDragLeaveCard(event)" ondrop="handleDropOnFolder(event,${dataAttr})"`;
      html += `
        <div class="folder-card${selected ? ' card-selected' : ''}${isSys ? ' folder-card-system' : ''}" ${dragAttrs} onclick="${clickHandler}">
          ${(selectMode && !isSys) ? `<div class="card-checkbox${selected ? ' checked' : ''}"></div>` : ''}
          <div class="card-icon">📁</div>
          <div class="card-name">${esc(f.name)}</div>
          ${isSys ? `<span class="card-system-badge" title="Auto-synced from Search Emails — protected, can't be renamed, moved, or deleted">🔒</span>` : (selectMode ? '' : `<button class="card-menu" onclick="event.stopPropagation();showCtx(event,'folder',${dataAttr})">⋯</button>`)}
        </div>
      `;
    });
    html += `</div>`;
  }
  if (files.length) {
    html += `<div class="section-label">📄 Files</div><div class="file-grid">`;
    files.forEach(f => {
      const key = "file:" + f.id;
      const selected = selectedItems.has(key);
      const dataAttr = JSON.stringify(f).replace(/"/g,'&quot;');
      const isSys = currentFolderIsSystem; // files inside the locked Emails folder are protected too
      const clickHandler = (selectMode && !isSys)
        ? `toggleItemSelect('file', ${dataAttr})`
        : `previewFile(${dataAttr})`;
      const dragAttrs = (selectMode || isSys) ? '' : `draggable="true" ondragstart="handleDragStart(event,'file',${dataAttr})" ondragend="handleDragEnd(event)"`;
      html += `
        <div class="file-card${selected ? ' card-selected' : ''}${isSys ? ' folder-card-system' : ''}" ${dragAttrs} onclick="${clickHandler}">
          ${(selectMode && !isSys) ? `<div class="card-checkbox${selected ? ' checked' : ''}"></div>` : ''}
          <div class="card-icon">${fileIcon(f.name)}</div>
          <div class="card-name">${esc(f.name)}</div>
          <div class="card-meta">${formatSize(f.size)}</div>
          ${selectMode ? '' : `<button class="card-menu" onclick="event.stopPropagation();showCtx(event,'file',${dataAttr})">⋯</button>`}
        </div>
      `;
    });
    html += `</div>`;
  }
  el.innerHTML = html;
  rewireDrop();
}
function rewireDrop() {
  const fc = document.getElementById("fileContent");
  const ov = document.getElementById("dropOverlay");
  if (!ov) return;
  fc.addEventListener("dragover", e => { e.preventDefault(); if (!currentFolderIsSystem) ov.classList.add("active"); });
  fc.addEventListener("dragleave", e => { if (!fc.contains(e.relatedTarget)) ov.classList.remove("active"); });
  fc.addEventListener("drop", e => {
    e.preventDefault(); ov.classList.remove("active");
    if (currentFolderIsSystem) { toast("🔒 Files can't be added to the Emails folder by hand — it's filled automatically by Search Emails.", "err"); return; }
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files);
  });
}
// Hides New Folder / Upload / Take Photo while inside the locked Emails
// folder — that folder is only ever fed by saveEmailsToFolder().
function updateSystemFolderUI() {
  const hide = currentFolderIsSystem;
  ["newFolderBtn", "uploadBtn", "cameraBtn"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = hide ? "none" : "";
  });
}
// ── NAVIGATION ──
function openFolder(folder) {
  breadcrumbs.push({ id: currentFolderId, name: currentFolderId ? breadcrumbs[breadcrumbs.length-1]?.name : currentCustomer.name, isSystem: currentFolderIsSystem });
  currentFolderId = folder.id;
  currentFolderIsSystem = !!folder.is_system;
  loadFileView();
}
function navTo(idx) {
  // idx = -1 means root, 0..n means breadcrumb index
  if (idx < 0) {
    currentFolderId = null;
    currentFolderIsSystem = false;
    breadcrumbs = [];
  } else {
    const item = breadcrumbs[idx];
    currentFolderId = item.id;
    currentFolderIsSystem = !!item.isSystem;
    breadcrumbs = breadcrumbs.slice(0, idx);
  }
  loadFileView();
}
function renderBreadcrumb() {
  const el = document.getElementById("breadcrumb");
  let html = `<button class="bc-item${currentFolderId ? '' : ' cur'}" onclick="navTo(-1)" ondragover="handleDragOverCrumb(event)" ondragleave="handleDragLeaveCard(event)" ondrop="handleDropOnCrumb(event,null)">📁 ${esc(currentCustomer?.name || '')}</button>`;
  breadcrumbs.forEach((b, i) => {
    const tid = b.id == null ? 'null' : `'${b.id}'`;
    html += `<span class="bc-sep">›</span><button class="bc-item${i === breadcrumbs.length - 1 && currentFolderId ? ' cur' : ''}" onclick="navTo(${i})" ondragover="handleDragOverCrumb(event)" ondragleave="handleDragLeaveCard(event)" ondrop="handleDropOnCrumb(event,${tid})">${esc(b.name || 'Folder')}</button>`;
  });
  el.innerHTML = html;
}
// ── DRAG & DROP MOVE ──
function handleDragStart(evt, type, data) {
  if (selectMode) { evt.preventDefault(); return; }
  if (type === "folder" && data.is_system) { evt.preventDefault(); return; } // the Emails folder can't be dragged
  if (type === "file" && data.gmail_message_id) { evt.preventDefault(); return; } // saved emails can't be moved
  dragData = { type, id: data.id, name: data.name };
  evt.dataTransfer.effectAllowed = "move";
  evt.dataTransfer.setData("text/plain", String(data.id)); // Firefox requires data to be set to allow the drag
  evt.currentTarget.classList.add("dragging");
}
function handleDragEnd(evt) {
  evt.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
  dragData = null;
}
function handleDragOverFolder(evt, folderData) {
  if (!dragData) return;
  if (dragData.type === "folder" && dragData.id === folderData.id) return; // can't drop a folder into itself
  if (folderData.is_system) return; // can't drop anything into the locked Emails folder
  evt.preventDefault();
  evt.dataTransfer.dropEffect = "move";
  evt.currentTarget.classList.add("drop-target");
}
function handleDragLeaveCard(evt) {
  evt.currentTarget.classList.remove("drop-target");
}
async function handleDropOnFolder(evt, folderData) {
  evt.preventDefault();
  evt.currentTarget.classList.remove("drop-target");
  if (!dragData) return;
  if (dragData.type === "folder" && dragData.id === folderData.id) { dragData = null; return; }
  if (folderData.is_system) { dragData = null; toast("🔒 Can't move items into the protected Emails folder.", "err"); return; }
  const d = dragData; dragData = null;
  await moveItem(d.type, d.id, folderData.id);
}
function handleDragOverCrumb(evt) {
  if (!dragData) return;
  evt.preventDefault();
  evt.dataTransfer.dropEffect = "move";
  evt.currentTarget.classList.add("drop-target");
}
async function handleDropOnCrumb(evt, targetFolderId) {
  evt.preventDefault();
  evt.currentTarget.classList.remove("drop-target");
  if (!dragData) return;
  const d = dragData; dragData = null;
  await moveItem(d.type, d.id, targetFolderId);
}
async function moveItem(type, id, targetFolderId) {
  if (targetFolderId === currentFolderId) return; // dropped back where it already is — no-op
  try {
    // Live-checked guards — the authoritative source of truth for the Emails
    // folder's protection, independent of whatever the drag UI already
    // blocked client-side (belt and suspenders: the UI checks are just for
    // a snappier "no" without a round trip).
    if (targetFolderId) {
      const { data: tgt, error: tgtErr } = await sb.from("nageo_files_folders").select("is_system").eq("id", targetFolderId).single();
      if (tgtErr) throw tgtErr;
      if (tgt && tgt.is_system) { toast("🔒 Can't move items into the protected Emails folder.", "err"); return; }
    }
    if (type === "folder") {
      const { data: srcF, error: srcErr } = await sb.from("nageo_files_folders").select("is_system").eq("id", id).single();
      if (srcErr) throw srcErr;
      if (srcF && srcF.is_system) { toast("🔒 The Emails folder can't be moved.", "err"); return; }
    } else {
      const { data: srcFile, error: srcErr } = await sb.from("nageo_files_files").select("gmail_message_id").eq("id", id).single();
      if (srcErr) throw srcErr;
      if (srcFile && srcFile.gmail_message_id) { toast("🔒 Saved emails can't be moved.", "err"); return; }
    }
    const table = type === "folder" ? "nageo_files_folders" : "nageo_files_files";
    const col = type === "folder" ? "parent_id" : "folder_id";
    const { error } = await sb.from(table).update({ [col]: targetFolderId, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
    toast("✅ Moved", "ok");
    loadFileView();
  } catch (e) {
    toast("❌ Move failed: " + e.message, "err");
  }
}
// ── FOLDERS ──
async function createFolder() {
  const name = document.getElementById("newFolderName").value.trim();
  if (!name) { document.getElementById("newFolderName").focus(); return; }
  if (currentFolderIsSystem) { toast("🔒 Can't create folders inside the protected Emails folder.", "err"); closeModal("modalNewFolder"); return; }
  document.getElementById("createFolderBtn").textContent = "Creating…";
  document.getElementById("createFolderBtn").disabled = true;
  try {
    const { error } = await sb.from("nageo_files_folders").insert({
      customer_id: currentCustomer.id,
      parent_id: currentFolderId,
      name,
    });
    if (error) throw error;
    closeModal("modalNewFolder");
    document.getElementById("newFolderName").value = "";
    toast("📁 Folder created!", "ok");
    loadFileView();
  } catch (e) {
    toast("❌ " + e.message, "err");
  } finally {
    document.getElementById("createFolderBtn").textContent = "📁 Create Folder";
    document.getElementById("createFolderBtn").disabled = false;
  }
}
// ── UPLOAD ──
function randId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
async function uploadFiles(files) {
  if (!currentCustomer) return;
  if (currentFolderIsSystem) { toast("🔒 Files can't be added to the Emails folder by hand — it's filled automatically by Search Emails.", "err"); return; }
  const bar = document.getElementById("uploadBar");
  const fill = document.getElementById("uploadFill");
  const pct = document.getElementById("uploadPct");
  const label = document.getElementById("uploadLabel");
  bar.classList.add("show");
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progress = Math.round((i / files.length) * 100);
    label.textContent = `Uploading ${i + 1} of ${files.length}: ${file.name}`;
    fill.style.width = progress + "%";
    pct.textContent = progress + "%";
    try {
      const dot = file.name.lastIndexOf(".");
      const ext = dot > -1 ? file.name.slice(dot) : "";
      const storagePath = `${currentCustomer.id}/${randId()}${ext}`;
      const { error: upErr } = await sb.storage.from(STORAGE_BUCKET).upload(storagePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (upErr) throw upErr;
      const { error: insErr } = await sb.from("nageo_files_files").insert({
        customer_id: currentCustomer.id,
        folder_id: currentFolderId,
        name: file.name,
        size: file.size,
        mime_type: file.type || "application/octet-stream",
        storage_path: storagePath,
      });
      if (insErr) throw insErr;
    } catch (e) {
      toast(`❌ Failed to upload ${file.name}: ${e.message}`, "err");
    }
  }
  fill.style.width = "100%";
  pct.textContent = "100%";
  label.textContent = "Upload complete!";
  setTimeout(() => bar.classList.remove("show"), 1500);
  toast(`✅ ${files.length} file${files.length > 1 ? 's' : ''} uploaded!`, "ok");
  loadFileView();
}
// ── FILE ACTIONS ──
async function previewFile(file) {
  const mime = file.mime_type || "";
  const isImage = mime.startsWith("image/");
  const isPDF = mime === "application/pdf";
  const isHtml = mime === "text/html"; // saved-email archives from the Emails folder
  if (!isImage && !isPDF && !isHtml) {
    // Not previewable — download instead
    downloadFile(file);
    return;
  }
  document.getElementById("previewTitle").textContent = file.name;
  document.getElementById("previewContent").innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text3);">Loading preview…</div>`;
  openModal("modalPreview");
  try {
    const { data, error } = await sb.storage.from(STORAGE_BUCKET).download(file.storage_path);
    if (error) throw error;
    if (isImage) {
      const objUrl = URL.createObjectURL(data);
      document.getElementById("previewContent").innerHTML = `<img class="preview-img" src="${objUrl}" alt="${esc(file.name)}">`;
    } else if (isPDF) {
      const objUrl = URL.createObjectURL(data);
      document.getElementById("previewContent").innerHTML = `<iframe class="preview-pdf" src="${objUrl}"></iframe>`;
    } else {
      // HTML email archive — render via sandboxed srcdoc, same safe pattern
      // used for the live email search results, so nothing in a saved
      // email's markup/script can touch the rest of the page.
      const text = await data.text();
      document.getElementById("previewContent").innerHTML = `<iframe class="preview-pdf" id="previewHtmlFrame" sandbox="allow-popups allow-same-origin" title="${esc(file.name)}"></iframe>`;
      document.getElementById("previewHtmlFrame").srcdoc = text;
    }
  } catch (e) {
    document.getElementById("previewContent").innerHTML = `<div style="padding:2rem;text-align:center;color:var(--red);">❌ Could not load preview.<br><small>${e.message}</small></div>`;
  }
}
async function downloadFile(file) {
  toast("⬇️ Downloading…");
  try {
    const { data, error } = await sb.storage.from(STORAGE_BUCKET).download(file.storage_path);
    if (error) throw error;
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast("❌ Download failed: " + e.message, "err");
  }
}
// ── RENAME ──
async function doRename() {
  if (!renameTarget) return;
  if (renameTarget.type === "folder" && renameTarget.data.is_system) {
    toast("🔒 The Emails folder can't be renamed.", "err"); closeModal("modalRename"); renameTarget = null; return;
  }
  if (renameTarget.type === "file" && (renameTarget.data.gmail_message_id || currentFolderIsSystem)) {
    toast("🔒 Saved emails can't be renamed.", "err"); closeModal("modalRename"); renameTarget = null; return;
  }
  const name = document.getElementById("renameInput").value.trim();
  if (!name) { document.getElementById("renameInput").focus(); return; }
  try {
    const table = renameTarget.type === "folder" ? "nageo_files_folders" : "nageo_files_files";
    const { error } = await sb.from(table).update({ name, updated_at: new Date().toISOString() }).eq("id", renameTarget.data.id);
    if (error) throw error;
    closeModal("modalRename");
    toast("✅ Renamed!", "ok");
    loadFileView();
  } catch (e) {
    toast("❌ " + e.message, "err");
  }
  renameTarget = null;
}
// ── DELETE HELPERS (storage cleanup + DB row, folders recurse) ──
async function collectStoragePathsRecursive(customerId, folderId) {
  const { data: files, error: fErr } = await sb.from("nageo_files_files").select("storage_path").eq("customer_id", customerId).eq("folder_id", folderId);
  if (fErr) throw fErr;
  let paths = (files || []).map(f => f.storage_path);
  const { data: subfolders, error: subErr } = await sb.from("nageo_files_folders").select("id").eq("customer_id", customerId).eq("parent_id", folderId);
  if (subErr) throw subErr;
  for (const sf of (subfolders || [])) {
    const nested = await collectStoragePathsRecursive(customerId, sf.id);
    paths = paths.concat(nested);
  }
  return paths;
}
async function deleteFolderDeep(folder) {
  if (folder.is_system) throw new Error("The Emails folder is protected and can't be deleted.");
  const paths = await collectStoragePathsRecursive(currentCustomer.id, folder.id);
  if (paths.length) {
    const { error: rmErr } = await sb.storage.from(STORAGE_BUCKET).remove(paths);
    if (rmErr) throw rmErr;
  }
  // Deleting the folder row cascades to every subfolder + file row underneath it (FK on delete cascade).
  const { error } = await sb.from("nageo_files_folders").delete().eq("id", folder.id);
  if (error) throw error;
}
async function deleteFileDeep(file) {
  if (file.gmail_message_id) throw new Error("Saved emails are protected copies and can't be deleted.");
  const { error: rmErr } = await sb.storage.from(STORAGE_BUCKET).remove([file.storage_path]);
  if (rmErr) throw rmErr;
  const { error } = await sb.from("nageo_files_files").delete().eq("id", file.id);
  if (error) throw error;
}
// ── DELETE (single, via context menu, or bulk) ──
async function doDelete() {
  if (!deleteTarget) return;
  document.getElementById("deleteOkBtn").disabled = true;
  document.getElementById("deleteOkBtn").textContent = "Deleting…";
  try {
    if (deleteTarget.type === "bulk") {
      const items = deleteTarget.items;
      let failed = 0;
      for (const it of items) {
        try {
          if (it.type === "folder") await deleteFolderDeep(it.data);
          else await deleteFileDeep(it.data);
        } catch (e) {
          failed++;
        }
      }
      closeModal("modalDelete");
      if (failed) toast(`⚠️ Deleted ${items.length - failed} of ${items.length} — ${failed} failed`, "err");
      else toast(`🗑️ Deleted ${items.length} item${items.length > 1 ? 's' : ''}`, "ok");
      exitSelectMode();
      loadFileView();
    } else if (deleteTarget.type === "folder") {
      await deleteFolderDeep(deleteTarget.data);
      closeModal("modalDelete");
      toast("🗑️ Deleted", "ok");
      loadFileView();
    } else {
      await deleteFileDeep(deleteTarget.data);
      closeModal("modalDelete");
      toast("🗑️ Deleted", "ok");
      loadFileView();
    }
  } catch (e) {
    toast("❌ " + e.message, "err");
  } finally {
    document.getElementById("deleteOkBtn").disabled = false;
    document.getElementById("deleteOkBtn").textContent = "Yes, Delete";
  }
  deleteTarget = null;
}
// ── BULK SELECT ──
function toggleSelectMode() {
  selectMode = !selectMode;
  selectedItems.clear();
  const btn = document.getElementById("selectModeBtn");
  btn.textContent = selectMode ? "✕ Cancel Select" : "☑️ Select";
  btn.classList.toggle("active", selectMode);
  updateSelectBar();
  renderFileView(lastFolders, lastFiles);
}
function exitSelectMode() {
  selectMode = false;
  selectedItems.clear();
  const btn = document.getElementById("selectModeBtn");
  if (btn) { btn.textContent = "☑️ Select"; btn.classList.remove("active"); }
  updateSelectBar();
}
function toggleItemSelect(type, data) {
  const key = type + ":" + data.id;
  if (selectedItems.has(key)) selectedItems.delete(key);
  else selectedItems.set(key, { type, data });
  updateSelectBar();
  renderFileView(lastFolders, lastFiles);
}
function selectAllInView() {
  if (!selectMode) return;
  lastFolders.forEach(f => selectedItems.set("folder:" + f.id, { type: "folder", data: f }));
  lastFiles.forEach(f => selectedItems.set("file:" + f.id, { type: "file", data: f }));
  updateSelectBar();
  renderFileView(lastFolders, lastFiles);
}
function updateSelectBar() {
  const bar = document.getElementById("selectBar");
  if (!selectMode) { bar.classList.remove("show"); return; }
  bar.classList.add("show");
  const count = selectedItems.size;
  document.getElementById("selectCount").textContent = count === 0 ? "Tap files or folders to select them" : `${count} selected`;
  document.getElementById("selectDownloadBtn").disabled = count === 0;
  document.getElementById("selectDeleteBtn").disabled = count === 0;
}
function confirmBulkDelete() {
  const items = Array.from(selectedItems.values());
  if (!items.length) return;
  deleteTarget = { type: "bulk", items };
  const fileCount = items.filter(i => i.type === "file").length;
  const folderCount = items.filter(i => i.type === "folder").length;
  const parts = [];
  if (folderCount) parts.push(`${folderCount} folder${folderCount > 1 ? 's' : ''} (and everything inside)`);
  if (fileCount) parts.push(`${fileCount} file${fileCount > 1 ? 's' : ''}`);
  document.getElementById("deleteMsg").textContent = `Delete ${parts.join(" and ")}? This cannot be undone.`;
  openModal("modalDelete");
}
// Recursively collects every file under a folder (for bulk download), preserving relative paths.
async function collectFilesRecursive(customerId, folderId, pathPrefix) {
  const { data: files, error: fErr } = await sb.from("nageo_files_files").select("*").eq("customer_id", customerId).eq("folder_id", folderId);
  if (fErr) throw fErr;
  let out = (files || []).map(f => ({ file: f, path: pathPrefix + f.name }));
  const { data: subfolders, error: subErr } = await sb.from("nageo_files_folders").select("*").eq("customer_id", customerId).eq("parent_id", folderId);
  if (subErr) throw subErr;
  for (const sub of (subfolders || [])) {
    const nested = await collectFilesRecursive(customerId, sub.id, pathPrefix + sub.name + "/");
    out = out.concat(nested);
  }
  return out;
}
async function bulkDownloadSelected() {
  const items = Array.from(selectedItems.values());
  if (!items.length) return;
  // Single file selected, no folders — just download it directly, no zip needed.
  if (items.length === 1 && items[0].type === "file") {
    downloadFile(items[0].data);
    return;
  }
  const dlBtn = document.getElementById("selectDownloadBtn");
  dlBtn.disabled = true;
  const bar = document.getElementById("uploadBar");
  const fill = document.getElementById("uploadFill");
  const pct = document.getElementById("uploadPct");
  const label = document.getElementById("uploadLabel");
  bar.classList.add("show");
  label.textContent = "Preparing files…";
  fill.style.width = "0%";
  pct.textContent = "0%";
  try {
    // Build the full flat file list, recursing into any selected folders.
    let allFiles = [];
    for (const it of items) {
      if (it.type === "file") {
        allFiles.push({ file: it.data, path: it.data.name });
      } else {
        const nested = await collectFilesRecursive(currentCustomer.id, it.data.id, it.data.name + "/");
        allFiles = allFiles.concat(nested);
      }
    }
    if (!allFiles.length) {
      toast("Nothing to download — selected folders are empty.", "err");
      bar.classList.remove("show");
      dlBtn.disabled = false;
      return;
    }
    const zip = new JSZip();
    for (let i = 0; i < allFiles.length; i++) {
      const { file, path } = allFiles[i];
      label.textContent = `Downloading ${i + 1} of ${allFiles.length}: ${file.name}`;
      const pctVal = Math.round((i / allFiles.length) * 100);
      fill.style.width = pctVal + "%";
      pct.textContent = pctVal + "%";
      try {
        const { data: blob, error } = await sb.storage.from(STORAGE_BUCKET).download(file.storage_path);
        if (error || !blob) continue;
        zip.file(path, blob);
      } catch (e) {
        // skip files that fail to fetch, continue with the rest
      }
    }
    label.textContent = "Zipping files…";
    fill.style.width = "95%";
    pct.textContent = "95%";
    const zipBlob = await zip.generateAsync({ type: "blob" });
    fill.style.width = "100%";
    pct.textContent = "100%";
    label.textContent = "Download ready!";
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    const zipName = (items.length === 1 ? items[0].data.name : (currentCustomer?.name || "files")).replace(/[^a-z0-9]+/gi, "_");
    a.download = `${zipName}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✅ Downloaded ${allFiles.length} file${allFiles.length > 1 ? 's' : ''}`, "ok");
  } catch (e) {
    toast("❌ Download failed: " + e.message, "err");
  } finally {
    setTimeout(() => bar.classList.remove("show"), 1200);
    dlBtn.disabled = false;
  }
}
// ── GLOBAL SEARCH ──
async function globalSearch(q) {
  try {
    let folderQuery = sb.from("nageo_files_folders").select("*").ilike("name", `%${q}%`).limit(5);
    let fileQuery = sb.from("nageo_files_files").select("*").ilike("name", `%${q}%`).limit(8);
    if (currentCustomer) {
      folderQuery = folderQuery.eq("customer_id", currentCustomer.id);
      fileQuery = fileQuery.eq("customer_id", currentCustomer.id);
    }
    const [fRes, flRes] = await Promise.all([folderQuery, fileQuery]);
    if (fRes.error) throw fRes.error;
    if (flRes.error) throw flRes.error;
    showSearchResults(q, flRes.data || [], fRes.data || []);
  } catch (e) {
    hideSearchResults();
  }
}
function showSearchResults(q, files, folders) {
  const el = document.getElementById("searchResults");
  if (!files.length && !folders.length) {
    el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text3);font-size:13px;">No results for "${esc(q)}"</div>`;
    el.classList.add("show");
    return;
  }
  let html = "";
  folders.slice(0, 5).forEach(f => {
    html += `<div class="sr-item" onclick="jumpToFolder('${f.customer_id}','${f.id}')">
      <div class="sr-icon">📁</div>
      <div class="sr-info"><div class="sr-name">${esc(f.name)}</div><div class="sr-sub">Folder</div></div>
      <div class="sr-badge badge-folder">Folder</div>
    </div>`;
  });
  files.slice(0, 8).forEach(f => {
    html += `<div class="sr-item" onclick="jumpToFile('${f.customer_id}','${f.folder_id || ''}','${f.id}')">
      <div class="sr-icon">${fileIcon(f.name)}</div>
      <div class="sr-info"><div class="sr-name">${esc(f.name)}</div><div class="sr-sub">${formatSize(f.size)} · ${esc(customerTagFor(f.customer_id))}</div></div>
      <div class="sr-badge badge-file">File</div>
    </div>`;
  });
  el.innerHTML = html;
  el.classList.add("show");
}
function hideSearchResults() {
  document.getElementById("searchResults").classList.remove("show");
  document.getElementById("globalSearch").value = "";
}
async function jumpToFolder(customerId, folderId) {
  hideSearchResults();
  const c = allCustomers.find(x => x.id === customerId);
  if (c) {
    currentCustomer = c;
    currentFolderId = folderId;
    breadcrumbs = [{ id: null, name: c.name }];
    exitSelectMode();
    document.getElementById("emptyState").style.display = "none";
    document.getElementById("fileBrowser").classList.add("show");
    document.getElementById("fcName").textContent = c.name;
    document.getElementById("fcMeta").textContent = `#${c.customer_id}${c.address ? ' · ' + c.address : ''}`;
    renderCustomerList(filteredCustomers);
    loadFileView();
  }
}
async function jumpToFile(customerId, folderId, fileId) {
  hideSearchResults();
  await jumpToFolder(customerId, folderId || "");
  currentFolderId = folderId || null;
  // Load and preview
  try {
    let q = sb.from("nageo_files_files").select("*").eq("customer_id", customerId);
    q = folderId ? q.eq("folder_id", folderId) : q.is("folder_id", null);
    const { data, error } = await q;
    if (error) throw error;
    const file = (data || []).find(f => f.id === fileId);
    if (file) previewFile(file);
  } catch (e) {}
}
// ── SEARCH EMAILS — on-demand Gmail search across the shared connected-
// account pool for every email address on file for this customer. Nothing
// is stored; this searches live each time "Search Now" is clicked. Multi-
// pass pagination (same pattern as the Leads tool's email sync) means one
// click walks through every page of Gmail results instead of stopping at
// an arbitrary cap — the Edge Function hands back a `cursors` object each
// pass, and this loop keeps calling it until every connected account is
// exhausted or the safety limit of passes is hit. ──
var searchEmailsCustomerId = null;
var searchEmailsList = []; // [{email, source:'hcp'|'manual'}]
var emailSearchCancelled = false;
var emailSearchRunning = false;

// ── PROTECTED "📧 Emails" FOLDER ──────────────────────────────────────────
// A locked, auto-created folder every customer gets the first time a
// message found by Search Emails needs somewhere to live. Nothing else ever
// writes into it — see the is_system / gmail_message_id guards throughout
// this file (moveItem, doRename, deleteFolderDeep, deleteFileDeep, showCtx,
// renderFileView, rewireDrop, createFolder, uploadFiles, handleDragStart).
async function getOrCreateEmailsFolder(customerId) {
  const { data: existing, error: findErr } = await sb.from("nageo_files_folders")
    .select("*").eq("customer_id", customerId).is("parent_id", null).eq("is_system", true).limit(1);
  if (findErr) throw findErr;
  if (existing && existing.length) return existing[0];
  const { data, error } = await sb.from("nageo_files_folders")
    .insert({ customer_id: customerId, parent_id: null, name: EMAILS_FOLDER_NAME, is_system: true })
    .select().single();
  if (error) throw error;
  return data;
}
function sanitizeEmailFileName(r) {
  var base = (r.subject && r.subject.trim()) ? r.subject.trim() : "(no subject)";
  base = base.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80).trim() || "email";
  var dateStr = "";
  if (r.date) {
    var d = new Date(r.date);
    if (!isNaN(d.getTime())) dateStr = d.toISOString().slice(0, 10) + " ";
  }
  return dateStr + base + ".html";
}
function buildEmailArchiveHtml(r) {
  var bodyContent = (r.html && r.html.trim()) ? r.html : (r.text ? esc(r.text).replace(/\n/g, "<br>") : (r.snippet || ""));
  var headerHtml = '<div style="font-family:-apple-system,sans-serif;font-size:13px;color:#333;background:#f4f4f6;border-bottom:1px solid #ddd;padding:12px 16px;">'
    + '<div><strong>From:</strong> ' + esc(r.from || '—') + '</div>'
    + '<div><strong>To:</strong> ' + esc(r.to || '—') + '</div>'
    + '<div><strong>Date:</strong> ' + esc(r.date ? new Date(r.date).toLocaleString() : '—') + '</div>'
    + '<div><strong>Subject:</strong> ' + esc(r.subject || '(no subject)') + '</div>'
    + '</div>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<style>*{box-sizing:border-box;}body{margin:0;font-family:-apple-system,sans-serif;background:#fff;}.email-body{padding:16px;font-size:13px;line-height:1.55;color:#1a1a1a;word-wrap:break-word;overflow-wrap:break-word;}img{max-width:100%;height:auto;}a{color:#2e73d4;}table{max-width:100%;}</style>'
    + '</head><body>' + headerHtml + '<div class="email-body">' + bodyContent + '</div></body></html>';
}
// Saves every not-yet-saved message in `results` into customerId's locked
// Emails folder, de-duped against gmail_message_id (both against what's
// already in the DB and within this batch), and returns how many were newly
// saved. Safe to call repeatedly with overlapping/duplicate result sets —
// that's the whole point, since a re-run of Search Emails will re-find
// messages already archived from a previous search.
async function saveEmailsToFolder(customerId, results) {
  if (!results || !results.length) return 0;
  const folder = await getOrCreateEmailsFolder(customerId);
  const ids = results.map(function (r) { return r.gmail_message_id; }).filter(Boolean);
  let already = new Set();
  if (ids.length) {
    const { data: existingRows, error: existErr } = await sb.from("nageo_files_files")
      .select("gmail_message_id").eq("customer_id", customerId).in("gmail_message_id", ids);
    if (existErr) throw existErr;
    (existingRows || []).forEach(function (row) { already.add(row.gmail_message_id); });
  }
  let savedCount = 0;
  for (const r of results) {
    if (!r.gmail_message_id || already.has(r.gmail_message_id)) continue;
    try {
      const archiveHtml = buildEmailArchiveHtml(r);
      const bytes = new TextEncoder().encode(archiveHtml);
      const storagePath = `${customerId}/${randId()}.html`;
      const { error: upErr } = await sb.storage.from(STORAGE_BUCKET).upload(storagePath, bytes, {
        contentType: "text/html", upsert: false,
      });
      if (upErr) throw upErr;
      const { error: insErr } = await sb.from("nageo_files_files").insert({
        customer_id: customerId,
        folder_id: folder.id,
        name: sanitizeEmailFileName(r),
        size: bytes.length,
        mime_type: "text/html",
        storage_path: storagePath,
        gmail_message_id: r.gmail_message_id,
        gmail_account: r.account || null,
      });
      if (insErr) {
        // 23505 = unique violation on (customer_id, gmail_message_id) — a
        // concurrent search already saved this exact message a moment ago.
        // Clean up the storage object we just uploaded and move on quietly.
        await sb.storage.from(STORAGE_BUCKET).remove([storagePath]);
        if (insErr.code !== "23505") throw insErr;
        already.add(r.gmail_message_id);
        continue;
      }
      already.add(r.gmail_message_id);
      savedCount++;
    } catch (e) {
      console.warn("Failed to save email to Emails folder:", r.subject, e);
    }
  }
  if (savedCount && currentCustomer && currentCustomer.id === customerId && currentFolderId === folder.id) {
    loadFileView(); // live-refresh if the user happens to already be looking at the Emails folder
  }
  return savedCount;
}

// ── GLOBAL SETTINGS: GMAIL ACCOUNT POOL + SYNC ALL CUSTOMERS ──────────────
// Available from the ⚙ Settings button in the top bar — not tied to any one
// customer. Lists every connected Gmail account in the shared pool, lets you
// connect more (real Google OAuth, same flow/pool GRECs and Leads use), and
// runs a full sweep that searches every customer's email address(es) and
// auto-saves anything found into that customer's locked Emails folder.
var gmailPool = [];
var sweepCancelled = false;
var sweepRunning = false;
// Kept lower than the per-customer 🔍 Search Emails button's 25-pass cap —
// this sweep walks EVERY customer, so each one needs to stay quick.
// Customers with a lot of mail can always be fully searched individually
// afterward via their own Search Emails button, which will pick up right
// where the sweep left off (same cursor-based pagination, nothing lost).
var SWEEP_MAX_PASSES_PER_CUSTOMER = 6;

function openGlobalSettingsModal() {
  document.getElementById("sweepProgress").style.display = "none";
  document.getElementById("sweepSummary").style.display = "none";
  document.getElementById("sweepLog").style.display = "none";
  document.getElementById("sweepLog").innerHTML = "";
  loadGmailPool();
  openModal("modalGlobalSettings");
}
async function loadGmailPool() {
  var el = document.getElementById("gmailAccountsList");
  el.innerHTML = '<div class="se-empty" style="padding:.5rem 0;">Loading…</div>';
  try {
    const res = await fetch(SEARCH_EMAILS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SUPABASE_KEY, "apikey": SUPABASE_KEY },
      body: JSON.stringify({ action: "list_pool" }),
    });
    const data = await res.json();
    gmailPool = (data && data.accounts) || [];
  } catch (e) {
    gmailPool = [];
  }
  renderGmailPool();
}
function renderGmailPool() {
  var el = document.getElementById("gmailAccountsList");
  if (!gmailPool.length) {
    el.innerHTML = '<div class="se-empty" style="padding:.5rem 0;">No Gmail accounts connected yet — connect one below.</div>';
    return;
  }
  el.innerHTML = gmailPool.map(function (a) {
    var statusClass = a.status === "connected" ? "connected" : "error";
    return '<div class="gmail-acct-row">'
      + '<span class="gmail-acct-email">' + esc(a.google_email) + '</span>'
      + '<span class="gmail-acct-status ' + statusClass + '">' + esc(a.status) + '</span>'
      + '</div>';
  }).join("");
}
function connectGmailAccount() {
  var params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    // Same scope set GRECs' connect flow requests, so an account connected
    // from either tool ends up with identical permissions in the shared pool.
    scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/gmail.send",
    // lead-gmail-oauth's callback requires a non-empty state — it uses this
    // as rep_id, stored as a uuid column, so it has to be a real UUID (a
    // plain string like "nageo-files" fails with "invalid input syntax for
    // type uuid"). Files has no per-user login to supply a real rep's id, so
    // this is a fixed placeholder UUID marking accounts connected from this
    // tool. It's metadata only — every tool still searches the whole shared
    // pool regardless of which rep_id an account was connected under.
    state: NAGEO_FILES_PLACEHOLDER_REP_ID,
  });
  window.open("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString(), "_blank");
  toast("Complete the Google sign-in in the new tab, then come back and click Refresh List.", "ok");
}

// Multi-pass search for ONE customer during a sweep — a lighter-weight
// sibling of startEmailSearch's loop (no UI rendering per pass, and a lower
// pass cap), since the sweep needs to keep moving through hundreds of
// customers rather than exhaustively paginate any single one.
async function sweepSearchOneCustomer(emails, maxPasses) {
  var allResults = [];
  var seen = {};
  var cursors = {};
  var pass = 0;
  while (pass < maxPasses) {
    pass++;
    var data;
    try {
      const res = await fetch(SEARCH_EMAILS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SUPABASE_KEY, "apikey": SUPABASE_KEY },
        body: JSON.stringify({ emails: emails, cursors: cursors }),
      });
      data = await res.json();
    } catch (e) {
      break; // network hiccup on this one customer — move on, don't kill the whole sweep
    }
    if (data.error) break;
    (data.results || []).forEach(function (r) {
      var key = r.account + ":" + r.gmail_message_id;
      if (seen[key]) return;
      seen[key] = true;
      allResults.push(r);
    });
    cursors = data.cursors || {};
    if (data.note) break;
    if (sweepCancelled) break;
    if (!data.has_more) break;
  }
  return allResults;
}
async function startSweepAllCustomers() {
  if (sweepRunning) return;
  if (!allCustomers.length) { toast("Customer list hasn't loaded yet — try again in a moment.", "err"); return; }
  sweepRunning = true;
  sweepCancelled = false;
  var btn = document.getElementById("sweepAllBtn");
  var progressBox = document.getElementById("sweepProgress");
  var progressText = document.getElementById("sweepProgressText");
  var stopBtn = document.getElementById("sweepStopBtn");
  var summaryEl = document.getElementById("sweepSummary");
  var logEl = document.getElementById("sweepLog");
  btn.disabled = true;
  stopBtn.disabled = false;
  stopBtn.textContent = "Stop after this customer";
  progressBox.style.display = "block";
  summaryEl.style.display = "block";
  logEl.style.display = "block";
  logEl.innerHTML = "";
  progressText.textContent = "Loading manually-added email addresses…";

  var manualByCustomer = {};
  try {
    const { data, error } = await sb.from("nageo_files_manual_emails").select("customer_id, email");
    if (!error && data) {
      data.forEach(function (row) {
        if (!manualByCustomer[row.customer_id]) manualByCustomer[row.customer_id] = [];
        manualByCustomer[row.customer_id].push(row.email);
      });
    }
  } catch (e) { /* proceed with HCP-on-file emails only */ }

  var skipped = 0, totalSaved = 0, totalFound = 0, failed = 0;
  var customers = allCustomers.slice();

  for (var i = 0; i < customers.length; i++) {
    if (sweepCancelled) break;
    var c = customers[i];
    var emails = [];
    if (c.email && c.email.trim()) emails.push(c.email.trim().toLowerCase());
    (manualByCustomer[c.id] || []).forEach(function (e) {
      var v = (e || "").trim().toLowerCase();
      if (v && emails.indexOf(v) === -1) emails.push(v);
    });
    progressText.textContent = "Customer " + (i + 1) + " of " + customers.length + ": " + c.name;
    if (!emails.length) {
      skipped++;
      appendSweepLogRow(c.name, "no email on file", false);
      updateSweepSummary(summaryEl, i + 1, customers.length, skipped, totalSaved, totalFound, failed);
      continue;
    }
    try {
      const results = await sweepSearchOneCustomer(emails, SWEEP_MAX_PASSES_PER_CUSTOMER);
      totalFound += results.length;
      var saved = results.length ? await saveEmailsToFolder(c.id, results) : 0;
      totalSaved += saved;
      appendSweepLogRow(c.name, results.length ? (saved + " new · " + results.length + " found") : "no emails found", saved > 0);
    } catch (e) {
      failed++;
      appendSweepLogRow(c.name, "error: " + e.message, false);
    }
    updateSweepSummary(summaryEl, i + 1, customers.length, skipped, totalSaved, totalFound, failed);
  }

  progressBox.style.display = "none";
  btn.disabled = false;
  sweepRunning = false;
  var finishedAll = !sweepCancelled;
  updateSweepSummary(summaryEl, Math.min(i, customers.length), customers.length, skipped, totalSaved, totalFound, failed, finishedAll);
  toast(finishedAll
    ? ("✅ Sync complete — " + totalSaved + " new email" + (totalSaved === 1 ? "" : "s") + " saved across " + customers.length + " customers.")
    : ("⏸ Sync stopped — " + totalSaved + " new email" + (totalSaved === 1 ? "" : "s") + " saved so far."), "ok");
}
function appendSweepLogRow(name, resultText, hasNew) {
  var logEl = document.getElementById("sweepLog");
  var row = document.createElement("div");
  row.className = "sweep-log-row" + (hasNew ? " has-new" : "");
  row.innerHTML = '<span class="sweep-log-name">' + esc(name) + '</span><span class="sweep-log-result">' + esc(resultText) + '</span>';
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}
function updateSweepSummary(el, done, total, skipped, totalSaved, totalFound, failed, finished) {
  el.innerHTML = '<b>' + done + ' of ' + total + '</b> customers checked'
    + (skipped ? ' · ' + skipped + ' skipped (no email on file)' : '')
    + (failed ? ' · ' + failed + ' failed' : '')
    + ' · <b>' + totalSaved + '</b> new email' + (totalSaved === 1 ? '' : 's') + ' saved'
    + (totalFound ? ' (' + totalFound + ' matched total)' : '')
    + (finished ? ' — done.' : '');
}

async function openSearchEmailsModal() {
  if (!currentCustomer) return;
  searchEmailsCustomerId = currentCustomer.id;
  document.getElementById("searchEmailsAddInput").value = "";
  document.getElementById("searchEmailsResults").innerHTML = "";
  document.getElementById("searchEmailsProgress").style.display = "none";
  await loadSearchEmailsList();
  renderSearchEmailsList();
  openModal("modalSearchEmails");
  if (searchEmailsList.length) startEmailSearch();
}
async function loadSearchEmailsList() {
  searchEmailsList = [];
  var hcpEmail = (currentCustomer.email || "").trim();
  if (hcpEmail) searchEmailsList.push({ email: hcpEmail, source: "hcp" });
  try {
    const { data, error } = await sb.from("nageo_files_manual_emails").select("*").eq("customer_id", searchEmailsCustomerId).order("created_at");
    if (!error && data) {
      data.forEach(function (row) {
        if (!searchEmailsList.some(function (e) { return e.email.toLowerCase() === row.email.toLowerCase(); })) {
          searchEmailsList.push({ email: row.email, source: "manual" });
        }
      });
    }
  } catch (e) { /* non-fatal — just search whatever we already have */ }
}
function renderSearchEmailsList() {
  var el = document.getElementById("searchEmailsList");
  if (!searchEmailsList.length) {
    el.innerHTML = '<div class="se-empty" style="padding:1rem 0;">No email address on file yet — add one below to search for it.</div>';
    return;
  }
  el.innerHTML = searchEmailsList.map(function (e) {
    return '<div class="se-email-row">'
      + '<span class="se-email-addr">' + esc(e.email) + '</span>'
      + '<span class="se-email-src">' + (e.source === "hcp" ? "from HCP" : "added manually") + '</span>'
      + (e.source === "manual" ? '<button class="se-email-remove" onclick="removeSearchEmail(\'' + esc(e.email).replace(/'/g, "\\'") + '\')" title="Remove">✕</button>' : '')
      + '</div>';
  }).join("");
}
async function addSearchEmail() {
  var input = document.getElementById("searchEmailsAddInput");
  var val = (input.value || "").trim().toLowerCase();
  if (!val) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { toast("That doesn't look like a valid email address.", "err"); return; }
  if (searchEmailsList.some(function (e) { return e.email.toLowerCase() === val; })) { toast("That email is already in the list.", "err"); input.value = ""; return; }
  try {
    const { error } = await sb.from("nageo_files_manual_emails").insert({ customer_id: searchEmailsCustomerId, email: val });
    if (error && error.code !== "23505") throw error; // 23505 = unique violation, harmless race, ignore
  } catch (e) {
    toast("Could not save that email: " + e.message, "err");
    return;
  }
  searchEmailsList.push({ email: val, source: "manual" });
  input.value = "";
  renderSearchEmailsList();
  toast("Email added — click Search Now to include it.", "ok");
}
async function removeSearchEmail(email) {
  try {
    await sb.from("nageo_files_manual_emails").delete().eq("customer_id", searchEmailsCustomerId).ilike("email", email);
  } catch (e) { /* best-effort */ }
  searchEmailsList = searchEmailsList.filter(function (e) { return e.email.toLowerCase() !== email.toLowerCase(); });
  renderSearchEmailsList();
}
async function startEmailSearch() {
  if (emailSearchRunning) return;
  if (!searchEmailsList.length) { toast("Add an email address to search for first.", "err"); return; }
  emailSearchRunning = true;
  emailSearchCancelled = false;
  var emails = searchEmailsList.map(function (e) { return e.email; });
  var progressBox = document.getElementById("searchEmailsProgress");
  var progressText = document.getElementById("searchEmailsProgressText");
  var stopBtn = document.getElementById("searchEmailsStopBtn");
  var goBtn = document.getElementById("searchEmailsGoBtn");
  var resultsBox = document.getElementById("searchEmailsResults");
  progressBox.style.display = "block";
  stopBtn.textContent = "Stop after this pass";
  stopBtn.disabled = false;
  goBtn.disabled = true;
  resultsBox.innerHTML = "";
  progressText.textContent = "Starting…";

  var allResults = [];
  var seen = {};
  var cursors = {};
  var pass = 0;
  var MAX_PASSES = 25; // safety valve so a stuck account can't loop forever
  var accountsSearched = 0;
  var stoppedReason = null;

  try {
    while (pass < MAX_PASSES) {
      pass++;
      progressText.textContent = "Pass " + pass + ": searching connected Gmail accounts…";
      var data;
      try {
        const res = await fetch(SEARCH_EMAILS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SUPABASE_KEY, "apikey": SUPABASE_KEY },
          body: JSON.stringify({ emails: emails, cursors: cursors }),
        });
        data = await res.json();
      } catch (e) {
        stoppedReason = "Search failed: " + e.message;
        break;
      }
      if (data.error) { stoppedReason = "Search failed: " + data.error; break; }
      accountsSearched = data.accounts_searched || accountsSearched;
      (data.results || []).forEach(function (r) {
        var key = r.account + ":" + r.gmail_message_id;
        if (seen[key]) return;
        seen[key] = true;
        allResults.push(r);
      });
      cursors = data.cursors || {};
      allResults.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
      renderSearchEmailsResultsList(allResults, accountsSearched);
      progressText.textContent = allResults.length + " message" + (allResults.length === 1 ? "" : "s") + " found so far — pass " + pass + ".";
      if (data.note) { stoppedReason = data.note; break; }
      if (emailSearchCancelled) { stoppedReason = "Stopped early at your request."; break; }
      if (!data.has_more) { stoppedReason = null; break; }
    }
    if (pass >= MAX_PASSES && !stoppedReason) stoppedReason = "Stopped after " + MAX_PASSES + " passes as a safety limit.";
  } finally {
    progressBox.style.display = "none";
    goBtn.disabled = false;
    emailSearchRunning = false;
    // Auto-save whatever was found — even a partial batch, if the search was
    // stopped early or hit the pass cap — into the customer's locked Emails
    // folder. saveEmailsToFolder de-dupes against what's already saved, so
    // this is safe to run after every search, complete or not.
    if (allResults.length) {
      try {
        const saved = await saveEmailsToFolder(searchEmailsCustomerId, allResults);
        if (saved > 0) toast(`📧 ${saved} new email${saved === 1 ? '' : 's'} saved to the Emails folder.`, "ok");
      } catch (e) {
        toast("⚠️ Search finished but saving to the Emails folder failed: " + e.message, "err");
      }
    }
  }
  if (!allResults.length && !stoppedReason) {
    document.getElementById("searchEmailsResults").innerHTML = '<div class="se-empty">No emails found for any address on this list, across ' + accountsSearched + ' connected account' + (accountsSearched === 1 ? '' : 's') + '.</div>';
  } else if (stoppedReason) {
    toast(stoppedReason, "err");
  }
}
function renderSearchEmailsResultsList(results, accountsSearched) {
  var box = document.getElementById("searchEmailsResults");
  if (!results.length) { box.innerHTML = ""; return; }
  var metaHtml = '<div class="se-meta">' + results.length + ' message' + (results.length === 1 ? '' : 's') + ' found across ' + accountsSearched + ' connected account' + (accountsSearched === 1 ? '' : 's') + '.</div>';
  var html = metaHtml + '<div class="se-tiles">';
  results.forEach(function (r, idx) {
    var dateStr = r.date ? new Date(r.date).toLocaleString() : '';
    html += '<div class="se-tile' + (idx === 0 ? ' open' : '') + '">'
      + '<div class="se-tile-hdr" onclick="toggleSearchEmailTile(this)">'
      + '<div style="flex:1;min-width:0;"><div class="se-tile-who">' + esc(r.from || '—') + '</div><div class="se-tile-sub">' + esc(r.subject || '(no subject)') + '</div></div>'
      + '<span class="se-tile-date">' + esc(dateStr) + '</span>'
      + '<span class="se-tile-chevron">▾</span>'
      + '</div>'
      + '<div class="se-tile-body"><div class="se-frame-card"><iframe class="se-frame" id="se-frame-' + idx + '" sandbox="allow-popups allow-same-origin" title="Email"></iframe></div></div>'
      + '</div>';
  });
  html += '</div>';
  box.innerHTML = html;
  results.forEach(function (r, idx) {
    var frame = document.getElementById('se-frame-' + idx);
    if (!frame) return;
    var content = (r.html && r.html.trim()) ? r.html : (r.text ? esc(r.text).replace(/\n/g, '<br>') : (r.snippet || ''));
    fillSearchEmailFrame(frame, content);
  });
}
function toggleSearchEmailTile(hdrEl) {
  var tile = hdrEl.closest(".se-tile");
  if (tile) tile.classList.toggle("open");
}
function fillSearchEmailFrame(iframe, htmlContent) {
  if (!iframe) return;
  var trimmed = htmlContent && htmlContent.trim();
  var doc;
  if (!trimmed) {
    doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:10px 12px;font-family:-apple-system,sans-serif;font-size:13px;color:#888;background:#fff;}</style></head><body><em>No content available for this message.</em></body></html>';
  } else if (/^\s*<!DOCTYPE html|^\s*<html/i.test(trimmed)) {
    doc = trimmed;
  } else {
    doc = '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<style>*{box-sizing:border-box;}body{margin:0;padding:10px 12px;font-family:-apple-system,sans-serif;font-size:13px;line-height:1.55;color:#1a1a1a;background:#fff;word-wrap:break-word;overflow-wrap:break-word;}img{max-width:100%;height:auto;}a{color:#2e73d4;}table{max-width:100%;}</style>'
      + '</head><body>' + trimmed + '</body></html>';
  }
  iframe.onload = function () {
    try {
      var h = iframe.contentWindow.document.body.scrollHeight;
      iframe.style.height = Math.max(40, h + 4) + "px";
    } catch (e) { iframe.style.height = "200px"; }
  };
  iframe.setAttribute("srcdoc", doc);
}
// ── CONTEXT MENU ──
function showCtx(event, type, data) {
  event.stopPropagation();
  ctxTarget = { type, data };
  const menu = document.getElementById("ctxMenu");
  const isProtected = (type === "folder" && data.is_system) || (type === "file" && (data.gmail_message_id || currentFolderIsSystem));
  // Show/hide relevant items
  document.getElementById("ctxOpen").style.display = type === "folder" ? "flex" : "none";
  document.getElementById("ctxPreview").style.display = type === "file" ? "flex" : "none";
  document.getElementById("ctxDownload").style.display = type === "file" ? "flex" : "none";
  document.getElementById("ctxRename").style.display = isProtected ? "none" : "flex";
  document.getElementById("ctxDelete").style.display = isProtected ? "none" : "flex";
  // Position menu
  const x = Math.min(event.clientX, window.innerWidth - 180);
  const y = Math.min(event.clientY, window.innerHeight - 200);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.classList.add("show");
}
function closeCtx() {
  document.getElementById("ctxMenu").classList.remove("show");
  ctxTarget = null;
}
// ── MODALS ──
function openModal(id) {
  document.getElementById(id).classList.add("open");
  // Focus first input
  setTimeout(() => {
    const input = document.querySelector(`#${id} input`);
    if (input) input.focus();
  }, 100);
}
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}
window.closeModal = closeModal;
// ── TOAST ──
function toast(msg, type = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (type ? " " + type : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = "toast"; }, 3000);
}
// ── HELPERS ──
function initials(name) {
  return name.split(" ").filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 2);
}
function esc(s) {
  return (s == null ? "" : String(s))
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return Math.round(bytes / 1024) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}
function fileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["jpg","jpeg","png","gif","webp","heic","heif"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📄";
  if (["doc","docx"].includes(ext)) return "📝";
  if (["xls","xlsx","csv"].includes(ext)) return "📊";
  if (["mp4","mov","avi","mkv"].includes(ext)) return "🎬";
  if (["mp3","m4a","wav"].includes(ext)) return "🎵";
  if (["zip","rar","7z"].includes(ext)) return "🗜️";
  if (["dwg","dxf"].includes(ext)) return "📐";
  return "📄";
}
