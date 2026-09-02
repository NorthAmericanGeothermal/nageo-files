// NAGeo Files — app.js (Supabase-backed — replaces the old Cloudflare Worker)
const SUPABASE_URL = "https://hpgwwegjsxyxovdattoc.supabase.co";
const SUPABASE_KEY = "sb_publishable_D2PqYQoJjZ8koEM9NPvmeg_KB_Wa66H";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const HCP_CUSTOMERS_URL = SUPABASE_URL + "/functions/v1/nageo-files-hcp-customers";
const SEARCH_EMAILS_URL = SUPABASE_URL + "/functions/v1/nageo-files-search-emails";
const THREAD_SUMMARY_URL = SUPABASE_URL + "/functions/v1/nageo-files-thread-summary";
const SMART_MERGE_URL = SUPABASE_URL + "/functions/v1/nageo-files-smart-merge";
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
// Customer sidebar sort — 'name' (default, A–Z) or 'recent' (most recently
// emailed first; there's deliberately no "oldest emailed" option, this is
// purely for surfacing who needs attention). lastEmailedByCustomer maps
// customer_id -> timestamp (ms) of their newest saved email, loaded lazily
// the first time "recent" sort is selected and refreshed on every re-sync/
// organize pass so it reflects newly-saved emails.
let customerSortOrder = localStorage.getItem("nageo_files_customer_sort") === "recent" ? "recent" : "name";
let lastEmailedByCustomer = {};
let lastEmailedLoaded = false;
let currentCustomer = null;
let currentFolderId = null;
let currentFolderIsSystem = false; // true while viewing inside the locked Emails folder
// The current folder's own DB row (name, is_system, gmail_thread_id,
// ai_overview, …) — fetched fresh on every navigation in loadFileView so the
// AI overview panel always reflects the latest saved summary, including
// right after clicking Regenerate. null at the customer root.
let currentFolderRow = null;
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
let lastFolderCounts = {}; // folder id -> message count, for subject-thread folders' "N emails" badge
let threadSortOrder = localStorage.getItem("nageo_files_thread_sort") || "newest"; // "newest" | "oldest", for the Emails overview page
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
  document.getElementById("organizeAllBtn").addEventListener("click", startOrganizeAllCustomers);
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
  // Email tools — collapsed under one "📧 Email Tools" dropdown so the
  // action bar doesn't keep growing as more email (and eventually other
  // file-type) features get added.
  document.getElementById("emailToolsBtn").addEventListener("click", function (e) { e.stopPropagation(); toggleEmailToolsDropdown(); });
  document.getElementById("searchEmailBtn").addEventListener("click", function () { closeEmailToolsDropdown(); openSearchEmailsModal(); });
  document.getElementById("organizeEmailsBtn").addEventListener("click", function () { closeEmailToolsDropdown(); runOrganizeForCurrentCustomer(); });
  document.getElementById("smartMergeBtn").addEventListener("click", function () { closeEmailToolsDropdown(); openSmartMergeModal(); });
  document.addEventListener("click", function (e) {
    var dd = document.getElementById("emailToolsDropdown");
    if (dd && dd.classList.contains("show") && !dd.contains(e.target)) closeEmailToolsDropdown();
  });
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
    if (customerSortOrder === "recent" && !lastEmailedLoaded) {
      await loadLastEmailedDates();
    }
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
    (Array.isArray(c.emails) ? c.emails : [c.email]).some(e => (e || "").toLowerCase().includes(lq)) ||
    c.phone.includes(lq)
  );
  renderCustomerList(filteredCustomers);
}
// Customer sidebar sort — reads customerSortOrder + lastEmailedByCustomer
// (see setCustomerSortOrder/loadLastEmailedDates). Customers with no saved
// email at all sink to the bottom under "recent" sort, alphabetically among
// themselves, rather than being hidden or thrown to a random spot.
function sortCustomersForDisplay(customers) {
  var arr = customers.slice();
  if (customerSortOrder === "recent") {
    arr.sort(function (a, b) {
      var ta = lastEmailedByCustomer[a.id] || -Infinity;
      var tb = lastEmailedByCustomer[b.id] || -Infinity;
      if (tb !== ta) return tb - ta;
      return a.name.localeCompare(b.name);
    });
  } else {
    arr.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  return arr;
}
function setCustomerSortOrder(v) {
  customerSortOrder = (v === "recent") ? "recent" : "name";
  localStorage.setItem("nageo_files_customer_sort", customerSortOrder);
  if (customerSortOrder === "recent" && !lastEmailedLoaded) {
    document.getElementById("customerList").innerHTML = '<div class="sidebar-msg">Loading last-emailed dates…</div>';
    loadLastEmailedDates().then(function () { renderCustomerList(filteredCustomers); });
  } else {
    renderCustomerList(filteredCustomers);
  }
}
// Pulls every saved email file's effective date (same bestFileDate() logic
// the thread view trusts) grouped by customer, keeping only the newest per
// customer. Paginated since a shop with a lot of email history can easily
// have more saved emails than a single query page. Lazy — only runs the
// first time "Recently Emailed" sort is picked — and re-runs on every pick
// after a sync/organize pass so it can't go stale (see syncOneCustomer /
// syncAllCustomers / runOrganizePass).
async function loadLastEmailedDates() {
  var map = {};
  var pageSize = 1000;
  var from = 0;
  try {
    while (true) {
      var res = await sb.from("nageo_files_files")
        .select("customer_id, name, email_date, created_at")
        .not("gmail_message_id", "is", null)
        .range(from, from + pageSize - 1);
      if (res.error) throw res.error;
      var rows = res.data || [];
      rows.forEach(function (f) {
        var d = bestFileDate(f);
        if (!d) return;
        var t = new Date(d).getTime();
        if (isNaN(t)) return;
        if (!map[f.customer_id] || t > map[f.customer_id]) map[f.customer_id] = t;
      });
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    lastEmailedByCustomer = map;
    lastEmailedLoaded = true;
  } catch (e) {
    toast("❌ Could not load last-emailed dates: " + e.message, "err");
  }
}
function renderCustomerList(customers) {
  const el = document.getElementById("customerList");
  var sortSelect = document.getElementById("customerSortSelect");
  if (sortSelect && sortSelect.value !== customerSortOrder) sortSelect.value = customerSortOrder;
  if (!customers.length) {
    el.innerHTML = '<div class="sidebar-msg">No customers found.<br><small>Try a different search term.</small></div>';
    return;
  }
  var sorted = sortCustomersForDisplay(customers);
  el.innerHTML = sorted.map(c => {
    var lastEmailed = customerSortOrder === "recent" ? lastEmailedByCustomer[c.id] : null;
    var metaExtra = lastEmailed ? ' · Emailed ' + formatAmericanDate(lastEmailed) : (customerSortOrder === "recent" ? ' · No emails saved' : '');
    return `
    <div class="customer-item${currentCustomer && currentCustomer.id === c.id ? ' active' : ''}" onclick="selectCustomer('${c.id}')">
      <div class="customer-avatar">${initials(c.name)}</div>
      <div class="customer-info">
        <div class="customer-name">${esc(c.name)}</div>
        <div class="customer-meta">#${esc(c.customer_id)}${c.address ? ' · ' + esc(c.address) : ''}${esc(metaExtra)}</div>
      </div>
    </div>
  `;
  }).join("");
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
  // Fetch the current folder's own row fresh on every navigation (not
  // cached) so the AI overview panel always reflects the latest saved
  // summary — important right after clicking Regenerate.
  currentFolderRow = null;
  if (currentFolderId) {
    try {
      const { data } = await sb.from("nageo_files_folders").select("*").eq("id", currentFolderId).single();
      currentFolderRow = data || null;
    } catch (e) { currentFolderRow = null; }
  }
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
    // For any subject-thread subfolders in this view, fetch how many
    // messages each one holds in one batched query, so the folder cards can
    // show a "N emails" count badge instead of making the user open each one
    // to see whether it's a single message or a 40-message conversation.
    var subjectFolderIds = lastFolders.filter(function (f) { return f.subject_key; }).map(function (f) { return f.id; });
    lastFolderCounts = {};
    if (subjectFolderIds.length) {
      try {
        const { data: countRows, error: countErr } = await sb.from("nageo_files_files")
          .select("folder_id").eq("customer_id", currentCustomer.id).in("folder_id", subjectFolderIds);
        if (!countErr && countRows) {
          countRows.forEach(function (row) {
            lastFolderCounts[row.folder_id] = (lastFolderCounts[row.folder_id] || 0) + 1;
          });
        }
      } catch (e) { /* count badge is cosmetic only — skip silently on failure */ }
    }
    renderThreadOverviewBar(); // after lastFiles loads, so the thread header's count is accurate
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
    const isThreadList = folders.some(f => f.subject_key);
    if (isThreadList) {
      html += renderThreadFolderList(folders);
    } else {
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
  }
  if (files.length) {
    const isEmailList = currentFolderIsSystem && files.some(f => f.gmail_message_id);
    if (isEmailList) {
      html += renderEmailFileList(files);
    } else {
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
  }
  el.innerHTML = html;
  rewireDrop();
}
// Renders the thread-folder list for a customer's 📧 Emails overview page as
// horizontal rows rather than the small square grid regular folders use —
// a thread needs room for its subject, a snippet of its most recent
// message, its message count, and a "last active" date to be useful at a
// glance, none of which fit a square tile well.
function renderThreadFolderList(folders) {
  var sorted = folders.slice().sort(function (a, b) {
    var da = a.last_message_at || a.first_message_at || a.created_at || 0;
    var db = b.last_message_at || b.first_message_at || b.created_at || 0;
    return threadSortOrder === "oldest" ? (new Date(da) - new Date(db)) : (new Date(db) - new Date(da));
  });
  var html = `<div class="section-label thread-list-label">
    <span>💬 Email Threads</span>
    <select class="thread-sort-select" onchange="setThreadSortOrder(this.value)">
      <option value="newest"${threadSortOrder === "newest" ? " selected" : ""}>Newest first</option>
      <option value="oldest"${threadSortOrder === "oldest" ? " selected" : ""}>Oldest first</option>
    </select>
  </div><div class="thread-list">`;
  sorted.forEach(function (f) {
    var isSys = !!f.is_system;
    var dataAttr = JSON.stringify(f).replace(/"/g, '&quot;');
    var key = "folder:" + f.id;
    var selected = selectedItems.has(key);
    var clickHandler = (selectMode && !isSys) ? `toggleItemSelect('folder', ${dataAttr})` : `openFolder(${dataAttr})`;
    var msgCount = lastFolderCounts[f.id] || 0;
    var dateStr = formatAmericanDate(f.last_message_at || f.first_message_at);
    var subjectText = (f.name || "").replace(/^💬\s*/, "");
    html += `
      <div class="thread-row${selected ? ' card-selected' : ''}" onclick="${clickHandler}">
        ${(selectMode && !isSys) ? `<div class="card-checkbox${selected ? ' checked' : ''}"></div>` : `<div class="thread-row-icon">💬</div>`}
        <div class="thread-row-main">
          <div class="thread-row-top">
            <span class="thread-row-subject">${esc(subjectText)}</span>
            ${dateStr ? `<span class="thread-row-date">${esc(dateStr)}</span>` : ''}
          </div>
          ${f.latest_snippet ? `<div class="thread-row-snippet">${esc(f.latest_snippet)}</div>` : ''}
        </div>
        <div class="thread-row-right">
          <span class="thread-row-count">${msgCount} email${msgCount === 1 ? '' : 's'}</span>
          ${isSys ? `<span class="card-system-badge" title="Auto-synced from Search Emails — protected, can't be renamed, moved, or deleted">🔒</span>` : ''}
        </div>
      </div>
    `;
  });
  html += `</div>`;
  return html;
}
// American month/day/year, always with the full year (never omitted) so a
// date badge can't be misread — e.g. "8/26/2026", not "Aug 26".
function formatAmericanDate(v) {
  if (!v) return "";
  var d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear();
}
function setThreadSortOrder(v) {
  threadSortOrder = (v === "oldest") ? "oldest" : "newest";
  localStorage.setItem("nageo_files_thread_sort", threadSortOrder);
  renderFileView(lastFolders, lastFiles);
}
// Renders the actual saved-email list — used both inside a thread subfolder
// and in the (rare) flat 📧 Emails root — as horizontal rows with subject,
// sender, a formatted date, and a preview snippet, instead of the plain
// square file tiles regular uploaded files use. Shares the same
// Newest/Oldest sort preference as the thread-folder list above.
function renderEmailFileList(files) {
  var sorted = files.slice().sort(function (a, b) {
    var da = bestFileDate(a) || 0;
    var db = bestFileDate(b) || 0;
    return threadSortOrder === "oldest" ? (new Date(da) - new Date(db)) : (new Date(db) - new Date(da));
  });
  var html = `<div class="section-label thread-list-label">
    <span>📄 Emails</span>
    <select class="thread-sort-select" onchange="setThreadSortOrder(this.value)">
      <option value="newest"${threadSortOrder === "newest" ? " selected" : ""}>Newest first</option>
      <option value="oldest"${threadSortOrder === "oldest" ? " selected" : ""}>Oldest first</option>
    </select>
  </div><div class="thread-list">`;
  sorted.forEach(function (f) {
    var key = "file:" + f.id;
    var selected = selectedItems.has(key);
    var dataAttr = JSON.stringify(f).replace(/"/g, '&quot;');
    var clickHandler = selectMode ? `toggleItemSelect('file', ${dataAttr})` : `previewFile(${dataAttr})`;
    var dateStr = formatAmericanDate(bestFileDate(f));
    var subjectText = bestFileSubject(f);
    var senderText = shortSenderName(f.sender);
    html += `
      <div class="thread-row${selected ? ' card-selected' : ''}" onclick="${clickHandler}">
        ${selectMode ? `<div class="card-checkbox${selected ? ' checked' : ''}"></div>` : `<div class="thread-row-icon">✉️</div>`}
        <div class="thread-row-main">
          <div class="thread-row-top">
            <span class="thread-row-subject">${esc(subjectText)}</span>
            ${dateStr ? `<span class="thread-row-date">${esc(dateStr)}</span>` : ''}
          </div>
          <div class="thread-row-meta-line">
            ${senderText ? `<span class="thread-row-sender">${esc(senderText)}</span>` : ''}
            ${f.snippet ? `<span class="thread-row-snippet">${esc(f.snippet)}</span>` : ''}
          </div>
        </div>
        ${selectMode ? '' : `<button class="email-row-menu" onclick="event.stopPropagation();showCtx(event,'file',${dataAttr})">⋯</button>`}
      </div>
    `;
  });
  html += `</div>`;
  return html;
}
// Trims a "Name <email@x.com>" From header down to just the display name
// (falls back to the bare address if there's no name) for a compact row.
function shortSenderName(from) {
  if (!from) return "";
  var m = from.match(/^"?([^"<]+)"?\s*<[^>]+>$/);
  var name = m ? m[1].trim() : from.trim();
  return name.length > 40 ? name.slice(0, 40) + "…" : name;
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
// ── AI THREAD OVERVIEW — only shown when currentFolderRow is one of the
// auto-created subject subfolders (has subject_key set). On-demand only:
// nothing is summarized until someone actually clicks the button, and the
// result is saved on the folder row and reused until Regenerate is clicked. ──
function renderThreadOverviewBar() {
  var el = document.getElementById("threadOverviewBar");
  if (!el) return;
  if (!currentFolderRow || !currentFolderRow.subject_key) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "block";
  var backBtn = '<button class="back-to-threads-btn" id="backToThreadsBtn">← Back to Email Threads</button>';
  // Thread header — the subject, how many emails, and the date span — so
  // it's clear which conversation you're looking at without relying on the
  // (often-truncated) breadcrumb above.
  var subjectText = (currentFolderRow.name || "").replace(/^💬\s*/, "");
  var count = lastFiles.length;
  var firstStr = formatAmericanDate(currentFolderRow.first_message_at);
  var lastStr = formatAmericanDate(currentFolderRow.last_message_at);
  var rangeStr = (firstStr && lastStr) ? (firstStr === lastStr ? firstStr : (firstStr + " – " + lastStr)) : (firstStr || lastStr || "");
  var header = '<div class="thread-page-header">'
    + '<div class="thread-page-title">💬 ' + esc(subjectText) + '</div>'
    + '<div class="thread-page-meta">' + count + ' email' + (count === 1 ? '' : 's') + (rangeStr ? ' · ' + esc(rangeStr) : '') + '</div>'
    + '</div>';
  if (currentFolderRow.ai_overview) {
    var when = currentFolderRow.ai_overview_generated_at ? new Date(currentFolderRow.ai_overview_generated_at).toLocaleString() : "";
    el.innerHTML = backBtn + header + '<div class="ai-overview-card">'
      + '<div class="ai-overview-hdr"><span>✨ AI Overview</span><span class="ai-overview-when">' + esc(when) + '</span></div>'
      + '<div class="ai-overview-text">' + esc(currentFolderRow.ai_overview).replace(/\n/g, '<br>') + '</div>'
      + '<button class="ai-overview-btn" id="aiOverviewBtn">🔄 Regenerate</button>'
      + '</div>';
  } else {
    el.innerHTML = backBtn + header + '<div class="ai-overview-card ai-overview-empty">'
      + '<div class="ai-overview-empty-text">Get a quick AI-written summary of this whole email thread — generated once, on demand, and reused until you click Regenerate.</div>'
      + '<button class="ai-overview-btn" id="aiOverviewBtn">✨ Get AI Overview</button>'
      + '</div>';
  }
  var btn = document.getElementById("aiOverviewBtn");
  if (btn) btn.addEventListener("click", requestAiOverview);
  var back = document.getElementById("backToThreadsBtn");
  if (back) back.addEventListener("click", goBackToThreads);
}
// Jumps back up to the parent folder — for a thread subfolder, that's
// always the customer's 📧 Emails overview page. Reuses the same breadcrumb
// navigation navTo() already does, just aimed one level up.
function goBackToThreads() {
  if (breadcrumbs.length) navTo(breadcrumbs.length - 1);
  else navTo(-1);
}
async function requestAiOverview() {
  if (!currentFolderRow || !currentCustomer) return;
  var btn = document.getElementById("aiOverviewBtn");
  var wasRegenerate = !!currentFolderRow.ai_overview;
  if (btn) { btn.disabled = true; btn.textContent = "Summarizing…"; }
  try {
    const res = await fetch(THREAD_SUMMARY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SUPABASE_KEY, "apikey": SUPABASE_KEY },
      body: JSON.stringify({ customer_id: currentCustomer.id, folder_id: currentFolderRow.id }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentFolderRow.ai_overview = data.overview;
    currentFolderRow.ai_overview_generated_at = data.generated_at || new Date().toISOString();
    renderThreadOverviewBar();
    toast(wasRegenerate ? "✨ Overview regenerated." : "✨ AI overview ready.", "ok");
  } catch (e) {
    toast("❌ Could not generate overview: " + e.message, "err");
    if (btn) { btn.disabled = false; btn.textContent = wasRegenerate ? "🔄 Regenerate" : "✨ Get AI Overview"; }
  }
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
// Normalizes a subject into the key subfolders are grouped by — strips any
// number of leading Re:/Fwd:/Fw:/Aw: prefixes (any casing, ":" or "-" after
// them), collapses whitespace, and lowercases. Deliberately NOT based on
// Gmail's own thread id: Gmail splits what a person would call "the same
// conversation" into multiple separate thread ids far too often (gaps in
// time, a reply missing proper References headers, etc.), so grouping by
// the actual subject text is what makes "North American GeoThermal - Quote"
// and "Re: North American GeoThermal - Quote" and "Re: Re: North American
// GeoThermal - Quote" all land in one folder together.
function normalizeSubject(subject) {
  var s = (subject || "").trim();
  var prefixRe = /^(re|fw|fwd|aw)[:\-]\s*/i;
  var changed = true;
  while (changed) {
    var next = s.replace(prefixRe, "");
    changed = next !== s;
    s = next.trim();
  }
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s || "(no subject)";
}
// Finds (or creates) the locked subfolder a message belongs in, keyed by its
// normalized subject (see normalizeSubject) — not by Gmail's thread id or
// which connected account found it, so replies scattered across separate
// Gmail threads (or cc'd to a different one of your connected accounts)
// still land in the same one folder. `cache` is a plain object the caller
// passes in and reuses across one saveEmailsToFolder call, so a 40-message
// thread doesn't do 40 redundant lookups.
async function getOrCreateSubjectFolder(customerId, emailsFolderId, r, cache) {
  var subjectKey = normalizeSubject(r.subject);
  if (cache[subjectKey]) return cache[subjectKey];
  const { data: existing, error: findErr } = await sb.from("nageo_files_folders")
    .select("*").eq("customer_id", customerId).eq("subject_key", subjectKey).limit(1);
  if (findErr) throw findErr;
  if (existing && existing.length) { cache[subjectKey] = existing[0]; return existing[0]; }
  var emailDate = parseDateSafe(r.date);
  const { data, error } = await sb.from("nageo_files_folders").insert({
    customer_id: customerId,
    parent_id: emailsFolderId,
    name: threadFolderName(r.subject),
    is_system: true,
    subject_key: subjectKey,
    gmail_thread_id: r.gmail_thread_id || null, // informational only — whichever message created this folder
    gmail_account: r.account || null,
    first_message_at: emailDate,
    last_message_at: emailDate,
    latest_snippet: r.snippet || null,
  }).select().single();
  if (error) {
    if (error.code === "23505") {
      // Unique-violation race — another concurrent save just created this
      // exact subject folder a moment ago. Fetch it instead of failing.
      const { data: raced } = await sb.from("nageo_files_folders")
        .select("*").eq("customer_id", customerId).eq("subject_key", subjectKey).limit(1).single();
      if (raced) { cache[subjectKey] = raced; return raced; }
    }
    throw error;
  }
  cache[subjectKey] = data;
  return data;
}
// The date shown on a thread's card comes from last_message_at (kept fresh
// by refreshFolderActivity), not a date baked into the folder name — so the
// name is just the subject, nothing else.
function threadFolderName(subject) {
  var base = (subject && subject.trim()) ? subject.trim() : "(no subject)";
  base = base.replace(/[\\/:*?"<>|]/g, "-").slice(0, 70).trim() || "email";
  return "💬 " + base;
}
function parseDateSafe(v) {
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
// Pulls the From / Date / Subject values back out of an archived email's
// stored HTML (see buildEmailArchiveHtml — these are always rendered in that
// exact "<strong>Field:</strong> value</div>" header block). Used only by
// organizeCustomerEmails to backfill legacy rows that were saved before the
// subject/dedup_key columns existed, so it only ever has to run once per
// old file, not on every organize pass.
function parseHeaderFieldsFromHtml(html) {
  function grab(label) {
    var m = html.match(new RegExp("<strong>" + label + ":<\\/strong>\\s*([^<]*)<\\/div>", "i"));
    if (!m) return "";
    return m[1]
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
  }
  var from = grab("From");
  var date = grab("Date");
  var subject = grab("Subject");
  return {
    from: from === "—" ? "" : from,
    date: date === "—" ? "" : date,
    subject: (subject === "(no subject)" || subject === "—") ? "" : subject,
  };
}
// Pulls just the bare email address out of a "Name <addr@x.com>" or plain
// "addr@x.com" From header, lowercased — part of the composite dedup key,
// since the exact display-name formatting can vary slightly copy to copy but
// the address itself never does.
function normalizeFromAddress(from) {
  var m = (from || "").match(/<([^>]+)>/);
  var addr = m ? m[1] : (from || "");
  return addr.trim().toLowerCase();
}
// The fallback "same physical email" fingerprint for rows that don't have an
// rfc822_message_id (i.e. everything saved before that column existed).
// Subject + sender address + the email's own Date header are all identical
// on every copy of one physical email regardless of which connected account
// received it, so this composite is a reliable stand-in.
function computeDedupKey(subject, from, date) {
  var subjectKey = normalizeSubject(subject);
  var fromKey = normalizeFromAddress(from);
  var dateKey = "";
  if (date) {
    var d = new Date(date);
    if (!isNaN(d.getTime())) dateKey = d.toISOString();
  }
  if (!fromKey && !dateKey) return null; // not enough signal to trust this as a fingerprint
  return subjectKey + "|" + fromKey + "|" + dateKey;
}
// Best-effort subject/date guess from a saved file's name ("2024-03-01 Some
// Subject.html") — the filename always has this baked in from the moment
// the file was first saved (see sanitizeEmailFileName), with zero risk of
// failure, unlike downloading and parsing the archived HTML. This is the
// PRIMARY source organizeCustomerEmails uses to backfill a legacy row's
// subject — a failed/slow storage download can no longer cause a real,
// subject-bearing email to get dumped into a bogus "(no subject)" bucket.
function deriveSubjectFromFileName(name) {
  var base = (name || "").replace(/\.html$/i, "");
  base = base.replace(/^\d{4}-\d{2}-\d{2}\s+/, "");
  return base.trim() || "(no subject)";
}
function deriveDateFromFileName(name) {
  var m = (name || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  var d = new Date(m[1] + "-" + m[2] + "-" + m[3] + "T12:00:00Z"); // noon UTC avoids a timezone shifting it a day off
  return isNaN(d.getTime()) ? null : d.toISOString();
}
// Best available date/subject for a file, computed live at render/sort time
// — trusts the filename (immutable, correct since the moment the email was
// first saved) over a stored email_date/subject that might still be stale
// or never got backfilled, so the UI shows the right thing immediately
// rather than waiting on the next Organize pass to catch up. created_at is
// only used as an absolute last resort (a file whose name has no date
// prefix at all, e.g. a very old or manually-renamed file).
function bestFileDate(f) {
  return deriveDateFromFileName(f.name) || f.email_date || f.created_at;
}
function bestFileSubject(f) {
  var fromName = deriveSubjectFromFileName(f.name);
  if (fromName !== "(no subject)") return fromName;
  return f.subject || fromName;
}
// Pulls a short plain-text preview out of an archived email's body (not its
// header block) — the source for a thread folder's latest_snippet, so the
// UI can show "what's this thread about" without opening it.
function derivePlainSnippet(html) {
  var m = (html || "").match(/<div class="email-body">([\s\S]*?)<\/div>\s*<\/body>/i);
  var raw = m ? m[1] : (html || "");
  var text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
  return text.slice(0, 220);
}
// Recomputes first_message_at / last_message_at / latest_snippet on each
// given folder from its member files' email_date — so a thread's card
// always shows an accurate "most recent activity" date (not a frozen
// creation-time date) and a preview of whichever message is newest. Call
// after any batch of saves/moves/merges.
async function refreshFolderActivity(customerId, folderIds) {
  var ids = Array.from(new Set((folderIds || []).filter(Boolean)));
  if (!ids.length) return;
  const { data: rows, error } = await sb.from("nageo_files_files")
    .select("folder_id, email_date, snippet, created_at, name").eq("customer_id", customerId).in("folder_id", ids);
  if (error || !rows) return;
  var byFolder = {};
  rows.forEach(function (r) {
    var d = bestFileDate(r);
    if (!d || !r.folder_id) return;
    var g = byFolder[r.folder_id];
    if (!g) { g = byFolder[r.folder_id] = { min: d, max: d, maxSnippet: r.snippet || "" }; return; }
    if (new Date(d) < new Date(g.min)) g.min = d;
    if (new Date(d) >= new Date(g.max)) { g.max = d; g.maxSnippet = r.snippet || g.maxSnippet; }
  });
  await Promise.all(ids.map(async function (id) {
    var g = byFolder[id];
    if (!g) return;
    try {
      await sb.from("nageo_files_folders")
        .update({ first_message_at: g.min, last_message_at: g.max, latest_snippet: g.maxSnippet || null })
        .eq("id", id);
    } catch (e) { /* cosmetic only */ }
  }));
}
// ── ORGANIZE SAVED EMAILS ─────────────────────────────────────────────────
// Cleans up a customer's already-saved emails WITHOUT talking to Gmail at
// all — this is what makes it safe to run any time, and what makes it able
// to fix emails that no longer show up in a fresh Gmail search (e.g. deleted
// or archived on Gmail's side since they were saved): nothing here is ever
// removed just for being "not found" — it only reads what's already in the
// database.
//   1. Backfills subject (always from the filename — instant, can't fail)
//      plus email_date/snippet/dedup_key (from the archived HTML, best
//      effort) onto any legacy row that predates those columns.
//   2. Merges true duplicates — rows sharing the same dedup_key (or the same
//      rfc822_message_id, for newer rows) — keeping the earliest saved copy.
//   3. Moves every remaining file into its correct subject folder, creating
//      folders as needed.
//   4. Refreshes last_message_at/latest_snippet on every touched folder.
//   5. Deletes any now-empty locked subfolder under Emails.
// Runs automatically after every search/sync; also runs on demand from the
// "🗂️ Organize" button so already-saved customers don't need a fresh Gmail
// search just to get filed correctly.
async function organizeCustomerEmails(customerId, opts) {
  opts = opts || {};
  const { data: emailsFolderRows } = await sb.from("nageo_files_folders")
    .select("*").eq("customer_id", customerId).is("parent_id", null).eq("is_system", true).limit(1);
  const emailsFolder = emailsFolderRows && emailsFolderRows[0];
  if (!emailsFolder) return { moved: 0, merged: 0, foldersRemoved: 0, backfilled: 0 };

  const { data: subfolders } = await sb.from("nageo_files_folders")
    .select("*").eq("customer_id", customerId).eq("parent_id", emailsFolder.id);
  const folderIds = [emailsFolder.id].concat((subfolders || []).map(function (f) { return f.id; }));

  const { data: files, error: filesErr } = await sb.from("nageo_files_files")
    .select("*").eq("customer_id", customerId).in("folder_id", folderIds).order("created_at");
  if (filesErr || !files || !files.length) return { moved: 0, merged: 0, foldersRemoved: 0, backfilled: 0 };

  // 1. Re-derive subject/email_date from the filename EVERY pass (not just
  // when missing) + backfill sender/snippet/dedup_key from the archived
  // HTML, best-effort. This used to only fill in a NULL subject/email_date,
  // which meant a row that got stuck with a wrong value early on (e.g.
  // literally "(no subject)" from before subject-derivation existed) could
  // never self-correct — it wasn't null, just wrong, so it looked "already
  // done" and was skipped forever. The filename is immutable and was always
  // correct from the moment the email was first saved (see
  // sanitizeEmailFileName), so it's trusted over a previously-stored value
  // whenever the stored value looks like a generic fallback rather than a
  // real one.
  var backfilled = 0;
  for (const f of files) {
    var subjectFromName = deriveSubjectFromFileName(f.name);
    var subject = (f.subject && f.subject !== "(no subject)") ? f.subject
      : (subjectFromName !== "(no subject)") ? subjectFromName
      : (f.subject || subjectFromName);
    var dateFromName = deriveDateFromFileName(f.name);
    var emailDate = dateFromName || f.email_date;
    var dedupKey = f.dedup_key || f.rfc822_message_id || null;
    var snippet = f.snippet || null;
    var sender = f.sender || null;
    // Download is needed if we're still missing the snippet or sender (only
    // recoverable from the archived HTML), if we have neither an
    // rfc822_message_id nor a dedup_key yet (no reliable dedup fingerprint
    // at all), if the subject is still stuck on the generic fallback (the
    // filename had none — a real one might still be recoverable from the
    // HTML's Subject header), or if the filename had no usable date prefix.
    var needsHtml = !f.snippet || !f.sender || (!f.rfc822_message_id && !dedupKey) || subject === "(no subject)" || !emailDate;
    if (needsHtml) {
      try {
        const { data: blob, error: dlErr } = await sb.storage.from(STORAGE_BUCKET).download(f.storage_path);
        if (!dlErr && blob) {
          const html = await blob.text();
          const parsed = parseHeaderFieldsFromHtml(html);
          if (subject === "(no subject)" && parsed.subject) subject = parsed.subject;
          if (!emailDate) emailDate = parseDateSafe(parsed.date);
          if (!f.rfc822_message_id && !dedupKey) dedupKey = computeDedupKey(subject, parsed.from, parsed.date || emailDate);
          if (!f.snippet) snippet = derivePlainSnippet(html);
          if (!f.sender && parsed.from) sender = parsed.from;
        }
      } catch (e) { /* proceed with whatever we already have — never blocks subject/date */ }
    }
    var patch = {};
    if (subject && subject !== f.subject) patch.subject = subject;
    if (dedupKey && dedupKey !== f.dedup_key) patch.dedup_key = dedupKey;
    if (emailDate && emailDate !== f.email_date) patch.email_date = emailDate;
    if (snippet && snippet !== f.snippet) patch.snippet = snippet;
    if (sender && sender !== f.sender) patch.sender = sender;
    if (Object.keys(patch).length) {
      try {
        const { error: updErr } = await sb.from("nageo_files_files").update(patch).eq("id", f.id);
        if (!updErr) { Object.assign(f, patch); backfilled++; }
      } catch (e) { /* leave for next time */ }
    }
  }

  // 2. Merge true duplicates — group by rfc822_message_id first (most
  // reliable), then by dedup_key for whatever's left ungrouped.
  var groups = {};
  files.forEach(function (f) {
    var key = f.rfc822_message_id ? ("rfc:" + f.rfc822_message_id) : (f.dedup_key ? ("dk:" + f.dedup_key) : null);
    if (!key) return; // nothing to group this one by — leave it alone, never guess-delete
    (groups[key] = groups[key] || []).push(f);
  });
  var merged = 0;
  var removedIds = {};
  for (const key in groups) {
    var group = groups[key];
    if (group.length < 2) continue;
    group.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    for (var i = 1; i < group.length; i++) {
      var dupe = group[i];
      try {
        await sb.storage.from(STORAGE_BUCKET).remove([dupe.storage_path]);
        await sb.from("nageo_files_files").delete().eq("id", dupe.id);
        removedIds[dupe.id] = true;
        merged++;
      } catch (e) { /* leave it rather than risk losing data */ }
    }
  }
  var survivors = files.filter(function (f) { return !removedIds[f.id]; });

  // 3. Regroup survivors into their correct subject folder.
  var subjectFolderCache = {};
  (subfolders || []).forEach(function (f) { if (f.subject_key) subjectFolderCache[f.subject_key] = f; });
  var moved = 0;
  var touchedFolderIds = {};
  for (const f of survivors) {
    var subjectKey = normalizeSubject(f.subject);
    var folder = subjectFolderCache[subjectKey];
    if (!folder) {
      try {
        folder = await getOrCreateSubjectFolder(customerId, emailsFolder.id, { subject: f.subject, date: f.email_date || f.created_at, snippet: f.snippet }, subjectFolderCache);
      } catch (e) { continue; }
    }
    touchedFolderIds[folder.id] = true;
    if (f.folder_id !== folder.id) {
      try {
        await sb.from("nageo_files_files").update({ folder_id: folder.id, updated_at: new Date().toISOString() }).eq("id", f.id);
        moved++;
      } catch (e) { /* leave it where it is */ }
    }
  }

  // 4. Bring last_message_at/latest_snippet up to date on every folder this
  // pass touched (new ones already have it right from creation, but a
  // folder that gained/lost files needs its span recomputed).
  try { await refreshFolderActivity(customerId, Object.keys(touchedFolderIds)); } catch (e) { /* cosmetic only */ }

  // 5. Delete any locked subfolder under Emails left with zero files —
  // covers both old gmail_thread_id-based folders and any subject folder
  // that lost all its files to a dedup merge above.
  var foldersRemoved = 0;
  const { data: freshSubfolders } = await sb.from("nageo_files_folders")
    .select("id").eq("customer_id", customerId).eq("parent_id", emailsFolder.id);
  for (const f of (freshSubfolders || [])) {
    try {
      const { count } = await sb.from("nageo_files_files").select("id", { count: "exact", head: true }).eq("folder_id", f.id);
      if (!count) { await sb.from("nageo_files_folders").delete().eq("id", f.id); foldersRemoved++; }
    } catch (e) { /* cosmetic only */ }
  }

  if (!opts.silent && (moved || merged || foldersRemoved) && currentCustomer && currentCustomer.id === customerId) {
    loadFileView();
  }
  // Every sync path (single-profile and global) runs this organize pass
  // afterward, so this is the one shared spot to know "email data may have
  // changed" — invalidate the last-emailed cache so it gets rebuilt rather
  // than staying stale. Skip the immediate reload+re-render when called
  // silently in a bulk loop (startOrganizeAllCustomers) — that would mean
  // one full re-scan per customer; the bulk caller does a single reload of
  // its own once the whole loop finishes instead.
  lastEmailedLoaded = false;
  if (!opts.silent && customerSortOrder === "recent") {
    loadLastEmailedDates().then(function () {
      if (document.getElementById("customerList")) renderCustomerList(filteredCustomers);
    });
  }
  return { moved, merged, foldersRemoved, backfilled };
}
// Wires the "🗂️ Organize Emails" button — runs organizeCustomerEmails for
// whichever customer is currently open, with a toast summarizing what
// changed. Purely a cleanup pass on already-saved data; never contacts
// Gmail, so it's safe to click any time and never removes an email just
// because it's no longer found in Gmail.
async function runOrganizeForCurrentCustomer() {
  if (!currentCustomer) return;
  var btn = document.getElementById("organizeEmailsBtn");
  if (btn) { btn.disabled = true; btn.textContent = "🗂️ Organizing…"; }
  try {
    const result = await organizeCustomerEmails(currentCustomer.id, { silent: true });
    if (!result.moved && !result.merged && !result.foldersRemoved && !result.backfilled) {
      toast("🗂️ Already organized — nothing to clean up.", "ok");
    } else {
      var parts = [];
      if (result.moved) parts.push(result.moved + " filed into the right thread");
      if (result.merged) parts.push(result.merged + " duplicate" + (result.merged === 1 ? "" : "s") + " merged");
      if (result.foldersRemoved) parts.push(result.foldersRemoved + " empty folder" + (result.foldersRemoved === 1 ? "" : "s") + " removed");
      toast("🗂️ Organized: " + parts.join(", ") + ".", "ok");
    }
    loadFileView();
  } catch (e) {
    toast("❌ Couldn't organize: " + e.message, "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🗂️ Organize Emails"; }
  }
}
// ── AI SMART MERGE ─────────────────────────────────────────────────────
// Plain subject-text matching (normalizeSubject) can't catch every case —
// a reply whose subject drifted a little still lands in its own separate
// folder. This sends Gemini just the lightweight metadata for every thread
// folder (subject, message count, date span — never email content) and asks
// it to suggest which folders are really the same conversation. Nothing
// merges automatically: suggestions are shown in a modal and the person
// picks which ones (if any) to apply.
async function openSmartMergeModal() {
  if (!currentCustomer) return;
  openModal("modalSmartMerge");
  var body = document.getElementById("smartMergeBody");
  body.innerHTML = '<div class="merge-loading">🤖 Asking AI to compare your saved threads…</div>';
  try {
    const res = await fetch(SMART_MERGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SUPABASE_KEY, "apikey": SUPABASE_KEY },
      body: JSON.stringify({ customer_id: currentCustomer.id }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderMergeSuggestions(data.groups || []);
  } catch (e) {
    body.innerHTML = '<div class="merge-empty">❌ Couldn\'t get suggestions: ' + esc(e.message) + '</div>';
  }
}
function renderMergeSuggestions(groups) {
  var body = document.getElementById("smartMergeBody");
  if (!groups.length) {
    body.innerHTML = '<div class="merge-empty">✅ Nothing to suggest — your threads already look correctly separated.</div>';
    return;
  }
  var html = "";
  groups.forEach(function (group, gi) {
    // Primary = the folder with the most emails (ties broken by earliest
    // first_message_at) — everything else in the group merges into it.
    var sorted = group.slice().sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return new Date(a.first || 0) - new Date(b.first || 0);
    });
    var primary = sorted[0];
    var others = sorted.slice(1);
    html += '<div class="merge-suggestion" id="mergeSuggestion' + gi + '">'
      + '<div class="merge-suggestion-into">Merge into: ' + esc(primary.subject) + '</div>'
      + '<div class="merge-suggestion-item is-primary"><span>💬 ' + esc(primary.subject) + '</span><span class="merge-suggestion-item-meta">' + primary.count + ' email' + (primary.count === 1 ? '' : 's') + '</span></div>'
      + others.map(function (o) {
          return '<div class="merge-suggestion-item"><span>+ ' + esc(o.subject) + '</span><span class="merge-suggestion-item-meta">' + o.count + ' email' + (o.count === 1 ? '' : 's') + '</span></div>';
        }).join("")
      + '<div class="merge-apply-row">'
      + '<button class="merge-apply-btn" onclick="applyMergeGroup(' + gi + ')">✅ Merge These</button>'
      + '<button class="merge-dismiss-btn" onclick="dismissMergeGroup(' + gi + ')">Not the same — skip</button>'
      + '</div></div>';
  });
  body.innerHTML = html;
  window.__mergeGroups = groups; // stashed for applyMergeGroup/dismissMergeGroup below
}
function dismissMergeGroup(gi) {
  var el = document.getElementById("mergeSuggestion" + gi);
  if (el) el.remove();
}
async function applyMergeGroup(gi) {
  var group = (window.__mergeGroups || [])[gi];
  if (!group || !currentCustomer) return;
  var el = document.getElementById("mergeSuggestion" + gi);
  var btn = el ? el.querySelector(".merge-apply-btn") : null;
  if (btn) { btn.disabled = true; btn.textContent = "Merging…"; }
  try {
    var sorted = group.slice().sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return new Date(a.first || 0) - new Date(b.first || 0);
    });
    var primary = sorted[0];
    var others = sorted.slice(1);
    for (const o of others) {
      // Move every file out of the losing folder into the primary one, then
      // delete the now-empty folder. One bulk update per folder rather than
      // per file.
      const { error: moveErr } = await sb.from("nageo_files_files")
        .update({ folder_id: primary.id, updated_at: new Date().toISOString() })
        .eq("customer_id", currentCustomer.id).eq("folder_id", o.id);
      if (moveErr) throw moveErr;
      await sb.from("nageo_files_folders").delete().eq("id", o.id);
    }
    await refreshFolderActivity(currentCustomer.id, [primary.id]);
    toast("✅ Merged " + others.length + " folder" + (others.length === 1 ? "" : "s") + " into \"" + primary.subject + "\".", "ok");
    if (el) el.remove();
    loadFileView();
  } catch (e) {
    toast("❌ Merge failed: " + e.message, "err");
    if (btn) { btn.disabled = false; btn.textContent = "✅ Merge These"; }
  }
}
// Saves every not-yet-saved message in `results` into customerId's locked
// Emails folder, grouped into one locked subfolder per subject (see
// getOrCreateSubjectFolder). Returns how many were newly saved. Safe to call
// repeatedly with overlapping/duplicate result sets — that's the whole
// point, since a re-run of Search Emails will re-find messages already
// archived from a previous search. It also self-heals: any message sitting
// in the wrong folder (saved flat before grouping existed, or grouped under
// an old Gmail-thread-id-based folder) gets moved into its correct subject
// folder the next time it turns up in a search, and any subfolder left empty
// by that gets cleaned up automatically.
//
// TWO layers of de-dup, because one message can repeat two different ways:
//   1. gmail_message_id — the exact same result turning up again from the
//      SAME connected account (e.g. a later search pass, or a re-run).
//   2. rfc822_message_id — the real Message-ID header, set once by the
//      sending server and identical on every copy of an email everywhere it
//      lands. This is what catches the SAME physical email arriving via a
//      DIFFERENT connected account (cc'd, forwarded between reps, etc.) —
//      Gmail assigns that copy its own distinct gmail_message_id, so without
//      this check it would save as a second file.
async function saveEmailsToFolder(customerId, results) {
  if (!results || !results.length) return 0;
  const emailsFolder = await getOrCreateEmailsFolder(customerId);
  const msgIds = results.map(function (r) { return r.gmail_message_id; }).filter(Boolean);
  const rfcIds = results.map(function (r) { return r.rfc822_message_id; }).filter(Boolean);
  let existingByMsgId = {};
  let existingByRfcId = {};
  if (msgIds.length || rfcIds.length) {
    let q = sb.from("nageo_files_files").select("id, gmail_message_id, rfc822_message_id, folder_id").eq("customer_id", customerId);
    const orParts = [];
    if (msgIds.length) orParts.push("gmail_message_id.in.(" + msgIds.map(function (id) { return '"' + id.replace(/"/g, '\\"') + '"'; }).join(",") + ")");
    if (rfcIds.length) orParts.push("rfc822_message_id.in.(" + rfcIds.map(function (id) { return '"' + id.replace(/"/g, '\\"') + '"'; }).join(",") + ")");
    const { data: existingRows, error: existErr } = await q.or(orParts.join(","));
    if (existErr) throw existErr;
    (existingRows || []).forEach(function (row) {
      if (row.gmail_message_id) existingByMsgId[row.gmail_message_id] = row;
      if (row.rfc822_message_id) existingByRfcId[row.rfc822_message_id] = row;
    });
  }
  var subjectFolderCache = {};
  let savedCount = 0;
  let regroupedAny = false;
  for (const r of results) {
    if (!r.gmail_message_id) continue;
    // Exact same account+message re-turning-up — safe to backfill/regroup,
    // it's genuinely the same saved copy.
    var existingSameCopy = existingByMsgId[r.gmail_message_id];
    // Same physical email, but a DIFFERENT account's copy of it — this is a
    // true duplicate. Never move the original for this case (its folder is
    // correct for whichever account it was first saved under); just skip.
    var existingCrossAccountDup = (!existingSameCopy && r.rfc822_message_id) ? existingByRfcId[r.rfc822_message_id] : null;

    if (existingCrossAccountDup) continue;

    var targetFolder = emailsFolder;
    try {
      targetFolder = await getOrCreateSubjectFolder(customerId, emailsFolder.id, r, subjectFolderCache);
    } catch (e) {
      console.warn("Could not group into a subject folder, saving flat instead:", e);
      targetFolder = emailsFolder;
    }
    if (existingSameCopy) {
      // Already saved — if it's sitting somewhere other than its correct
      // subject folder (e.g. saved flat before grouping existed, or grouped
      // under an old thread-id-based folder), move it and backfill its
      // thread id now that we know it.
      if (existingSameCopy.folder_id !== targetFolder.id) {
        try {
          await sb.from("nageo_files_files").update({
            folder_id: targetFolder.id,
            gmail_thread_id: r.gmail_thread_id || null,
            subject: r.subject || null,
            dedup_key: r.rfc822_message_id || computeDedupKey(r.subject, r.from, r.date),
            email_date: parseDateSafe(r.date),
            snippet: r.snippet || null,
            sender: r.from || null,
            updated_at: new Date().toISOString(),
          }).eq("id", existingSameCopy.id);
          regroupedAny = true;
        } catch (e) { console.warn("Failed to regroup existing saved email:", r.subject, e); }
      }
      continue;
    }
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
        folder_id: targetFolder.id,
        name: sanitizeEmailFileName(r),
        size: bytes.length,
        mime_type: "text/html",
        storage_path: storagePath,
        gmail_message_id: r.gmail_message_id,
        gmail_account: r.account || null,
        gmail_thread_id: r.gmail_thread_id || null,
        rfc822_message_id: r.rfc822_message_id || null,
        subject: r.subject || null,
        dedup_key: r.rfc822_message_id || computeDedupKey(r.subject, r.from, r.date),
        email_date: parseDateSafe(r.date),
        snippet: r.snippet || null,
        sender: r.from || null,
      });
      if (insErr) {
        // 23505 = unique violation — either the same (customer_id,
        // gmail_message_id) or the same (customer_id, rfc822_message_id),
        // meaning a concurrent search (or another account's copy landing at
        // the same moment) already saved this exact email a beat ago. Clean
        // up the storage object we just uploaded and move on quietly.
        await sb.storage.from(STORAGE_BUCKET).remove([storagePath]);
        if (insErr.code !== "23505") throw insErr;
        continue;
      }
      // Update the in-batch caches so a duplicate of THIS message later in
      // the same batch (e.g. a different account's copy found in the same
      // search pass) is recognized immediately, without a second DB round
      // trip and without waiting for saveEmailsToFolder to be called again.
      existingByMsgId[r.gmail_message_id] = { id: null, gmail_message_id: r.gmail_message_id, folder_id: targetFolder.id };
      if (r.rfc822_message_id) existingByRfcId[r.rfc822_message_id] = { id: null, rfc822_message_id: r.rfc822_message_id, folder_id: targetFolder.id };
      savedCount++;
    } catch (e) {
      console.warn("Failed to save email to Emails folder:", r.subject, e);
    }
  }
  if (savedCount || regroupedAny) {
    // Full organize pass — catches anything this run's narrower per-message
    // logic above missed (legacy rows with no subject/dedup_key yet, old
    // gmail_thread_id-only folders, etc.) and cleans up empty folders. Cheap
    // on repeat runs since backfill only touches rows still missing
    // subject/dedup_key.
    try { await organizeCustomerEmails(customerId, { silent: true }); } catch (e) { /* best-effort */ }
  }
  if ((savedCount || regroupedAny) && currentCustomer && currentCustomer.id === customerId) {
    loadFileView(); // live-refresh if the user happens to already be looking at this customer's files
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

  var skipped = 0, totalSaved = 0, totalFound = 0, failed = 0, totalMerged = 0, totalFoldersRemoved = 0;
  var customers = allCustomers.slice();

  for (var i = 0; i < customers.length; i++) {
    if (sweepCancelled) break;
    var c = customers[i];
    var emails = [];
    // Every email HCP has on file for this customer (falls back to the
    // single .email field for older cached customer objects that predate
    // the .emails array).
    var hcpEmails = (Array.isArray(c.emails) && c.emails.length) ? c.emails : (c.email ? [c.email] : []);
    hcpEmails.forEach(function (e) {
      var v = (e || "").trim().toLowerCase();
      if (v && emails.indexOf(v) === -1) emails.push(v);
    });
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
      // Always run the organize pass, even when this customer's search found
      // nothing new — it's what catches/fixes legacy backlog (duplicates,
      // loose or misfiled emails) sitting in already-saved data that a fresh
      // Gmail search wouldn't surface again (e.g. since deleted on Gmail).
      var org = { moved: 0, merged: 0, foldersRemoved: 0 };
      try { org = await organizeCustomerEmails(c.id, { silent: true }); } catch (e2) { /* best-effort */ }
      totalMerged += org.merged || 0;
      totalFoldersRemoved += org.foldersRemoved || 0;
      var resultBits = [];
      if (results.length) resultBits.push(saved + " new · " + results.length + " found");
      if (org.merged) resultBits.push(org.merged + " merged");
      if (org.moved) resultBits.push(org.moved + " refiled");
      appendSweepLogRow(c.name, resultBits.length ? resultBits.join(" · ") : "already organized", saved > 0 || org.merged > 0 || org.moved > 0);
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
  var extraBits = [];
  if (totalMerged) extraBits.push(totalMerged + " duplicate" + (totalMerged === 1 ? "" : "s") + " merged");
  if (totalFoldersRemoved) extraBits.push(totalFoldersRemoved + " empty folder" + (totalFoldersRemoved === 1 ? "" : "s") + " cleaned up");
  var extraStr = extraBits.length ? (" (" + extraBits.join(", ") + ")") : "";
  toast(finishedAll
    ? ("✅ Sync complete — " + totalSaved + " new email" + (totalSaved === 1 ? "" : "s") + " saved across " + customers.length + " customers" + extraStr + ".")
    : ("⏸ Sync stopped — " + totalSaved + " new email" + (totalSaved === 1 ? "" : "s") + " saved so far" + extraStr + "."), "ok");
}
var organizeAllRunning = false;
// Runs organizeCustomerEmails for every customer, one at a time — unlike
// Search All Customers, this never talks to Gmail at all, so it's much
// faster and is the right button to click right after an update like this
// one, to apply the fix across every customer's already-saved emails at
// once instead of clicking into each one individually.
async function startOrganizeAllCustomers() {
  if (organizeAllRunning) return;
  if (!allCustomers.length) { toast("Customer list hasn't loaded yet — try again in a moment.", "err"); return; }
  organizeAllRunning = true;
  var btn = document.getElementById("organizeAllBtn");
  var progressBox = document.getElementById("organizeAllProgress");
  var progressText = document.getElementById("organizeAllProgressText");
  var summaryEl = document.getElementById("organizeAllSummary");
  btn.disabled = true;
  progressBox.style.display = "block";
  summaryEl.style.display = "block";
  summaryEl.innerHTML = "";

  var customers = allCustomers.slice();
  var totalMoved = 0, totalMerged = 0, totalFoldersRemoved = 0, touched = 0;
  for (var i = 0; i < customers.length; i++) {
    var c = customers[i];
    progressText.textContent = "Customer " + (i + 1) + " of " + customers.length + ": " + c.name;
    try {
      const result = await organizeCustomerEmails(c.id, { silent: true });
      totalMoved += result.moved || 0;
      totalMerged += result.merged || 0;
      totalFoldersRemoved += result.foldersRemoved || 0;
      if (result.moved || result.merged || result.foldersRemoved || result.backfilled) touched++;
    } catch (e) { /* keep going — one customer's error shouldn't stop the rest */ }
    summaryEl.innerHTML = '<b>' + (i + 1) + ' of ' + customers.length + '</b> customers checked · '
      + touched + ' updated · ' + totalMoved + ' refiled · ' + totalMerged + ' duplicates merged · ' + totalFoldersRemoved + ' empty folders removed';
  }

  progressBox.style.display = "none";
  btn.disabled = false;
  organizeAllRunning = false;
  toast("🗂️ Organized " + customers.length + " customers — " + totalMoved + " refiled, " + totalMerged + " duplicates merged, " + totalFoldersRemoved + " empty folders removed.", "ok");
  if (currentCustomer) loadFileView();
  if (customerSortOrder === "recent") {
    loadLastEmailedDates().then(function () { renderCustomerList(filteredCustomers); });
  }
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
  // Every email HCP has on file for this customer (falls back to the single
  // .email field for older cached customer objects that predate .emails).
  var hcpEmails = (Array.isArray(currentCustomer.emails) && currentCustomer.emails.length)
    ? currentCustomer.emails
    : (currentCustomer.email ? [currentCustomer.email] : []);
  hcpEmails.forEach(function (e) {
    var v = (e || "").trim();
    if (v && !searchEmailsList.some(function (x) { return x.email.toLowerCase() === v.toLowerCase(); })) {
      searchEmailsList.push({ email: v, source: "hcp" });
    }
  });
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
    // Always organize after a sync — even when this search turned up
    // nothing new. That's what catches/fixes backlog issues (duplicates,
    // misfiled emails, stale dates) sitting in this customer's
    // ALREADY-saved emails, independent of whatever this particular search
    // did or didn't find. saveEmailsToFolder above already triggers its own
    // organize pass when it saved/regrouped something, so this is a cheap
    // no-op in that case and the only thing that actually runs it otherwise.
    try { await organizeCustomerEmails(searchEmailsCustomerId, { silent: true }); } catch (e) { /* best-effort */ }
    if (currentCustomer && currentCustomer.id === searchEmailsCustomerId) loadFileView();
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
function toggleEmailToolsDropdown() {
  document.getElementById("emailToolsDropdown").classList.toggle("show");
}
function closeEmailToolsDropdown() {
  document.getElementById("emailToolsDropdown").classList.remove("show");
}
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
