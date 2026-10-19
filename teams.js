// ══════════════════════════════════════════════════════════════════════════
// NAGeo Files — Microsoft Teams Files add-on (teams.js)
//
// Loaded AFTER app.js (one <script> line in index.html). It adds a blue
// "Microsoft Teams Files" folder to each customer's root, backed live by the
// Teams/SharePoint files through the nageo-files-teams edge function. It
// extends app.js by wrapping a few of its functions — app.js itself is not
// edited. Read-only for now (browse / preview / download).
//
// To turn the feature off: delete the <script src="teams.js…"> line.
// ══════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  var TEAMS_URL = SUPABASE_URL + "/functions/v1/nageo-files-teams";

  var teamsView = null;          // null = normal view; otherwise { channels, trail }
  var currentTeamsChannels = []; // channels found for the customer being viewed
  var teamsParents = null;       // cached "group under a parent customer" rules
  var teamsItems = [];           // items currently listed in the teams view
  var teamsLoadToken = 0;        // guards against out-of-order loads

  // ── The app used to remember only the word "true" after unlocking. The
  // server now needs the real code to show Teams files, so any device still
  // holding the old value is asked for the code once more. ──
  if (localStorage.getItem(REG_KEY) === "true") {
    localStorage.removeItem(REG_KEY);
    regCode = "";
  }

  // ── Styles ──
  var style = document.createElement("style");
  style.textContent =
    ".teams-card{background:#eef0ff;border:1.5px solid #5059C9;}" +
    ".teams-card:hover{border-color:#5059C9;}" +
    ".teams-card .card-name{color:#3b43a3;}" +
    ".teams-badge{width:42px;height:42px;border-radius:10px;background:#5059C9;color:#fff;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center;line-height:1;}" +
    ".teams-folder{border-color:#c7cbf5;}" +
    ".teams-folder:hover{border-color:#5059C9;}" +
    ".teams-note{font-size:12.5px;color:var(--text3);margin:0 0 12px;}";
  document.head.appendChild(style);

  // ── Unlock screen: store the real code instead of the word "true" ──
  window.tryRegister = async function () {
    var input = document.getElementById("regInput").value.trim().toUpperCase();
    document.getElementById("regErr").style.display = "none";
    document.getElementById("regBtn").textContent = "Checking…";
    document.getElementById("regBtn").disabled = true;
    try {
      var res = await sb.from("nageo_files_settings").select("registration_code").eq("id", 1).single();
      if (res.error) throw res.error;
      if (res.data && res.data.registration_code === input) {
        localStorage.setItem(REG_KEY, input);
        regCode = input;
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
  };

  // ── Talking to the edge function ──
  async function teamsCall(payload, asBlob) {
    var res = await fetch(TEAMS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SUPABASE_KEY, "apikey": SUPABASE_KEY },
      body: JSON.stringify(Object.assign({ code: regCode }, payload)),
    });
    var ct = res.headers.get("content-type") || "";
    if (asBlob && res.ok && ct.indexOf("application/json") === -1) return await res.blob();
    var data;
    try { data = await res.json(); } catch (e) { throw new Error("Server error " + res.status); }
    if (data.code_invalid) {
      localStorage.removeItem(REG_KEY);
      toast("🔒 Registration code changed — please enter it again.", "err");
      setTimeout(function () { location.reload(); }, 1500);
      throw new Error("Registration code not accepted.");
    }
    if (data.error) throw new Error(data.error + (data.hint ? " — " + data.hint : ""));
    return data;
  }

  // ── Which Teams channels belong to this customer? ──
  // Normally: channels whose 5-digit ID matches the customer's tag. A
  // "parent" customer (e.g. the Abod profile) also gets every channel whose
  // name contains its match text, and those channels are hidden from the
  // individual property customers so files don't appear twice.
  function nameHas(name, text) {
    return String(name || "").toLowerCase().indexOf(String(text || "").toLowerCase()) !== -1;
  }
  async function loadTeamsChannelsFor(c) {
    try {
      if (teamsParents === null) {
        var pr = await sb.from("nageo_files_teams_parents").select("parent_id_tag, match_text");
        teamsParents = pr.error ? [] : (pr.data || []);
      }
      var tag = c.customer_id;
      var own = await sb.from("nageo_files_teams_channels").select("channel_id, team_name, channel_name, id_tag").eq("id_tag", tag);
      var list = (own.data || []).filter(function (ch) {
        return !teamsParents.some(function (p) { return p.parent_id_tag !== tag && nameHas(ch.channel_name, p.match_text); });
      });
      var rules = teamsParents.filter(function (p) { return p.parent_id_tag === tag; });
      for (var i = 0; i < rules.length; i++) {
        var r = await sb.from("nageo_files_teams_channels").select("channel_id, team_name, channel_name, id_tag")
          .ilike("channel_name", "%" + rules[i].match_text + "%");
        list = list.concat(r.data || []);
      }
      var seen = {};
      list = list.filter(function (ch) { if (seen[ch.channel_id]) return false; seen[ch.channel_id] = true; return true; });
      list.sort(function (a, b) { return a.channel_name.localeCompare(b.channel_name); });
      return list;
    } catch (e) {
      return [];
    }
  }

  // ── Wrap loadFileView: fetch the channel list at the customer root, or
  // take over completely while browsing inside Teams. ──
  var origLoadFileView = window.loadFileView;
  window.loadFileView = async function () {
    if (teamsView) return loadTeamsView();
    currentTeamsChannels = (!currentFolderId && currentCustomer) ? await loadTeamsChannelsFor(currentCustomer) : [];
    return origLoadFileView();
  };

  // ── Wrap renderFileView: drop the blue Teams card into the root's folder grid ──
  var origRenderFileView = window.renderFileView;
  window.renderFileView = function (folders, files) {
    origRenderFileView(folders, files);
    if (teamsView || currentFolderId || !currentTeamsChannels.length) return;
    var el = document.getElementById("fileContent");
    var card = buildTeamsCard();
    var labels = Array.prototype.slice.call(el.querySelectorAll(".section-label"));
    var foldersLabel = labels.filter(function (l) { return l.textContent.indexOf("Folders") !== -1; })[0];
    if (foldersLabel && foldersLabel.nextElementSibling) {
      foldersLabel.nextElementSibling.insertBefore(card, foldersLabel.nextElementSibling.firstChild);
      return;
    }
    var wrap = document.createElement("div");
    wrap.innerHTML = '<div class="section-label">📁 Folders</div><div class="file-grid"></div>';
    wrap.lastChild.appendChild(card);
    var empty = el.querySelector(".folder-empty-area");
    if (empty) { el.replaceChild(wrap, empty); }
    else if (labels.length) { el.insertBefore(wrap, labels[0]); }
    else { el.appendChild(wrap); }
  };

  function buildTeamsCard() {
    var n = currentTeamsChannels.length;
    var d = document.createElement("div");
    d.className = "folder-card teams-card";
    d.innerHTML = '<div class="teams-badge">T</div>'
      + '<div class="card-name">Microsoft Teams Files</div>'
      + '<div class="card-meta">' + n + ' channel' + (n === 1 ? '' : 's') + '</div>';
    d.addEventListener("click", openTeamsRoot);
    return d;
  }

  function openTeamsRoot() {
    if (selectMode) { toast("The Microsoft Teams folder can't be selected.", "err"); return; }
    var chans = currentTeamsChannels.slice();
    teamsView = { channels: chans, trail: [] };
    if (chans.length === 1) teamsView.trail.push({ type: "channel", label: chans[0].channel_name, channel_id: chans[0].channel_id });
    loadFileView();
  }

  // ── Breadcrumb while inside Teams ──
  var origRenderBreadcrumb = window.renderBreadcrumb;
  window.renderBreadcrumb = function () {
    if (!teamsView) return origRenderBreadcrumb();
    var el = document.getElementById("breadcrumb");
    var multi = teamsView.channels.length > 1;
    var base = multi ? 0 : 1; // with a single channel, that channel IS the Teams root
    var onRoot = teamsView.trail.length === base;
    var html = '<button class="bc-item" onclick="navTo(-1)">📁 ' + esc(currentCustomer ? currentCustomer.name : "") + '</button>'
      + '<span class="bc-sep">›</span>'
      + '<button class="bc-item' + (onRoot ? ' cur' : '') + '" onclick="teamsGoTo(-1)">Microsoft Teams Files</button>';
    for (var i = base; i < teamsView.trail.length; i++) {
      var last = i === teamsView.trail.length - 1;
      html += '<span class="bc-sep">›</span><button class="bc-item' + (last ? ' cur' : '') + '" onclick="teamsGoTo(' + i + ')">' + esc(teamsView.trail[i].label) + '</button>';
    }
    el.innerHTML = html;
  };

  window.teamsGoTo = function (i) {
    if (!teamsView) return;
    if (i < 0) {
      teamsView.trail = [];
      if (teamsView.channels.length === 1) {
        var c = teamsView.channels[0];
        teamsView.trail.push({ type: "channel", label: c.channel_name, channel_id: c.channel_id });
      }
    } else {
      teamsView.trail = teamsView.trail.slice(0, i + 1);
    }
    loadFileView();
  };

  window.teamsOpenChannel = function (idx) {
    var c = teamsView.channels[idx];
    teamsView.trail = [{ type: "channel", label: c.channel_name, channel_id: c.channel_id }];
    loadFileView();
  };

  window.teamsOpenFolder = function (idx) {
    var it = teamsItems[idx];
    var cur = teamsView.trail[teamsView.trail.length - 1];
    teamsView.trail.push({ type: "folder", label: it.name, channel_id: cur.channel_id, drive_id: cur.drive_id, item_id: it.id });
    loadFileView();
  };

  // ── The Teams view itself ──
  async function loadTeamsView() {
    renderBreadcrumb();
    updateSystemFolderUI();
    selectedItems.clear();
    updateSelectBar();
    var bar = document.getElementById("threadOverviewBar");
    if (bar) { bar.style.display = "none"; bar.innerHTML = ""; }
    var el = document.getElementById("fileContent");
    el.classList.remove("select-mode");
    var overlay = '<div class="drop-overlay" id="dropOverlay"></div>';
    var token = ++teamsLoadToken;

    // Channel picker (customer has more than one Teams channel)
    if (!teamsView.trail.length) {
      var html = overlay + '<div class="teams-note">Files here live in Microsoft Teams — changes made in Teams show up here, and the other way around.</div>'
        + '<div class="section-label">💬 Teams Channels</div><div class="file-grid">';
      teamsView.channels.forEach(function (c, i) {
        html += '<div class="folder-card teams-folder" onclick="teamsOpenChannel(' + i + ')">'
          + '<div class="card-icon">📁</div>'
          + '<div class="card-name">' + esc(c.channel_name) + '</div>'
          + '<div class="card-meta">' + esc(c.team_name) + '</div></div>';
      });
      el.innerHTML = html + '</div>';
      return;
    }

    el.innerHTML = overlay + '<div style="padding:2rem;text-align:center;color:var(--text3);">Loading from Microsoft Teams…</div>';
    var cur = teamsView.trail[teamsView.trail.length - 1];
    try {
      var data = await teamsCall({ action: "browse", channel_id: cur.channel_id, drive_id: cur.drive_id, item_id: cur.item_id });
      if (token !== teamsLoadToken || !teamsView) return;
      cur.drive_id = data.drive_id;
      cur.item_id = data.item_id;
      teamsItems = data.items || [];
      renderTeamsItems(overlay);
    } catch (e) {
      if (token !== teamsLoadToken) return;
      el.innerHTML = overlay + '<div style="padding:2rem;text-align:center;color:var(--red);">❌ Could not load Teams files.<br><small>' + esc(e.message) + '</small><br><br>'
        + '<button onclick="loadFileView()" style="padding:8px 16px;background:var(--blue);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;">Try Again</button></div>';
    }
  }

  function renderTeamsItems(overlay) {
    var el = document.getElementById("fileContent");
    if (!teamsItems.length) {
      el.innerHTML = overlay + '<div class="folder-empty-area"><div class="folder-empty-icon">📂</div>'
        + '<div class="folder-empty-strong">This folder is empty</div>'
        + '<div class="folder-empty-p">Nothing in Microsoft Teams here yet.</div></div>';
      return;
    }
    var folders = [], files = [];
    teamsItems.forEach(function (it, i) { (it.is_folder ? folders : files).push({ it: it, i: i }); });
    var html = overlay;
    if (folders.length) {
      html += '<div class="section-label">📁 Folders</div><div class="file-grid">';
      folders.forEach(function (x) {
        html += '<div class="folder-card teams-folder" onclick="teamsOpenFolder(' + x.i + ')">'
          + '<div class="card-icon">📁</div><div class="card-name">' + esc(x.it.name) + '</div>'
          + (x.it.child_count != null ? '<div class="card-meta">' + x.it.child_count + ' item' + (x.it.child_count === 1 ? '' : 's') + '</div>' : '')
          + '</div>';
      });
      html += '</div>';
    }
    if (files.length) {
      html += '<div class="section-label">📄 Files</div><div class="file-grid">';
      files.forEach(function (x) {
        html += '<div class="file-card" onclick="teamsPreview(' + x.i + ')">'
          + '<div class="card-icon">' + fileIcon(x.it.name) + '</div>'
          + '<div class="card-name">' + esc(x.it.name) + '</div>'
          + '<div class="card-meta">' + formatSize(x.it.size) + '</div>'
          + '<button class="card-menu" title="Download" onclick="event.stopPropagation();teamsDownload(' + x.i + ')">⬇️</button>'
          + '</div>';
      });
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function currentTeamsParent() {
    return teamsView.trail[teamsView.trail.length - 1];
  }

  window.teamsPreview = async function (idx) {
    var it = teamsItems[idx];
    if (!it) return;
    var isImage = (it.mime || "").indexOf("image/") === 0;
    var isPDF = it.mime === "application/pdf" || /\.pdf$/i.test(it.name);
    if (!isImage && !isPDF) { window.teamsDownload(idx); return; }
    document.getElementById("previewTitle").textContent = it.name;
    document.getElementById("previewContent").innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text3);">Loading preview…</div>';
    openModal("modalPreview");
    try {
      var cur = currentTeamsParent();
      var blob = await teamsCall({ action: "file", drive_id: cur.drive_id, item_id: it.id }, true);
      var url = URL.createObjectURL(isPDF ? new Blob([blob], { type: "application/pdf" }) : blob);
      document.getElementById("previewContent").innerHTML = isPDF
        ? '<iframe class="preview-pdf" src="' + url + '"></iframe>'
        : '<img class="preview-img" src="' + url + '" alt="' + esc(it.name) + '">';
    } catch (e) {
      document.getElementById("previewContent").innerHTML = '<div style="padding:2rem;text-align:center;color:var(--red);">❌ Could not load preview.<br><small>' + esc(e.message) + '</small></div>';
    }
  };

  window.teamsDownload = async function (idx) {
    var it = teamsItems[idx];
    if (!it) return;
    toast("⬇️ Downloading…");
    try {
      var cur = currentTeamsParent();
      var blob = await teamsCall({ action: "file", drive_id: cur.drive_id, item_id: it.id }, true);
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = it.name;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    } catch (e) {
      toast("❌ Download failed: " + e.message, "err");
    }
  };

  // ── Leaving Teams: every normal navigation function resets the view ──
  ["selectCustomer", "jumpToFolder", "navTo", "openFolder"].forEach(function (name) {
    var orig = window[name];
    window[name] = function () {
      teamsView = null;
      return orig.apply(this, arguments);
    };
  });

  // ── Read-only for now: hide the buttons that would change things ──
  var origUpdateSystemFolderUI = window.updateSystemFolderUI;
  window.updateSystemFolderUI = function () {
    origUpdateSystemFolderUI();
    var hide = !!teamsView;
    if (hide) {
      ["newFolderBtn", "uploadBtn", "cameraBtn"].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.style.display = "none";
      });
    }
    var sel = document.getElementById("selectModeBtn");
    if (sel) sel.style.display = hide ? "none" : "";
    var tools = document.querySelector(".email-tools-wrap");
    if (tools) tools.style.display = hide ? "none" : "";
  };

  var origUploadFiles = window.uploadFiles;
  window.uploadFiles = function (files) {
    if (teamsView) { toast("🔒 Microsoft Teams files are view-only here for now.", "err"); return; }
    return origUploadFiles(files);
  };
})();
