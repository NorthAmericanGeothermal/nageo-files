// NAGeo Files — app.js (Supabase-backed — replaces the old Cloudflare Worker)
const SUPABASE_URL = "https://hpgwwegjsxyxovdattoc.supabase.co";
const SUPABASE_KEY = "sb_publishable_D2PqYQoJjZ8koEM9NPvmeg_KB_Wa66H";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const HCP_CUSTOMERS_URL = SUPABASE_URL + "/functions/v1/nageo-files-hcp-customers";
const STORAGE_BUCKET = "nageo-files-documents";
const REG_KEY = "nageo_files_reg";
// ── STATE ──
let regCode = localStorage.getItem(REG_KEY) || "";
let allCustomers = [];
let filteredCustomers = [];
let currentCustomer = null;
let currentFolderId = null;
let breadcrumbs = []; // [{id, name}]
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
      const clickHandler = selectMode
        ? `toggleItemSelect('folder', ${dataAttr})`
        : `openFolder(${dataAttr})`;
      const dragAttrs = selectMode ? '' : `draggable="true" ondragstart="handleDragStart(event,'folder',${dataAttr})" ondragend="handleDragEnd(event)" ondragover="handleDragOverFolder(event,${dataAttr})" ondragleave="handleDragLeaveCard(event)" ondrop="handleDropOnFolder(event,${dataAttr})"`;
      html += `
        <div class="folder-card${selected ? ' card-selected' : ''}" ${dragAttrs} onclick="${clickHandler}">
          ${selectMode ? `<div class="card-checkbox${selected ? ' checked' : ''}"></div>` : ''}
          <div class="card-icon">📁</div>
          <div class="card-name">${esc(f.name)}</div>
          ${selectMode ? '' : `<button class="card-menu" onclick="event.stopPropagation();showCtx(event,'folder',${dataAttr})">⋯</button>`}
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
      const clickHandler = selectMode
        ? `toggleItemSelect('file', ${dataAttr})`
        : `previewFile(${dataAttr})`;
      const dragAttrs = selectMode ? '' : `draggable="true" ondragstart="handleDragStart(event,'file',${dataAttr})" ondragend="handleDragEnd(event)"`;
      html += `
        <div class="file-card${selected ? ' card-selected' : ''}" ${dragAttrs} onclick="${clickHandler}">
          ${selectMode ? `<div class="card-checkbox${selected ? ' checked' : ''}"></div>` : ''}
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
  fc.addEventListener("dragover", e => { e.preventDefault(); ov.classList.add("active"); });
  fc.addEventListener("dragleave", e => { if (!fc.contains(e.relatedTarget)) ov.classList.remove("active"); });
  fc.addEventListener("drop", e => {
    e.preventDefault(); ov.classList.remove("active");
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files);
  });
}
// ── NAVIGATION ──
function openFolder(folder) {
  breadcrumbs.push({ id: currentFolderId, name: currentFolderId ? breadcrumbs[breadcrumbs.length-1]?.name : currentCustomer.name });
  currentFolderId = folder.id;
  loadFileView();
}
function navTo(idx) {
  // idx = -1 means root, 0..n means breadcrumb index
  if (idx < 0) {
    currentFolderId = null;
    breadcrumbs = [];
  } else {
    const item = breadcrumbs[idx];
    currentFolderId = item.id;
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
  if (!isImage && !isPDF) {
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
    const objUrl = URL.createObjectURL(data);
    if (isImage) {
      document.getElementById("previewContent").innerHTML = `<img class="preview-img" src="${objUrl}" alt="${esc(file.name)}">`;
    } else {
      document.getElementById("previewContent").innerHTML = `<iframe class="preview-pdf" src="${objUrl}"></iframe>`;
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
// ── CONTEXT MENU ──
function showCtx(event, type, data) {
  event.stopPropagation();
  ctxTarget = { type, data };
  const menu = document.getElementById("ctxMenu");
  // Show/hide relevant items
  document.getElementById("ctxOpen").style.display = type === "folder" ? "flex" : "none";
  document.getElementById("ctxPreview").style.display = type === "file" ? "flex" : "none";
  document.getElementById("ctxDownload").style.display = type === "file" ? "flex" : "none";
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
