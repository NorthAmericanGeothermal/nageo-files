// ══════════════════════════════════════════════════════════════════════════
// NAGeo Files — Microsoft Teams Files add-on (teams.js)
//
// Loaded AFTER app.js (one <script> line in index.html). It adds a blue
// "Microsoft Teams Files" folder to each customer's root, backed live by the
// Teams/SharePoint files through the nageo-files-teams edge function. It
// extends app.js by wrapping a few of its functions — app.js itself is not
// edited. Read-only for now (browse / preview / download).
//
// HARD STOP: if a Teams channel uses a customer's 5-digit ID but its name
// doesn't match the customer, nothing opens. A decision screen asks whether
// it's the same customer, and the answer is remembered per customer+channel
// (nageo_files_teams_decisions).
//
// To turn the feature off: delete the <script src="teams.js…"> line.
// ══════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  var TEAMS_URL = SUPABASE_URL + "/functions/v1/nageo-files-teams";

  // teamsView = null when browsing normally; otherwise:
  //   all     — every channel found for this customer (each has .status:
  //             "ok" | "review" | "rejected")
  //   channels— the "ok" ones (the only ones whose files can be opened)
  //   trail   — breadcrumb path inside Teams
  //   skipped — channels the person chose to "keep locked" for this visit
  var teamsView = null;
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
    ".teams-card-warn{background:#fef3c7;border-color:#f0b429;}" +
    ".teams-card-warn:hover{border-color:#f0b429;}" +
    ".teams-card-warn .card-name{color:#b45309;}" +
    ".teams-badge{width:42px;height:42px;border-radius:10px;background:#5059C9;color:#fff;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center;line-height:1;}" +
    ".teams-card-warn .teams-badge{background:#b45309;}" +
    ".teams-folder{border-color:#c7cbf5;}" +
    ".teams-folder:hover{border-color:#5059C9;}" +
    ".teams-note{font-size:12.5px;color:var(--text3);}" +
    ".teams-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px;}" +
    ".teams-toolbar .teams-note{flex:1;min-width:120px;}" +
    ".teams-hold{background:#fef3c7;border:1.5px solid #f0b429;border-radius:12px;padding:14px 16px;margin-bottom:12px;}" +
    ".teams-hold-title{font-size:15px;font-weight:800;color:#b45309;margin-bottom:4px;}" +
    ".teams-hold-sub{font-size:13px;color:var(--text2);line-height:1.55;}" +
    ".teams-review{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #f0b429;border-radius:12px;padding:12px 14px;margin-bottom:10px;}" +
    ".teams-review-main{flex:1;min-width:200px;}" +
    ".teams-review-chan{font-size:14.5px;font-weight:700;color:var(--text);word-break:break-word;}" +
    ".teams-review-meta{font-size:12px;color:var(--text3);margin-top:2px;}" +
    ".teams-review-btns{display:flex;gap:8px;flex-wrap:wrap;}" +
    ".teams-btn-yes,.teams-btn-no,.teams-btn-skip{padding:8px 13px;border-radius:8px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid var(--border);background:#fff;color:var(--text2);}" +
    ".teams-btn-yes{background:var(--green);border-color:var(--green);color:#fff;}" +
    ".teams-btn-no{background:var(--red);border-color:var(--red);color:#fff;}" +
    ".teams-btn-yes:hover,.teams-btn-no:hover{opacity:.9;}" +
    ".teams-btn-skip:hover{background:#eef2f7;}";
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

  // ── Which Teams channels belong to this customer, and can we trust them? ──
  // Channels come from (1) the customer's own 5-digit ID and (2) "parent"
  // rules (e.g. the Abod profile owns every channel with ABOD in its name;
  // those channels are hidden from the individual property customers).
  // Each channel then gets a status:
  //   ok       — name matches the customer, came from a parent rule, or a
  //              person confirmed it
  //   review   — shares the ID but the name doesn't match → HARD STOP
  //   rejected — a person said "different customer" → never shown here
  function nameHas(name, text) {
    return String(name || "").toLowerCase().indexOf(String(text || "").toLowerCase()) !== -1;
  }
  // Does the channel name share any word with the customer's name?
  function channelNameLooksRight(ch) {
    if (!currentCustomer) return true;
    var words = String(currentCustomer.name || "").toLowerCase().split(/[^a-z]+/).filter(function (w) { return w.length >= 3; });
    if (!words.length) return true; // nothing to compare against — don't block
    var hay = String(ch.channel_name || "").toLowerCase();
    return words.some(function (w) { return hay.indexOf(w) !== -1; });
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
        list = list.concat((r.data || []).map(function (x) { x.viaParent = true; return x; }));
      }
      var seen = {};
      list = list.filter(function (ch) { if (seen[ch.channel_id]) return false; seen[ch.channel_id] = true; return true; });
      list.sort(function (a, b) { return a.channel_name.localeCompare(b.channel_name); });

      var dec = {};
      var dr = await sb.from("nageo_files_teams_decisions").select("channel_id, decision").eq("customer_id", c.id);
      (dr.data || []).forEach(function (d) { dec[d.channel_id] = d.decision; });
      list.forEach(function (ch) {
        if (dec[ch.channel_id] === "rejected") ch.status = "rejected";
        else if (dec[ch.channel_id] === "confirmed" || ch.viaParent || channelNameLooksRight(ch)) ch.status = "ok";
        else ch.status = "review";
      });
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
    var visible = currentTeamsChannels.filter(function (c) { return c.status !== "rejected"; }).length;
    var review = currentTeamsChannels.filter(function (c) { return c.status === "review"; }).length;
    var hidden = currentTeamsChannels.length - visible;
    var meta = review
      ? '⚠️ ' + review + ' to review'
      : visible + ' channel' + (visible === 1 ? '' : 's') + (hidden ? ' · ' + hidden + ' hidden' : '');
    var d = document.createElement("div");
    d.className = "folder-card teams-card" + (review ? " teams-card-warn" : "");
    d.innerHTML = '<div class="teams-badge">T</div>'
      + '<div class="card-name">Microsoft Teams Files</div>'
      + '<div class="card-meta">' + meta + '</div>';
    d.addEventListener("click", openTeamsRoot);
    return d;
  }

  function teamsPendingCount() {
    return teamsView.all.filter(function (c) { return c.status === "review" && !teamsView.skipped[c.channel_id]; }).length;
  }

  // Recomputes which channels can be opened, and — only when nothing is
  // waiting on a decision and there's exactly one usable channel — jumps
  // straight into it.
  function settleTeamsChannels() {
    teamsView.channels = teamsView.all.filter(function (c) { return c.status === "ok"; });
    teamsView.trail = [];
    if (teamsView.channels.length === 1 && !teamsPendingCount()) {
      var c = teamsView.channels[0];
      teamsView.trail.push({ type: "channel", label: c.channel_name, channel_id: c.channel_id });
    }
  }

  function openTeamsRoot() {
    if (selectMode) { toast("The Microsoft Teams folder can't be selected.", "err"); return; }
    teamsView = { all: currentTeamsChannels.slice(), channels: [], trail: [], skipped: {} };
    settleTeamsChannels();
    loadFileView();
  }

  // ── Breadcrumb while inside Teams ──
  var origRenderBreadcrumb = window.renderBreadcrumb;
  window.renderBreadcrumb = function () {
    if (!teamsView) return origRenderBreadcrumb();
    var el = document.getElementById("breadcrumb");
    var multi = teamsView.channels.length > 1;
    var base = multi ? 0 : 1; // with a single channel, that channel IS the Teams root
    var onRoot = teamsView.trail.length <= base;
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

  // ── Decisions: the hard stop ──
  window.teamsDecide = async function (idx, decision) {
    var ch = teamsView && teamsView.all[idx];
    if (!ch) return;
    try {
      await teamsCall({ action: "decide", customer_id: currentCustomer.id, channel_id: ch.channel_id, decision: decision });
    } catch (e) {
      toast("❌ Couldn't save that choice: " + e.message, "err");
      return;
    }
    if (decision === "confirmed") ch.status = "ok";
    else if (decision === "rejected") ch.status = "rejected";
    else ch.status = (ch.viaParent || channelNameLooksRight(ch)) ? "ok" : "review"; // "clear" → ask again if it still looks wrong
    if (decision !== "clear") delete teamsView.skipped[ch.channel_id];
    toast(decision === "confirmed" ? "✅ Saved — I'll remember this is the same customer." : decision === "rejected" ? "🚫 Saved — that channel won't show for this customer." : "↩️ Choice cleared.", "ok");
    settleTeamsChannels();
    loadFileView();
  };

  window.teamsSkip = function (idx) {
    var ch = teamsView && teamsView.all[idx];
    if (!ch) return;
    teamsView.skipped[ch.channel_id] = true; // stays locked; nothing saved
    settleTeamsChannels();
    loadFileView();
  };

  window.teamsReviewLocked = function () {
    if (!teamsView) return;
    teamsView.skipped = {};
    settleTeamsChannels();
    loadFileView();
  };

  function renderTeamsDecisions(el, overlay) {
    var cust = currentCustomer;
    var pendingIdx = [], lockedIdx = [], hiddenIdx = [];
    teamsView.all.forEach(function (c, i) {
      if (c.status === "review") (teamsView.skipped[c.channel_id] ? lockedIdx : pendingIdx).push(i);
      else if (c.status === "rejected") hiddenIdx.push(i);
    });
    var html = overlay;

    if (pendingIdx.length) {
      html += '<div class="teams-hold"><div class="teams-hold-title">⚠️ Check before opening Teams files</div>'
        + '<div class="teams-hold-sub">These Teams channels use the same ID as <b>' + esc(cust.name) + '</b> (#' + esc(cust.customer_id) + '), '
        + 'but the name doesn\'t match. Their files stay locked until you answer. Your answer is remembered.</div></div>';
      pendingIdx.forEach(function (i) {
        var c = teamsView.all[i];
        html += '<div class="teams-review"><div class="teams-review-main">'
          + '<div class="teams-review-chan">💬 ' + esc(c.channel_name) + '</div>'
          + '<div class="teams-review-meta">' + esc(c.team_name) + ' · Is this the same person as ' + esc(cust.name) + '?</div></div>'
          + '<div class="teams-review-btns">'
          + '<button class="teams-btn-yes" onclick="teamsDecide(' + i + ',\'confirmed\')">✅ Same customer</button>'
          + '<button class="teams-btn-no" onclick="teamsDecide(' + i + ',\'rejected\')">🚫 Different person</button>'
          + '<button class="teams-btn-skip" onclick="teamsSkip(' + i + ')">Keep locked</button>'
          + '</div></div>';
      });
    } else {
      html += '<div class="teams-hold"><div class="teams-hold-title">No Teams files to show</div><div class="teams-hold-sub">'
        + (lockedIdx.length ? 'The matching Teams channels are locked until you review them.' : 'Every matching Teams channel was marked as a different person.')
        + '</div></div>';
    }

    if (!pendingIdx.length && lockedIdx.length) {
      html += '<button class="teams-btn-skip" style="margin-bottom:14px;" onclick="teamsReviewLocked()">🔓 Review the ' + lockedIdx.length + ' locked channel' + (lockedIdx.length === 1 ? '' : 's') + '</button>';
    }
    if (hiddenIdx.length) {
      html += '<div class="section-label" style="margin-top:14px;">Marked as a different person</div>';
      hiddenIdx.forEach(function (i) {
        var c = teamsView.all[i];
        html += '<div class="teams-review" style="border-color:var(--border);"><div class="teams-review-main">'
          + '<div class="teams-review-chan">💬 ' + esc(c.channel_name) + '</div>'
          + '<div class="teams-review-meta">' + esc(c.team_name) + '</div></div>'
          + '<div class="teams-review-btns"><button class="teams-btn-skip" onclick="teamsDecide(' + i + ',\'clear\')">↩️ Undo</button></div></div>';
      });
    }
    el.innerHTML = html;
  }

  // ── The Teams view itself ──
  function teamsToolbar() {
    var locked = teamsView.all.filter(function (c) { return c.status === "review" && teamsView.skipped[c.channel_id]; }).length;
    return '<div class="teams-toolbar"><span class="teams-note">Live from Microsoft Teams</span>'
      + (locked ? '<button class="teams-btn-skip" onclick="teamsReviewLocked()">🔒 ' + locked + ' locked — review</button>' : '')
      + '<button class="teams-btn-skip" onclick="loadFileView()">🔄 Refresh</button></div>';
  }

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

    // HARD STOP: anything awaiting a decision blocks everything else, and a
    // customer with no usable channel just sees the explanation.
    if (teamsPendingCount() || !teamsView.channels.length) {
      renderTeamsDecisions(el, overlay);
      return;
    }

    // Channel picker (customer has more than one usable Teams channel)
    if (!teamsView.trail.length) {
      var html = overlay + teamsToolbar() + '<div class="section-label">💬 Teams Channels</div><div class="file-grid">';
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
    var head = overlay + teamsToolbar();
    if (!teamsItems.length) {
      el.innerHTML = head + '<div class="folder-empty-area"><div class="folder-empty-icon">📂</div>'
        + '<div class="folder-empty-strong">This folder is empty</div>'
        + '<div class="folder-empty-p">Nothing in Microsoft Teams here yet.</div></div>';
      return;
    }
    var folders = [], files = [];
    teamsItems.forEach(function (it, i) { (it.is_folder ? folders : files).push({ it: it, i: i }); });
    var html = head;
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
