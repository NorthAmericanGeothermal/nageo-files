// NAGeo Files — app.js
// Update WORKER_BASE after deploying your Cloudflare Worker
const WORKER_BASE = "https://nageo-files.YOUR-SUBDOMAIN.workers.dev";
const REG_KEY = "nageo_files_reg";
const REG_CODE = "NAG-7X4K2-9M1PW-3Q8";

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

// ── INIT ──
document.addEventListener("DOMContentLoaded", () => {
  if (regCode === REG_CODE) {
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

  // Drag and drop
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
    const res = await fetch(`${WORKER_BASE}/api/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: input }),
    });
    const data = await res.json();
    if (data.ok) {
      localStorage.setItem(REG_KEY, input);
      regCode = input;
      showApp();
    } else {
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

// ── API HELPER ──
async function api(method, path, body = null, isFile = false) {
  const opts = {
    method,
    headers: { "X-Registration-Code": regCode },
  };
  if (body && !isFile) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  } else if (body && isFile) {
    opts.body = body; // ReadableStream for file upload
  }
  const res = await fetch(`${WORKER_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// ── CUSTOMERS ──
async function loadCustomers() {
  document.getElementById("customerList").innerHTML = '<div class="sidebar-msg">Loading customers from HCP…<br><small style="opacity:.6">This may take a moment</small></div>';
  try {
    // Load page by page until we have all customers with 5-digit IDs
    let page = 1;
    let all = [];
    while (true) {
      const data = await api("GET", `/api/customers?page=${page}`);
      all = all.concat(data.customers || []);
      if (!data.customers || data.customers.length < 50) break;
      page++;
      if (page > 20) break; // safety cap
    }
    // Sort by name
    all.sort((a, b) => a.name.localeCompare(b.name));
    allCustomers = all;
    filteredCustomers = all;
    renderCustomerList(all);
  } catch (e) {
    document.getElementById("customerList").innerHTML = `<div class="sidebar-msg">❌ Could not load customers.<br><small>${e.message}</small><br><br><button onclick="loadCustomers()" style="padding:8px 16px;background:var(--blue);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;">Try Again</button></div>`;
  }
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
  document.getElementById("fileContent").innerHTML = `
    <div class="drop-overlay" id="dropOverlay">
      <div class="drop-overlay-big">📂</div>
      <div class="drop-overlay-text">Drop files here to upload</div>
    </div>
    <div style="padding:2rem;text-align:center;color:var(--text3);">Loading…</div>
  `;
  rewireDrop();
  try {
    const [foldersData, filesData] = await Promise.all([
      api("GET", `/api/folders?customer_id=${currentCustomer.id}${currentFolderId ? '&parent_id=' + currentFolderId : ''}`),
      api("GET", `/api/files?customer_id=${currentCustomer.id}${currentFolderId ? '&folder_id=' + currentFolderId : ''}`),
    ]);
    renderFileView(foldersData, filesData);
  } catch (e) {
    document.getElementById("fileContent").innerHTML = `<div style="padding:2rem;text-align:center;color:var(--red);">❌ Could not load files.<br><small>${e.message}</small></div>`;
  }
}

function renderFileView(folders, files) {
  const el = document.getElementById("fileContent");
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
      html += `
        <div class="folder-card" ondblclick="openFolder(${JSON.stringify(f).replace(/"/g,'&quot;')})" onclick="openFolder(${JSON.stringify(f).replace(/"/g,'&quot;')})">
          <div class="card-icon">📁</div>
          <div class="card-name">${esc(f.name)}</div>
          <button class="card-menu" onclick="event.stopPropagation();showCtx(event,'folder',${JSON.stringify(f).replace(/"/g,'&quot;')})">⋯</button>
        </div>
      `;
    });
    html += `</div>`;
  }

  if (files.length) {
    html += `<div class="section-label">📄 Files</div><div class="file-grid">`;
    files.forEach(f => {
      html += `
        <div class="file-card" onclick="previewFile(${JSON.stringify(f).replace(/"/g,'&quot;')})">
          <div class="card-icon">${fileIcon(f.name)}</div>
          <div class="card-name">${esc(f.name)}</div>
          <div class="card-meta">${formatSize(f.size)}</div>
          <button class="card-menu" onclick="event.stopPropagation();showCtx(event,'file',${JSON.stringify(f).replace(/"/g,'&quot;')})">⋯</button>
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
  let html = `<button class="bc-item${currentFolderId ? '' : ' cur'}" onclick="navTo(-1)">📁 ${esc(currentCustomer?.name || '')}</button>`;
  breadcrumbs.forEach((b, i) => {
    html += `<span class="bc-sep">›</span><button class="bc-item${i === breadcrumbs.length - 1 && currentFolderId ? ' cur' : ''}" onclick="navTo(${i})">${esc(b.name || 'Folder')}</button>`;
  });
  el.innerHTML = html;
}

// ── FOLDERS ──
async function createFolder() {
  const name = document.getElementById("newFolderName").value.trim();
  if (!name) { document.getElementById("newFolderName").focus(); return; }
  document.getElementById("createFolderBtn").textContent = "Creating…";
  document.getElementById("createFolderBtn").disabled = true;
  try {
    await api("POST", "/api/folders", { customer_id: currentCustomer.id, name, parent_id: currentFolderId });
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
      const params = new URLSearchParams({
        customer_id: currentCustomer.id,
        file_name: file.name,
        file_size: file.size,
        ...(currentFolderId ? { folder_id: currentFolderId } : {}),
      });
      const res = await fetch(`${WORKER_BASE}/api/files/upload?${params}`, {
        method: "POST",
        headers: { "X-Registration-Code": regCode, "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(`❌ Failed to upload ${file.name}: ${err.error || "unknown error"}`, "err");
      }
    } catch (e) {
      toast(`❌ Failed to upload ${file.name}`, "err");
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
    const url = `${WORKER_BASE}/api/files/download?id=${file.id}`;
    const headers = { "X-Registration-Code": regCode };
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error("Could not load file");
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);

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
    const res = await fetch(`${WORKER_BASE}/api/files/download?id=${file.id}`, {
      headers: { "X-Registration-Code": regCode },
    });
    if (!res.ok) throw new Error("Download failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
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
    if (renameTarget.type === "folder") {
      await api("POST", "/api/folders/rename", { id: renameTarget.data.id, name });
    } else {
      await api("POST", "/api/files/rename", { id: renameTarget.data.id, name });
    }
    closeModal("modalRename");
    toast("✅ Renamed!", "ok");
    loadFileView();
  } catch (e) {
    toast("❌ " + e.message, "err");
  }
  renameTarget = null;
}

// ── DELETE ──
async function doDelete() {
  if (!deleteTarget) return;
  try {
    if (deleteTarget.type === "folder") {
      await api("DELETE", `/api/folders?id=${deleteTarget.data.id}`);
    } else {
      await api("DELETE", `/api/files/delete?id=${deleteTarget.data.id}`);
    }
    closeModal("modalDelete");
    toast("🗑️ Deleted", "ok");
    loadFileView();
  } catch (e) {
    toast("❌ " + e.message, "err");
  }
  deleteTarget = null;
}

// ── GLOBAL SEARCH ──
async function globalSearch(q) {
  try {
    const params = currentCustomer ? `?q=${encodeURIComponent(q)}&customer_id=${currentCustomer.id}` : `?q=${encodeURIComponent(q)}`;
    const data = await api("GET", `/api/search${params}`);
    showSearchResults(q, data.files || [], data.folders || []);
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
      <div class="sr-info"><div class="sr-name">${esc(f.name)}</div><div class="sr-sub">${formatSize(f.size)} · ${f.customer_id}</div></div>
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
    const files = await api("GET", `/api/files?customer_id=${customerId}${folderId ? '&folder_id=' + folderId : ''}`);
    const file = (files || []).find(f => f.id === fileId);
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
