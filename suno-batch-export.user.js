// ==UserScript==
// @name         Suno Batch Exporter - Library Workspace Only
// @namespace    https://github.com/emmanueltremblay9-stack/Suno-Download-It-All-Remember
// @version      0.1.15
// @description  Export owned Suno Library/Workspace songs with sidecars and optional ID3 metadata.
// @author       Emmanuel Tremblay / Codex
// @homepageURL  https://github.com/emmanueltremblay9-stack/Suno-Download-It-All-Remember
// @supportURL   https://github.com/emmanueltremblay9-stack/Suno-Download-It-All-Remember/issues
// @downloadURL  https://raw.githubusercontent.com/emmanueltremblay9-stack/Suno-Download-It-All-Remember/main/suno-batch-export.user.js
// @updateURL    https://raw.githubusercontent.com/emmanueltremblay9-stack/Suno-Download-It-All-Remember/main/suno-batch-export.user.js
// @match        https://suno.com/*
// @match        https://www.suno.com/*
// @match        https://*.suno.com/*
// @match        https://app.suno.ai/*
// @match        https://*.suno.ai/*
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      self
// @connect      suno.com
// @connect      www.suno.com
// @connect      suno.ai
// @connect      app.suno.ai
// @connect      cdn.suno.ai
// @connect      cdn1.suno.ai
// @connect      cdn2.suno.ai
// @connect      *.suno.ai
// @connect      *.suno.com
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(function sunoBatchExporter() {
  "use strict";

  const SCRIPT_NAME = "Suno Batch Export";
  const VERSION = "0.1.15";
  const DEFAULT_THROTTLE_MS = 1500;
  const MIN_THROTTLE_MS = 750;
  const AUTO_SCAN_IDLE_MS = 900;
  const AUTO_SCAN_STABLE_ROUNDS = 8;
  const AUTO_SCAN_MIN_SCROLL_STEP = 650;
  const DOWNLOAD_HISTORY_KEY = "suno_downloaded_tracks_v1";
  const ALLOWED_PATH_RE = /(^|\/)(library|workspace)(\/|$)/i;
  const SONG_LINK_RE = /\/(?:song|songs|track|tracks|clip|clips|create)\/([a-z0-9-]{8,})/i;
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  const MP3_RE = /\.mp3(?:$|[?#])/i;
  const PAGE_STYLE_ID = "suno-batch-export-page-style";

  const state = {
    songs: [],
    selectedKeys: new Set(),
    failedKeys: new Set(),
    results: [],
    running: false,
    cancelRequested: false,
    exportMode: "zip",
    dryRun: false,
    includeMp3: true,
    embedId3: true,
    includeJson: true,
    includeLyrics: true,
    includeCover: true,
    saveEmptyLyrics: false,
    allowSidecarsWhenMp3Fails: false,
    selectedOnly: false,
    multiSelectMode: false,
    scanningAll: false,
    downloadDirectoryHandle: null,
    downloadDirectoryName: "",
    folderPermissionStatus: "none",
    lastFolderError: "",
    folderWriteTestOk: false,
    lastSelectedIndex: -1,
    throttleMs: DEFAULT_THROTTLE_MS,
    status: "Idle.",
    lastScanAt: null
  };

  const elementByKey = new Map();
  const downloadedTrackKeys = new Set();
  const inProgressTrackKeys = new Set();
  let launcherHost;
  let launcherShadow;
  let host;
  let shadow;
  let scanTimer = null;
  let downloadedDatabaseLoaded = false;

  registerTampermonkeyMenus();

  function registerTampermonkeyMenus() {
    if (typeof GM_registerMenuCommand !== "function") {
      return;
    }
    GM_registerMenuCommand("Open Suno Batch Export panel", openPanel);
    GM_registerMenuCommand("Export Suno Download History", () => {
      exportDownloadedHistory().catch((error) => console.error("[FAILED]", "Export history", error));
    });
    GM_registerMenuCommand("Reset Suno Download History", () => {
      if (window.confirm("Reset Suno duplicate-download history? Songs can be downloaded again after this.")) {
        resetDownloadedHistory().catch((error) => console.error("[FAILED]", "Reset history", error));
      }
    });
  }

  ensureLauncherButton();
  installRouteObserver();
  installPageSelectionHandler();
  scanSoon(300);

  function ensureLauncherButton() {
    if (launcherHost && document.documentElement.contains(launcherHost)) {
      launcherHost.style.display = host && document.documentElement.contains(host) ? "none" : "block";
      positionLauncherButton();
      return;
    }

    launcherHost = document.createElement("div");
    launcherHost.id = "suno-batch-export-launcher-host";
    launcherHost.style.position = "fixed";
    launcherHost.style.zIndex = "2147483647";
    launcherHost.style.right = "24px";
    launcherHost.style.top = "224px";
    launcherHost.style.bottom = "auto";
    document.documentElement.appendChild(launcherHost);

    launcherShadow = launcherHost.attachShadow({ mode: "open" });
    launcherShadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: light dark; }
        button {
          box-sizing: border-box;
          min-height: 38px;
          max-width: calc(100vw - 32px);
          border: 1px solid rgba(120, 120, 120, 0.45);
          border-radius: 8px;
          background: Canvas;
          color: CanvasText;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
          cursor: pointer;
          font: 700 13px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
          padding: 9px 12px;
        }
        button:hover {
          border-color: rgba(20, 100, 220, 0.7);
          background: rgba(20, 100, 220, 0.14);
        }
      </style>
      <button type="button" title="Open Suno Batch Export download menu">Suno Batch Export</button>
    `;
    launcherShadow.querySelector("button").addEventListener("click", openPanel);
    positionLauncherButton();
  }

  function positionLauncherButton() {
    if (!launcherHost || !document.documentElement.contains(launcherHost)) {
      return;
    }
    const anchor = findLauncherAnchorElement();
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const top = Math.min(window.innerHeight - 56, Math.max(16, rect.bottom + 10));
      const right = Math.max(16, window.innerWidth - rect.right);
      launcherHost.style.top = `${top}px`;
      launcherHost.style.right = `${right}px`;
      launcherHost.style.bottom = "auto";
      return;
    }
    launcherHost.style.top = "224px";
    launcherHost.style.right = "24px";
    launcherHost.style.bottom = "auto";
  }

  function findLauncherAnchorElement() {
    const controls = Array.from(document.querySelectorAll("button, a[href], [role='button']"));
    const audioButton = controls.find((control) => {
      if (!(control instanceof Element) || !isVisible(control)) {
        return false;
      }
      const text = `${control.textContent || ""} ${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""}`;
      return /\baudio\b/i.test(text);
    });
    if (!audioButton) {
      return null;
    }
    return audioButton.parentElement || audioButton;
  }

  function openPanel() {
    ensurePanel();
    scanSongs();
    render();
  }

  // The panel is isolated in a shadow root so Suno CSS changes are less likely
  // to break controls or make buttons unreadable.
  function ensurePanel() {
    if (host && document.documentElement.contains(host)) {
      if (launcherHost) {
        launcherHost.style.display = "none";
      }
      return;
    }

    host = document.createElement("div");
    host.id = "suno-batch-export-host";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.right = "16px";
    host.style.bottom = "16px";
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    if (launcherHost) {
      launcherHost.style.display = "none";
    }
    render();
  }

  function installRouteObserver() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function patchedPushState() {
      const result = originalPushState.apply(this, arguments);
      scanSoon(500);
      return result;
    };
    history.replaceState = function patchedReplaceState() {
      const result = originalReplaceState.apply(this, arguments);
      scanSoon(500);
      return result;
    };
    window.addEventListener("popstate", () => scanSoon(500));
    window.addEventListener("resize", positionLauncherButton);

    const observer = new MutationObserver(() => {
      ensureLauncherButton();
      if (isAllowedPage()) {
        scanSoon(1200);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function scanSoon(delayMs) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (!state.running) {
        scanSongs();
        render();
      }
    }, delayMs);
  }

  function isAllowedPage() {
    return isSunoHost(location.hostname);
  }

  function isPreferredLibraryOrWorkspaceRoute() {
    return ALLOWED_PATH_RE.test(location.pathname)
      || /\b(library|workspace)\b/i.test(document.title || "")
      || Boolean(document.querySelector("a[href*='library' i], a[href*='workspace' i], [aria-current='page'][aria-label*='library' i], [aria-current='page'][aria-label*='workspace' i]"));
  }

  function isSunoHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "suno.com"
      || host === "www.suno.com"
      || host === "app.suno.ai"
      || host.endsWith(".suno.com")
      || host.endsWith(".suno.ai");
  }

  function render() {
    if (!shadow) {
      return;
    }

    const allowed = isAllowedPage();
    const queuedSongs = state.songs;
    const selectedCount = state.songs.filter((song) => state.selectedKeys.has(song.key)).length;
    const queuedSelectedCount = queuedSongs.filter((song) => state.selectedKeys.has(song.key)).length;
    const allQueuedSelected = Boolean(queuedSongs.length) && queuedSelectedCount === queuedSongs.length;
    const someQueuedSelected = queuedSelectedCount > 0 && !allQueuedSelected;
    const failedCount = state.failedKeys.size;
    const canChooseDownloadFolder = canUseDirectoryPicker();
    const folderButtonText = state.downloadDirectoryHandle ? "Change folder" : "Select folder";
    const folderStatus = buildFolderStatus(canChooseDownloadFolder);
    const listItems = queuedSongs.map((song, index) => {
      const checked = state.selectedKeys.has(song.key) ? "checked" : "";
      const metaLine = [song.duration, song.creationDate, song.id || song.fallbackId].filter(Boolean).join(" | ");
      const title = escapeHtml(song.title || "Untitled Suno song");
      const details = escapeHtml(metaLine || "Visible card metadata");
      return `
        <label class="song-row ${checked ? "is-selected" : ""}" title="${escapeHtml(song.url || "")}">
          <input type="checkbox" data-key="${escapeHtml(song.key)}" data-index="${index}" ${checked} ${state.running ? "disabled" : ""}>
          <span>
            <strong>${title}</strong>
            <small>${details}</small>
          </span>
        </label>
      `;
    }).join("");

    const failures = state.results
      .filter((result) => result.status === "failed" || result.warnings.length)
      .slice(-5)
      .map((result) => `<li>${escapeHtml(result.title)}: ${escapeHtml(result.error || result.warnings.join("; "))}</li>`)
      .join("");

    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: light dark; }
        .panel {
          box-sizing: border-box;
          width: min(420px, calc(100vw - 32px));
          max-height: min(720px, calc(100vh - 32px));
          overflow: hidden;
          border: 1px solid rgba(120, 120, 120, 0.35);
          border-radius: 8px;
          background: Canvas;
          color: CanvasText;
          box-shadow: 0 20px 48px rgba(0, 0, 0, 0.22);
          font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(120, 120, 120, 0.25);
        }
        .title { font-weight: 700; }
        .version { opacity: 0.65; font-size: 11px; }
        .body {
          display: grid;
          gap: 10px;
          padding: 12px;
          max-height: calc(min(720px, calc(100vh - 32px)) - 48px);
          overflow: auto;
        }
        .blocked {
          padding: 10px;
          border: 1px solid rgba(180, 120, 0, 0.4);
          border-radius: 6px;
          background: rgba(180, 120, 0, 0.08);
        }
        .controls, .options, .actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }
        .folder-note {
          flex-basis: 100%;
          font-size: 11px;
          opacity: 0.68;
        }
        button, select, input[type="number"] {
          box-sizing: border-box;
          min-height: 30px;
          border: 1px solid rgba(120, 120, 120, 0.45);
          border-radius: 6px;
          background: ButtonFace;
          color: ButtonText;
          font: inherit;
        }
        button {
          padding: 5px 9px;
          cursor: pointer;
        }
        button.primary {
          border-color: rgba(20, 100, 220, 0.55);
          background: rgba(20, 100, 220, 0.16);
        }
        button.danger {
          border-color: rgba(190, 40, 40, 0.55);
          background: rgba(190, 40, 40, 0.13);
        }
        button:disabled, input:disabled, select:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }
        label.check {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          white-space: nowrap;
        }
        input[type="number"] {
          width: 82px;
          padding: 4px 6px;
        }
        select {
          padding: 4px 6px;
        }
        .summary {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
        }
        .metric {
          border: 1px solid rgba(120, 120, 120, 0.25);
          border-radius: 6px;
          padding: 6px;
        }
        .metric strong { display: block; font-size: 18px; }
        .metric small { opacity: 0.7; }
        .song-list {
          display: grid;
          gap: 4px;
          max-height: 210px;
          overflow: auto;
          border: 1px solid rgba(120, 120, 120, 0.25);
          border-radius: 6px;
          padding: 6px;
        }
        .song-row {
          display: grid;
          grid-template-columns: 20px 1fr;
          gap: 6px;
          align-items: start;
          padding: 5px;
          border-radius: 5px;
        }
        .song-row:hover {
          background: rgba(120, 120, 120, 0.1);
        }
        .song-row.is-selected {
          background: rgba(20, 100, 220, 0.11);
        }
        .song-row strong, .song-row small {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .song-row small {
          opacity: 0.65;
          font-size: 11px;
        }
        .selection-toolbar {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          justify-content: space-between;
          border: 1px solid rgba(120, 120, 120, 0.25);
          border-radius: 6px;
          padding: 6px;
        }
        .selection-toolbar small {
          opacity: 0.68;
        }
        .status {
          border-top: 1px solid rgba(120, 120, 120, 0.25);
          padding-top: 8px;
          white-space: pre-wrap;
        }
        .failures {
          margin: 0;
          padding-left: 18px;
          max-height: 100px;
          overflow: auto;
        }
        .hidden { display: none; }
      </style>
      <section class="panel" aria-label="${SCRIPT_NAME}">
        <div class="header">
          <div>
            <div class="title">${SCRIPT_NAME}</div>
            <div class="version">v${VERSION}</div>
          </div>
          <button type="button" data-action="minimize" title="Hide panel">Hide</button>
        </div>
        <div class="body">
          ${allowed ? "" : `<div class="blocked">Open Suno in this tab to enable export controls.</div>`}
          ${allowed && !isPreferredLibraryOrWorkspaceRoute() ? `<div class="blocked">For compliance, use this only on your own Suno Library or Workspace. The script will export only detected visible/authorized Suno songs.</div>` : ""}
          <div class="controls">
            <button type="button" data-action="scan" ${state.running ? "disabled" : ""}>Scan visible</button>
            <button type="button" data-action="scan-all" ${state.running || !allowed ? "disabled" : ""}>Scan all</button>
            <button type="button" data-action="select-all" ${state.running || !allowed ? "disabled" : ""}>Select all</button>
            <button type="button" data-action="select-none" ${state.running ? "disabled" : ""}>Select none</button>
            <label class="check"><input type="checkbox" data-option="selectedOnly" ${state.selectedOnly ? "checked" : ""} ${state.running ? "disabled" : ""}> selected only</label>
            <label class="check"><input type="checkbox" data-option="multiSelectMode" ${state.multiSelectMode ? "checked" : ""} ${state.running || !allowed ? "disabled" : ""}> multi-select</label>
          </div>
          <div class="summary">
            <div class="metric"><strong>${state.songs.length}</strong><small>queued</small></div>
            <div class="metric"><strong>${selectedCount}</strong><small>selected</small></div>
            <div class="metric"><strong>${failedCount}</strong><small>failed</small></div>
          </div>
          <div class="options">
            <label class="check"><input type="checkbox" data-option="includeMp3" ${state.includeMp3 ? "checked" : ""} ${state.running ? "disabled" : ""}> MP3</label>
            <label class="check"><input type="checkbox" data-option="embedId3" ${state.embedId3 ? "checked" : ""} ${state.running || !state.includeMp3 ? "disabled" : ""}> ID3</label>
            <label class="check"><input type="checkbox" data-option="includeJson" ${state.includeJson ? "checked" : ""} ${state.running ? "disabled" : ""}> JSON</label>
            <label class="check"><input type="checkbox" data-option="includeLyrics" ${state.includeLyrics ? "checked" : ""} ${state.running ? "disabled" : ""}> TXT</label>
            <label class="check"><input type="checkbox" data-option="saveEmptyLyrics" ${state.saveEmptyLyrics ? "checked" : ""} ${state.running || !state.includeLyrics ? "disabled" : ""}> empty TXT</label>
            <label class="check"><input type="checkbox" data-option="includeCover" ${state.includeCover ? "checked" : ""} ${state.running ? "disabled" : ""}> cover</label>
            <label class="check"><input type="checkbox" data-option="allowSidecarsWhenMp3Fails" ${state.allowSidecarsWhenMp3Fails ? "checked" : ""} ${state.running ? "disabled" : ""}> sidecars if MP3 fails</label>
            <label>Mode
              <select data-option="exportMode" ${state.running ? "disabled" : ""}>
                <option value="zip" ${state.exportMode === "zip" ? "selected" : ""}>ZIP</option>
                <option value="individual" ${state.exportMode === "individual" ? "selected" : ""}>Individual</option>
              </select>
            </label>
            <label>Delay
              <input type="number" min="${MIN_THROTTLE_MS}" step="250" data-option="throttleMs" value="${state.throttleMs}" ${state.running ? "disabled" : ""}>
            </label>
          </div>
          <div class="actions">
            <button type="button" class="primary" data-action="dry-run" ${state.running || !allowed || !selectedCount ? "disabled" : ""}>Dry run</button>
            <button type="button" class="primary" data-action="export" ${state.running || !allowed || !selectedCount ? "disabled" : ""}>Export</button>
            <button type="button" data-action="select-folder" title="Select download folder" ${state.running || !canChooseDownloadFolder ? "disabled" : ""}>${folderButtonText}</button>
            <button type="button" data-action="test-folder" title="Test selected download folder" ${state.running || !state.downloadDirectoryHandle ? "disabled" : ""}>Test folder</button>
            <button type="button" data-action="retry" ${state.running || !allowed || !failedCount ? "disabled" : ""}>Retry failed</button>
            <button type="button" class="danger" data-action="cancel" ${state.running ? "" : "disabled"}>Cancel</button>
            <small class="folder-note">${escapeHtml(folderStatus)}</small>
          </div>
          <div class="selection-toolbar">
            <label class="check">
              <input type="checkbox" data-select-queued ${allQueuedSelected ? "checked" : ""} ${state.running || !queuedSongs.length ? "disabled" : ""}>
              all queued
            </label>
            <small>${queuedSelectedCount}/${queuedSongs.length} queued selected; Shift-click selects a range.</small>
          </div>
          <div class="song-list" aria-label="Detected Suno songs">
            ${listItems || "<small>No visible song cards detected yet.</small>"}
          </div>
          <div class="status">${escapeHtml(state.status)}</div>
          <ul class="failures ${failures ? "" : "hidden"}">${failures}</ul>
        </div>
      </section>
    `;

    bindPanelEvents();
    const selectQueued = shadow.querySelector("input[data-select-queued]");
    if (selectQueued) {
      selectQueued.indeterminate = someQueuedSelected;
    }
    applyCardSelectionDecorations();
  }

  function bindPanelEvents() {
    shadow.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleAction(button.dataset.action));
    });
    shadow.querySelectorAll("input[data-option], select[data-option]").forEach((input) => {
      input.addEventListener("change", () => handleOption(input));
    });
    const selectQueued = shadow.querySelector("input[data-select-queued]");
    if (selectQueued) {
      selectQueued.addEventListener("change", () => {
        setQueueSelection(selectQueued.checked);
        state.lastSelectedIndex = selectQueued.checked ? Math.max(0, state.songs.length - 1) : -1;
        render();
      });
    }
    shadow.querySelectorAll("input[data-key]").forEach((input) => {
      input.addEventListener("click", (event) => handleSongCheckboxClick(input, event));
    });
  }

  function handleOption(input) {
    const key = input.dataset.option;
    if (input.type === "checkbox") {
      state[key] = input.checked;
      if (key === "multiSelectMode" && input.checked && !state.songs.length) {
        scanSongs({ mergeExisting: true });
      }
    } else if (input.type === "number") {
      state[key] = Math.max(MIN_THROTTLE_MS, Number(input.value) || DEFAULT_THROTTLE_MS);
    } else {
      state[key] = input.value;
    }
    render();
  }

  function handleAction(action) {
    if (action === "minimize") {
      host.remove();
      host = null;
      shadow = null;
      ensureLauncherButton();
      return;
    }
    if (action === "scan") {
      scanSongs({ mergeExisting: true });
      render();
      return;
    }
    if (action === "scan-all") {
      scanAllSongs();
      return;
    }
    if (action === "select-all") {
      state.songs.forEach((song) => state.selectedKeys.add(song.key));
      state.lastSelectedIndex = Math.max(0, state.songs.length - 1);
      render();
      return;
    }
    if (action === "select-none") {
      state.selectedKeys.clear();
      state.lastSelectedIndex = -1;
      render();
      return;
    }
    if (action === "cancel") {
      state.cancelRequested = true;
      state.status = "Cancel requested. The current item will finish first.";
      render();
      return;
    }
    if (action === "retry") {
      retryFailed();
      return;
    }
    if (action === "dry-run") {
      startBatch({ dryRun: true });
      return;
    }
    if (action === "export") {
      startBatch({ dryRun: false });
      return;
    }
    if (action === "select-folder") {
      selectDownloadFolder();
      return;
    }
    if (action === "test-folder") {
      testDownloadFolder();
    }
  }

  function buildFolderStatus(canChooseDownloadFolder) {
    if (state.downloadDirectoryHandle) {
      const folderName = state.downloadDirectoryName || "selected folder";
      if (state.lastFolderError) {
        return `Selected folder is not active; using browser Downloads. Last folder error: ${state.lastFolderError}`;
      }
      if (state.folderWriteTestOk) {
        return `Selected folder is active: ${folderName}. Folder test succeeded. Folder selection lasts only for this page session.`;
      }
      if (state.folderPermissionStatus === "granted") {
        return `Selected folder is active: ${folderName}. Click Test folder to verify writes. Folder selection lasts only for this page session.`;
      }
      if (state.folderPermissionStatus === "prompt") {
        return `Folder selected for this page session: ${folderName}. Permission may need renewal; click Test folder.`;
      }
      if (state.folderPermissionStatus === "denied") {
        return "Selected folder is not active; using browser Downloads.";
      }
      return `Folder selected for this page session: ${folderName}. Click Test folder to verify.`;
    }
    return canChooseDownloadFolder
      ? "Selected folder is not active; using browser Downloads."
      : "Folder picker unavailable; using browser Downloads.";
  }

  function scanSongs(options = {}) {
    const mergeExisting = options.mergeExisting !== false;
    const updateStatus = options.updateStatus !== false;
    clearCardSelectionDecorations();
    elementByKey.clear();
    const cards = findSongCards();
    const scannedSongs = dedupeSongs(cards.map((card, index) => extractSong(card, index)).filter(Boolean));
    const mergeResult = mergeExisting
      ? mergeScannedSongs(state.songs, scannedSongs)
      : { songs: scannedSongs, addedKeys: new Set(scannedSongs.map((song) => song.key)) };
    state.songs = mergeResult.songs;
    state.lastScanAt = new Date();

    const queuedKeys = new Set(state.songs.map((song) => song.key));
    for (const key of Array.from(state.selectedKeys)) {
      if (!queuedKeys.has(key)) {
        state.selectedKeys.delete(key);
      }
    }

    for (const song of scannedSongs) {
      if (!state.selectedOnly && mergeResult.addedKeys.has(song.key)) {
        state.selectedKeys.add(song.key);
      }
      if (song.selected) {
        state.selectedKeys.add(song.key);
      }
      if (song.card) {
        elementByKey.set(song.key, song.card);
      }
    }

    for (const song of state.songs) {
      delete song.card;
    }

    if (updateStatus) {
      state.status = `Queued ${state.songs.length} song(s); ${scannedSongs.length} currently rendered, ${mergeResult.addedKeys.size} new.`;
    }
    applyCardSelectionDecorations();
    return {
      visibleCount: scannedSongs.length,
      addedCount: mergeResult.addedKeys.size,
      totalCount: state.songs.length
    };
  }

  async function scanAllSongs() {
    if (state.running) {
      return;
    }
    if (!isAllowedPage()) {
      state.status = "Open a Suno page before scanning.";
      render();
      return;
    }

    state.running = true;
    state.scanningAll = true;
    state.cancelRequested = false;
    const startedCount = state.songs.length;
    const scrollTargets = findScrollableScanTargets();
    const originalPositions = captureScrollPositions(scrollTargets);
    let stableRounds = 0;
    let pass = 0;
    let lastTotal = state.songs.length;

    try {
      state.status = "Scan all started. Loading rendered songs and scrolling the Suno library.";
      render();

      let result = scanSongs({ mergeExisting: true, updateStatus: false });
      setQueueSelection(true);
      state.status = `Scan all: ${state.songs.length} queued, ${result.visibleCount} currently rendered.`;
      render();

      while (!state.cancelRequested) {
        const moved = scrollScanTargets(scrollTargets);
        await delay(AUTO_SCAN_IDLE_MS);
        result = scanSongs({ mergeExisting: true, updateStatus: false });
        setQueueSelection(true);
        pass += 1;

        if (result.totalCount > lastTotal || result.addedCount > 0) {
          stableRounds = 0;
        } else {
          stableRounds += 1;
        }
        lastTotal = result.totalCount;

        const newTotal = Math.max(0, state.songs.length - startedCount);
        state.status = `Scan all pass ${pass}: ${state.songs.length} queued (${newTotal} new), ${result.visibleCount} currently rendered.`;
        render();

        if (!moved && stableRounds >= 2) {
          break;
        }
        if (stableRounds >= AUTO_SCAN_STABLE_ROUNDS) {
          break;
        }
      }

      state.status = state.cancelRequested
        ? `Scan all canceled. ${state.songs.length} song(s) remain queued.`
        : `Scan all complete. ${state.songs.length} song(s) queued and selected.`;
    } finally {
      restoreScrollPositions(originalPositions);
      state.running = false;
      state.scanningAll = false;
      state.cancelRequested = false;
      render();
    }
  }

  function mergeScannedSongs(existingSongs, scannedSongs) {
    const songs = existingSongs.map((song) => ({ ...song }));
    const identityMap = new Map();
    const addedKeys = new Set();

    songs.forEach((song, index) => {
      for (const identity of songIdentityCandidates(song)) {
        if (!identityMap.has(identity)) {
          identityMap.set(identity, index);
        }
      }
    });

    for (const scannedSong of scannedSongs) {
      const identities = songIdentityCandidates(scannedSong);
      const existingIndex = identities.find((identity) => identityMap.has(identity));
      if (existingIndex) {
        const index = identityMap.get(existingIndex);
        scannedSong.key = songs[index].key;
        const merged = {
          ...songs[index],
          ...scannedSong,
          key: songs[index].key
        };
        songs[index] = merged;
        for (const identity of songIdentityCandidates(merged)) {
          if (!identityMap.has(identity)) {
            identityMap.set(identity, index);
          }
        }
      } else {
        const index = songs.length;
        songs.push(scannedSong);
        addedKeys.add(scannedSong.key);
        for (const identity of identities) {
          if (!identityMap.has(identity)) {
            identityMap.set(identity, index);
          }
        }
      }
    }

    return { songs, addedKeys };
  }

  function findScrollableScanTargets() {
    const targets = new Set();
    const scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement) {
      targets.add(scrollingElement);
    }

    Array.from(document.querySelectorAll("main, [role='main'], section, div")).forEach((node) => {
      if (!(node instanceof Element) || !isScrollableElement(node)) {
        return;
      }
      targets.add(node);
    });

    return Array.from(targets)
      .sort((left, right) => scrollRange(right) - scrollRange(left))
      .slice(0, 8);
  }

  function isScrollableElement(element) {
    const style = getComputedStyle(element);
    if (!/(auto|scroll|overlay)/i.test(`${style.overflowY} ${style.overflow}`)) {
      return false;
    }
    return scrollRange(element) > 120;
  }

  function scrollRange(target) {
    return Math.max(0, target.scrollHeight - target.clientHeight);
  }

  function captureScrollPositions(targets) {
    return targets.map((target) => ({ target, top: target.scrollTop, left: target.scrollLeft }));
  }

  function restoreScrollPositions(positions) {
    for (const position of positions) {
      if (position.target && position.target.isConnected) {
        position.target.scrollTop = position.top;
        position.target.scrollLeft = position.left;
      }
    }
  }

  function scrollScanTargets(targets) {
    let moved = false;
    for (const target of targets) {
      if (!target || !target.isConnected) {
        continue;
      }
      const maxTop = scrollRange(target);
      const before = target.scrollTop;
      if (before >= maxTop - 2) {
        continue;
      }
      const step = Math.max(AUTO_SCAN_MIN_SCROLL_STEP, Math.floor(target.clientHeight * 0.85));
      target.scrollTop = Math.min(maxTop, before + step);
      if (Math.abs(target.scrollTop - before) > 1) {
        moved = true;
      }
    }
    return moved;
  }

  function handleSongCheckboxClick(input, event) {
    const index = Number(input.dataset.index);
    const checked = input.checked;
    if (event.shiftKey && state.lastSelectedIndex >= 0) {
      setSelectionRange(state.lastSelectedIndex, index, checked);
    } else {
      setSongSelected(input.dataset.key, checked);
    }
    state.lastSelectedIndex = index;
    render();
  }

  function setSongSelected(key, selected) {
    if (selected) {
      state.selectedKeys.add(key);
    } else {
      state.selectedKeys.delete(key);
    }
  }

  function setSelectionRange(fromIndex, toIndex, selected) {
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    state.songs.slice(start, end + 1).forEach((song) => setSongSelected(song.key, selected));
  }

  function setQueueSelection(selected) {
    state.songs.forEach((song) => setSongSelected(song.key, selected));
  }

  function installPageSelectionHandler() {
    document.addEventListener("click", (event) => {
      if (!state.multiSelectMode || state.running || !isAllowedPage()) {
        return;
      }
      const match = findDetectedCardFromTarget(event.target);
      if (!match) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSongSelected(match.key, !state.selectedKeys.has(match.key));
      state.lastSelectedIndex = state.songs.findIndex((song) => song.key === match.key);
      state.status = `${state.selectedKeys.has(match.key) ? "Selected" : "Deselected"}: ${match.song.title}`;
      render();
    }, true);
  }

  function findDetectedCardFromTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    for (const song of state.songs) {
      const card = elementByKey.get(song.key);
      if (card && card.contains(target)) {
        return { key: song.key, song, card };
      }
    }
    return null;
  }

  function applyCardSelectionDecorations() {
    ensurePageStyle();
    for (const song of state.songs) {
      const card = elementByKey.get(song.key);
      if (!card || !card.isConnected) {
        continue;
      }
      card.classList.toggle("suno-batch-card-selectable", state.multiSelectMode);
      card.classList.toggle("suno-batch-card-selected", state.selectedKeys.has(song.key));
      card.setAttribute("data-suno-batch-export-key", song.key);
    }
  }

  function clearCardSelectionDecorations() {
    for (const card of elementByKey.values()) {
      if (!card || !card.isConnected) {
        continue;
      }
      card.classList.remove("suno-batch-card-selectable", "suno-batch-card-selected");
      card.removeAttribute("data-suno-batch-export-key");
    }
  }

  function ensurePageStyle() {
    if (document.getElementById(PAGE_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = PAGE_STYLE_ID;
    style.textContent = `
      .suno-batch-card-selectable {
        cursor: copy !important;
        outline: 2px dashed rgba(20, 100, 220, 0.45) !important;
        outline-offset: 2px !important;
      }
      .suno-batch-card-selected {
        outline: 3px solid rgba(20, 100, 220, 0.9) !important;
        outline-offset: 2px !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function findSongCards() {
    if (!isAllowedPage()) {
      state.status = "Export controls are disabled outside Suno pages.";
      return [];
    }

    const candidates = new Set();
    const selectors = [
      "a[href*='/song' i]",
      "a[href*='/songs' i]",
      "a[href*='/clip' i]",
      "a[href*='/clips' i]",
      "a[href*='/track' i]",
      "a[href*='/tracks' i]",
      "a[href*='.mp3' i]",
      "audio",
      "source[src]",
      "[data-testid*='song' i]",
      "[data-testid*='track' i]",
      "[data-testid*='clip' i]",
      "[aria-label*='song' i]",
      "[aria-label*='track' i]",
      "article",
      "[role='listitem']",
      "[class*='song' i]",
      "[class*='track' i]"
    ];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const card = closestLikelyCard(node);
        if (card && isVisible(card) && looksLikeSongCard(card)) {
          candidates.add(card);
        }
      });
    }

    if (!candidates.size) {
      findLooseSongElements().forEach((node) => candidates.add(node));
    }

    return Array.from(candidates);
  }

  function findLooseSongElements() {
    const loose = [];
    document.querySelectorAll("a[href], audio[src], source[src], img[src]").forEach((node) => {
      if (!(node instanceof Element) || !isVisible(node)) {
        return;
      }
      const href = node.getAttribute("href") || node.getAttribute("src") || "";
      const text = `${href} ${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("alt") || ""}`;
      if (SONG_LINK_RE.test(text) || MP3_RE.test(text) || /\b(song|track|clip)\b/i.test(text)) {
        loose.push(node);
      }
    });
    return loose;
  }

  function closestLikelyCard(node) {
    if (!(node instanceof Element)) {
      return null;
    }
    const explicit = node.closest("article, [role='listitem'], [data-testid*='song' i], [data-testid*='track' i], [data-testid*='clip' i]");
    if (explicit) {
      return explicit;
    }
    let current = node;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (looksLikeSongCard(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function looksLikeSongCard(card) {
    const text = normalizedText(card);
    const hasSongLink = Boolean(findSongUrl(card));
    const hasMedia = Boolean(findAudioUrl(card) || card.querySelector("audio, source, img"));
    const hasTitle = Boolean(findTitle(card));
    const hasDuration = /\b\d{1,2}:\d{2}\b/.test(text);
    const hasDownload = Boolean(findOfficialDownloadButton(card));
    return hasSongLink || (hasMedia && hasTitle) || (hasTitle && (hasDuration || hasDownload));
  }

  function extractSong(card, index) {
    const url = findSongUrl(card);
    const id = findSongId(card, url);
    const title = findTitle(card) || `Suno song ${index + 1}`;
    const artist = findArtist(card) || findCurrentUser() || "SunoUser";
    const lyrics = findLyrics(card);
    const prompt = findLabeledValue(card, ["prompt", "description"]);
    const style = findLabeledValue(card, ["style", "genre"]);
    const model = findLabeledValue(card, ["model", "version"]);
    const tags = findTags(card);
    const duration = findDuration(card);
    const creationDate = findCreationDate(card);
    const coverUrl = findCoverUrl(card);
    const audioUrl = findAudioUrl(card);
    const selected = isCardSelected(card);
    const textHash = shortHash(normalizedText(card).slice(0, 1200));
    const fallbackBasis = [title, duration, creationDate, url, audioUrl, coverUrl, textHash].filter(Boolean).join("|") || String(index);
    const safeId = id || `visible-${shortHash(fallbackBasis)}`;
    const key = `${safeId}-${shortHash([url, audioUrl, title, duration, creationDate, coverUrl, textHash].join("|"))}`;
    const baseName = cleanFileName(`${artist} - ${title} [${safeId}]`);
    console.info("[DETECTED]", title, {
      songUrl: url || "",
      audioUrl: audioUrl || ""
    });

    return {
      key,
      id,
      songId: id,
      fallbackId: safeId,
      title,
      artist,
      lyrics,
      prompt,
      style,
      tags,
      model,
      sunoUrl: url || location.href,
      url,
      creationDate,
      duration,
      coverUrl,
      audioUrl,
      selected,
      baseName,
      suggestedFileName: `${baseName}.mp3`,
      detectedAt: new Date().toISOString(),
      sourcePage: location.href,
      card
    };
  }

  function dedupeSongs(songs) {
    const seen = new Set();
    const output = [];
    for (const song of songs) {
      const identities = songIdentityCandidates(song);
      if (identities.some((identity) => seen.has(identity))) {
        continue;
      }
      output.push(song);
      identities.forEach((identity) => seen.add(identity));
    }
    return output;
  }

  function songIdentityCandidates(song) {
    const identities = [];
    const id = firstNonEmpty(song && song.songId, song && song.id, song && song.clip_id, song && song.clipId);
    if (id && !/^visible-/i.test(String(id))) {
      identities.push(`id:${normalizeDuplicatePart(id)}`);
    }

    const songUrl = firstNonEmpty(song && song.url, song && song.sunoUrl);
    if (songUrl && songUrl !== location.href) {
      identities.push(`url:${normalizeAudioDuplicateUrl(songUrl)}`);
    }

    const audioUrl = firstNonEmpty(song && song.audioUrl, song && song.audio_url, song && song.downloadUrl, song && song.download_url);
    if (audioUrl) {
      identities.push(`audio:${normalizeAudioDuplicateUrl(audioUrl)}`);
    }

    const title = normalizeDuplicatePart(firstNonEmpty(song && song.title, song && song.name));
    const duration = normalizeDuplicatePart(firstNonEmpty(song && song.duration, song && song.length));
    const created = normalizeDuplicatePart(firstNonEmpty(song && song.creationDate, song && song.createdAt, song && song.created_at));
    const coverUrl = firstNonEmpty(song && song.coverUrl, song && song.cover_url);
    const cover = coverUrl ? normalizeAudioDuplicateUrl(coverUrl) : "";
    if (title && (duration || created || cover || audioUrl)) {
      identities.push(`fp:${[title, duration, created, cover].join("|")}`);
    }

    if (song && song.key) {
      identities.push(`key:${song.key}`);
    }

    return identities.length ? identities : [`unknown:${shortHash(JSON.stringify(song || {}))}`];
  }

  async function loadDownloadedDatabase() {
    if (downloadedDatabaseLoaded) {
      return downloadedTrackKeys;
    }

    const saved = await gmGetValue(DOWNLOAD_HISTORY_KEY, []);
    const keys = Array.isArray(saved) ? saved : [];
    downloadedTrackKeys.clear();
    keys.filter(Boolean).forEach((key) => downloadedTrackKeys.add(String(key)));
    downloadedDatabaseLoaded = true;
    return downloadedTrackKeys;
  }

  async function saveDownloadedDatabase() {
    await gmSetValue(DOWNLOAD_HISTORY_KEY, Array.from(downloadedTrackKeys).sort());
  }

  function buildTrackKey(track) {
    const songId = firstNonEmpty(
      track && track.id,
      track && track.songId,
      track && track.song_id,
      track && track.clip_id,
      track && track.clipId,
      track && track.sunoId
    );
    if (songId) {
      return `suno-id:${normalizeDuplicatePart(songId)}`;
    }

    const audioId = firstNonEmpty(
      track && track.audioFileId,
      track && track.audio_file_id,
      track && track.audioId,
      track && track.audio_id
    );
    if (audioId) {
      return `audio-id:${normalizeDuplicatePart(audioId)}`;
    }

    const audioUrl = firstNonEmpty(
      track && track.audioUrl,
      track && track.audio_url,
      track && track.downloadUrl,
      track && track.download_url
    );
    if (audioUrl) {
      return `audio-url:${normalizeAudioDuplicateUrl(audioUrl)}`;
    }

    const title = firstNonEmpty(track && track.title, track && track.name);
    const duration = firstNonEmpty(track && track.duration, track && track.length);
    const created = firstNonEmpty(
      track && track.createdAt,
      track && track.created_at,
      track && track.creationDate,
      track && track.generatedAt,
      track && track.generated_at
    );
    const fallback = [
      normalizeDuplicatePart(title || "untitled"),
      normalizeDuplicatePart(duration || "unknown-duration"),
      normalizeDuplicatePart(created || "unknown-date")
    ].join("|");
    return `fingerprint:${fallback}`;
  }

  async function isDuplicateTrack(track) {
    await loadDownloadedDatabase();
    return downloadedTrackKeys.has(buildTrackKey(track));
  }

  async function markTrackDownloaded(track) {
    await loadDownloadedDatabase();
    const key = buildTrackKey(track);
    downloadedTrackKeys.add(key);
    await saveDownloadedDatabase();
    console.info("[DOWNLOADED]", key, trackLabel(track));
    return key;
  }

  async function downloadTrackSafely(track, options = {}) {
    await loadDownloadedDatabase();
    const key = buildTrackKey(track);

    if (downloadedTrackKeys.has(key)) {
      console.info("[SKIP DUPLICATE]", key, trackLabel(track));
      return { status: "duplicate", key };
    }
    if (inProgressTrackKeys.has(key)) {
      console.info("[SKIP IN PROGRESS]", key, trackLabel(track));
      return { status: "in-progress", key };
    }

    inProgressTrackKeys.add(key);
    console.info("[DOWNLOADING]", key, trackLabel(track));

    try {
      const fileName = options.fileName || track.suggestedFileName || `${cleanFileName(trackLabel(track))}.mp3`;
      let downloadResult;
      if (options.blob) {
        downloadResult = await saveExportBlob(options.blob, fileName, options.relativePath || `mp3/${fileName}`, { confirmedDownload: true });
      } else {
        const url = firstNonEmpty(track.downloadUrl, track.download_url, track.audioUrl, track.audio_url);
        if (!url) {
          throw new Error("No downloadable MP3 URL is available for this track.");
        }
        downloadResult = await downloadUrlWithGm(url, fileName);
      }
      if (downloadResult && downloadResult.confirmed === false) {
        console.warn("[FAILED]", key, trackLabel(track), "Download was started with browser fallback, but completion could not be confirmed.");
        return {
          status: "downloaded-unconfirmed",
          key,
          error: downloadResult.error || "Browser fallback download was started, but completion could not be confirmed."
        };
      }
      await markTrackDownloaded(track);
      return { status: "downloaded", key };
    } catch (error) {
      console.error("[FAILED]", key, trackLabel(track), error);
      return { status: "failed", key, error: messageFrom(error) };
    } finally {
      inProgressTrackKeys.delete(key);
    }
  }

  async function resetDownloadedHistory() {
    downloadedTrackKeys.clear();
    inProgressTrackKeys.clear();
    downloadedDatabaseLoaded = true;
    await saveDownloadedDatabase();
    console.info("Reset Suno download history.");
  }

  async function exportDownloadedHistory() {
    await loadDownloadedDatabase();
    const history = Array.from(downloadedTrackKeys).sort();
    const payload = {
      schema: DOWNLOAD_HISTORY_KEY,
      exportedAt: new Date().toISOString(),
      count: history.length,
      keys: history
    };
    console.info("Suno download history", payload);
    downloadBlob(
      new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" }),
      `suno-download-history-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
  }

  async function gmGetValue(key, defaultValue) {
    if (typeof GM !== "undefined" && GM && typeof GM.getValue === "function") {
      return GM.getValue(key, defaultValue);
    }
    if (typeof GM_getValue === "function") {
      return GM_getValue(key, defaultValue);
    }
    throw new Error("Tampermonkey GM_getValue is unavailable.");
  }

  async function gmSetValue(key, value) {
    if (typeof GM !== "undefined" && GM && typeof GM.setValue === "function") {
      return GM.setValue(key, value);
    }
    if (typeof GM_setValue === "function") {
      return GM_setValue(key, value);
    }
    throw new Error("Tampermonkey GM_setValue is unavailable.");
  }

  function firstNonEmpty(...values) {
    return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || "";
  }

  function normalizeDuplicatePart(value) {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, " ");
  }

  function normalizeAudioDuplicateUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl), location.href);
      return normalizeDuplicatePart(`${url.origin}${url.pathname}`);
    } catch {
      return normalizeDuplicatePart(String(rawUrl).replace(/[?#].*$/, ""));
    }
  }

  function trackLabel(track) {
    return firstNonEmpty(track && track.title, track && track.name, track && track.suggestedFileName, "Untitled Suno track");
  }

  async function retryFailed() {
    const retryKeys = new Set(state.failedKeys);
    state.selectedKeys = retryKeys;
    await startBatch({ dryRun: false });
  }

  function canUseDirectoryPicker() {
    return Boolean(getDirectoryPicker());
  }

  function getDirectoryPicker() {
    if (typeof window.showDirectoryPicker === "function") {
      return window.showDirectoryPicker.bind(window);
    }
    return null;
  }

  async function selectDownloadFolder() {
    const picker = getDirectoryPicker();
    if (!picker) {
      state.status = "Download folder picker is not available in this browser. Normal browser downloads will be used.";
      render();
      return;
    }

    try {
      const handle = await picker({
        id: "suno-batch-export",
        mode: "readwrite"
      });
      state.downloadDirectoryHandle = handle;
      state.downloadDirectoryName = handle.name || "selected folder";
      state.folderPermissionStatus = "prompt";
      state.folderWriteTestOk = false;
      state.lastFolderError = "";
      const allowed = await ensureDirectoryPermission(handle);
      if (!allowed) {
        state.downloadDirectoryHandle = null;
        state.downloadDirectoryName = "";
        state.folderPermissionStatus = "denied";
        state.folderWriteTestOk = false;
        state.lastFolderError = "Permission denied.";
        state.status = "Download folder permission was denied. Normal browser downloads will be used.";
        render();
        return;
      }
      state.folderPermissionStatus = "granted";
      state.status = `Download folder selected: ${state.downloadDirectoryName}. Click Test folder to verify. Folder selection lasts only for this page session.`;
      render();
    } catch (error) {
      if (error && error.name === "AbortError") {
        state.status = "Download folder selection canceled.";
      } else {
        state.lastFolderError = messageFrom(error);
        state.folderWriteTestOk = false;
        state.status = `Download folder selection failed: ${messageFrom(error)}`;
        console.error("[FAILED]", "select-download-folder", error);
      }
      render();
    }
  }

  async function ensureDirectoryPermission(handle) {
    if (!handle) {
      return false;
    }
    const options = { mode: "readwrite" };
    const updateStatus = (status) => {
      if (handle === state.downloadDirectoryHandle) {
        state.folderPermissionStatus = status;
      }
    };
    try {
      if (typeof handle.queryPermission === "function") {
        const current = await handle.queryPermission(options);
        updateStatus(current || "unknown");
        if (current === "granted") {
          return true;
        }
        if (current === "denied") {
          return false;
        }
      }
      if (typeof handle.requestPermission === "function") {
        const next = await handle.requestPermission(options);
        updateStatus(next || "unknown");
        return next === "granted";
      }
      updateStatus("granted");
      return true;
    } catch (error) {
      if (handle === state.downloadDirectoryHandle) {
        state.lastFolderError = messageFrom(error);
        state.folderWriteTestOk = false;
      }
      return false;
    }
  }

  async function testDownloadFolder() {
    if (!state.downloadDirectoryHandle) {
      state.status = "Select a download folder first.";
      render();
      return;
    }

    try {
      const stamp = new Date().toISOString();
      const blob = new Blob([`Suno Batch Export folder test ${stamp}\n`], { type: "text/plain;charset=utf-8" });
      const savedPath = await writeBlobToSelectedFolder(blob, "suno-batch-export-folder-test.txt");
      state.folderWriteTestOk = true;
      state.folderPermissionStatus = "granted";
      state.lastFolderError = "";
      state.status = `Folder test succeeded: ${state.downloadDirectoryName || "selected folder"}.`;
      console.info("[DOWNLOADED]", savedPath);
    } catch (error) {
      state.folderWriteTestOk = false;
      state.lastFolderError = messageFrom(error);
      state.status = `Folder test failed: ${state.lastFolderError}`;
      console.error("[FAILED]", "test-download-folder", error);
    }
    render();
  }

  async function startBatch({ dryRun }) {
    if (state.running) {
      return;
    }
    if (!isAllowedPage()) {
      state.status = "Open a Suno Library or Workspace page before exporting.";
      render();
      return;
    }

    const selected = state.songs.filter((song) => state.selectedKeys.has(song.key));
    if (!selected.length) {
      state.status = "Select at least one detected song first.";
      render();
      return;
    }
    const action = dryRun ? "dry-run" : "export";
    const confirmed = window.confirm(
      `${SCRIPT_NAME}: ${action} ${selected.length} owned visible Suno song(s)?\n\n` +
      "This script only uses visible page data, authorized media URLs, and visible official download buttons. " +
      "It will not bypass access controls."
    );
    if (!confirmed) {
      return;
    }

    state.running = true;
    state.cancelRequested = false;
    state.dryRun = dryRun;
    state.failedKeys.clear();
    state.results = [];
    state.status = dryRun ? "Dry run started." : "Export started.";
    render();

    await loadDownloadedDatabase();
    const zip = !dryRun && state.exportMode === "zip" ? new JSZip() : null;
    const zipTracksToMark = [];
    const usedNames = new Map();

    for (let index = 0; index < selected.length; index += 1) {
      if (state.cancelRequested) {
        state.status = `Canceled after ${index} of ${selected.length} song(s).`;
        break;
      }

      const song = selected[index];
      state.status = `${dryRun ? "Checking" : "Exporting"} ${index + 1}/${selected.length}: ${song.title}`;
      render();

      try {
        const result = await exportSong(song, { dryRun, zip, usedNames, zipTracksToMark });
        state.results.push(result);
        if (result.status === "failed") {
          state.failedKeys.add(song.key);
        }
      } catch (error) {
        inProgressTrackKeys.delete(buildTrackKey(song));
        state.failedKeys.add(song.key);
        state.results.push({
          key: song.key,
          title: song.title,
          status: "failed",
          warnings: [],
          error: error instanceof Error ? error.message : String(error)
        });
      }

      render();
      if (index < selected.length - 1) {
        await delay(Math.max(MIN_THROTTLE_MS, state.throttleMs));
      }
    }

    if (zip && !state.cancelRequested) {
      const zipHasFiles = Boolean(zip.files && Object.keys(zip.files).length);
      if (zipHasFiles) {
        const blob = await zip.generateAsync({ type: "blob" });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const zipFileName = `suno-batch-export-${stamp}.zip`;
        try {
          const zipSave = await saveExportBlob(blob, zipFileName, zipFileName, { confirmedDownload: true });
          if (zipSave.confirmed) {
            for (const track of zipTracksToMark) {
              await markTrackDownloaded(track);
            }
          } else {
            console.warn("[FAILED]", "zip-download", "ZIP download used browser fallback; duplicate history was not updated because completion could not be confirmed.");
          }
        } catch (error) {
          console.error("[FAILED]", "zip-download", messageFrom(error));
          zipTracksToMark.forEach((track) => inProgressTrackKeys.delete(buildTrackKey(track)));
          state.results.push({
            key: "zip-download",
            title: "ZIP download",
            status: "failed",
            warnings: [],
            error: messageFrom(error)
          });
        } finally {
          zipTracksToMark.forEach((track) => inProgressTrackKeys.delete(buildTrackKey(track)));
        }
      }
    } else if (zip && state.cancelRequested) {
      zipTracksToMark.forEach((track) => inProgressTrackKeys.delete(buildTrackKey(track)));
    }

    const successCount = state.results.filter((result) => result.status === "success").length;
    const failedCount = state.results.filter((result) => result.status === "failed").length;
    const skippedCount = state.results.filter((result) => result.status === "skipped").length;
    state.status = dryRun
      ? `Dry run complete. ${selected.length} song(s) checked.`
      : `Export complete. ${successCount} succeeded, ${skippedCount} skipped, ${failedCount} failed.`;
    state.running = false;
    render();
  }

  function resolveSongCard(song) {
    const mapped = song && elementByKey.get(song.key);
    if (mapped && mapped.isConnected) {
      return mapped;
    }
    if (song && song.card && song.card.isConnected) {
      return song.card;
    }
    return mapped || (song && song.card) || null;
  }

  async function exportSong(song, context) {
    const warnings = [];
    const sidecars = [];
    const card = resolveSongCard(song);
    const baseName = uniqueBaseName(song.baseName, context.usedNames);
    const metadata = buildMetadata(song, baseName);
    let zipGuardKey = "";
    let mp3FailureReason = "";
    const cardAvailable = Boolean(card && card.isConnected !== false);
    const audioUrlVisibleBeforeRefresh = Boolean(song.audioUrl);
    const visibleOfficialDownloadAvailableBeforeHover = Boolean(card && findOfficialDownloadButton(card));
    const optionsButtonAvailableBeforeHover = Boolean(card && findOfficialOptionsButton(card));
    let mediaInfo = refreshSongMediaInfo(song, card);
    const hoverRevealAttempted = Boolean(card && state.includeMp3 && (context.dryRun || (state.exportMode === "individual" && !mediaInfo.safeMp3UrlAvailable)));
    let hoverReveal = { ok: false, error: "" };
    if (hoverRevealAttempted) {
      hoverReveal = await revealCardActions(card);
      mediaInfo = refreshSongMediaInfo(song, card);
    }
    const safeMp3UrlAvailable = mediaInfo.safeMp3UrlAvailable;
    const visibleOfficialDownloadAvailableAfterHover = Boolean(card && findOfficialDownloadButton(card));
    const optionsButtonAvailableAfterHover = Boolean(card && findOfficialOptionsButton(card));
    const individualButtonFallbackPossible = Boolean(visibleOfficialDownloadAvailableAfterHover || optionsButtonAvailableAfterHover);
    const zipNoDirectMessage = "ZIP mode needs a direct authorized MP3 URL. Suno's browser download button can only be used in Individual mode.";
    const individualNoControlMessage = "No direct authorized MP3 URL was visible, and no visible Suno Download/Audio/MP3 control was found after hover/menu reveal. Open the song card, make sure the Download menu is visible, then retry Individual mode.";
    const duplicateKey = buildTrackKey(song);
    metadata.cardAvailable = cardAvailable;
    metadata.audioUrlVisibleBeforeRefresh = audioUrlVisibleBeforeRefresh;
    metadata.audioUrlVisibleAfterRefresh = mediaInfo.audioUrlVisibleAfterRefresh;
    metadata.hydratedAudioUrlAvailable = mediaInfo.hydratedAudioUrlAvailable;
    metadata.hoverRevealAttempted = hoverRevealAttempted;
    metadata.hoverRevealOk = hoverRevealAttempted ? hoverReveal.ok : false;
    metadata.hoverRevealError = hoverReveal.error || "";
    metadata.audioUrlAllowed = safeMp3UrlAvailable;
    metadata.safeMp3UrlAvailable = safeMp3UrlAvailable;
    metadata.visibleOfficialDownloadAvailable = visibleOfficialDownloadAvailableAfterHover;
    metadata.visibleOfficialDownloadAvailableBeforeHover = visibleOfficialDownloadAvailableBeforeHover;
    metadata.visibleOfficialDownloadAvailableAfterHover = visibleOfficialDownloadAvailableAfterHover;
    metadata.optionsButtonAvailableBeforeHover = optionsButtonAvailableBeforeHover;
    metadata.optionsButtonAvailableAfterHover = optionsButtonAvailableAfterHover;
    metadata.individualButtonFallbackPossible = individualButtonFallbackPossible;
    metadata.zipMp3Possible = safeMp3UrlAvailable;
    metadata.recommendedMode = safeMp3UrlAvailable ? "zip" : (individualButtonFallbackPossible ? "individual" : "manual");

    console.info("[MP3 DIAGNOSTIC]", trackLabel(song), {
      cardAvailable,
      audioUrlVisibleBeforeRefresh,
      audioUrlVisibleAfterRefresh: mediaInfo.audioUrlVisibleAfterRefresh,
      hydratedAudioUrlAvailable: mediaInfo.hydratedAudioUrlAvailable,
      hoverRevealAttempted,
      hoverRevealOk: metadata.hoverRevealOk,
      hoverRevealError: metadata.hoverRevealError,
      audioUrlAllowed: safeMp3UrlAvailable,
      visibleOfficialDownloadAvailableBeforeHover,
      visibleOfficialDownloadAvailableAfterHover,
      optionsButtonAvailableBeforeHover,
      optionsButtonAvailableAfterHover,
      individualButtonFallbackPossible,
      exportMode: state.exportMode
    });

    if (context.dryRun) {
      metadata.duplicateKey = duplicateKey;
      metadata.alreadyDownloaded = await isDuplicateTrack(song);
      if (state.includeMp3 && state.exportMode === "zip" && !safeMp3UrlAvailable) {
        warnings.push(zipNoDirectMessage);
      }
      return {
        key: song.key,
        title: song.title,
        status: "success",
        warnings,
        metadata
      };
    }

    if (state.includeMp3) {
      if (await isDuplicateTrack(song)) {
        console.info("[SKIP DUPLICATE]", duplicateKey, trackLabel(song));
        return {
          key: song.key,
          title: song.title,
          status: "skipped",
          warnings: [],
          error: "Already downloaded.",
          metadata
        };
      }
      if (state.exportMode === "zip") {
        if (inProgressTrackKeys.has(duplicateKey)) {
          console.info("[SKIP IN PROGRESS]", duplicateKey, trackLabel(song));
          return {
            key: song.key,
            title: song.title,
            status: "skipped",
            warnings: [],
            error: "Already queued in this batch.",
            metadata
          };
        }
        inProgressTrackKeys.add(duplicateKey);
        console.info("[DOWNLOADING]", duplicateKey, `${trackLabel(song)} queued for ZIP`);
        zipGuardKey = duplicateKey;
      }
    }

    let cover = null;
    if (state.includeCover && song.coverUrl) {
      try {
        cover = await fetchBinary(song.coverUrl, { expected: "image" });
        const coverExt = extensionForMime(cover.mimeType, ".jpg");
        metadata.coverFileName = `${baseName}${coverExt}`;
        sidecars.push({ blob: cover.blob, fileName: metadata.coverFileName, path: `covers/${metadata.coverFileName}` });
      } catch (error) {
        warnings.push(`Cover unavailable: ${messageFrom(error)}`);
      }
    } else if (state.includeCover) {
      warnings.push("Cover unavailable: no visible cover URL.");
    }

    if (state.includeLyrics) {
      const lyricsText = String(song.lyrics || "").trim();
      if (lyricsText || state.saveEmptyLyrics) {
        const blob = new Blob([lyricsText], { type: "text/plain;charset=utf-8" });
        metadata.lyricsFileName = `${baseName}.txt`;
        sidecars.push({ blob, fileName: metadata.lyricsFileName, path: `lyrics/${metadata.lyricsFileName}` });
        if (!lyricsText) {
          warnings.push("Lyrics unavailable: no visible lyrics text.");
        }
      } else {
        warnings.push("Lyrics unavailable: no visible lyrics text.");
        warnings.push("Lyrics TXT skipped because no visible lyrics were found.");
      }
    }

    let mp3Exported = false;
    if (state.includeMp3) {
      if (safeMp3UrlAvailable) {
        try {
          const mp3 = await fetchBinary(song.audioUrl, { expected: "audio" });
          assertLooksLikeMp3(mp3.arrayBuffer);
          let mp3Buffer = mp3.arrayBuffer;
          if (state.embedId3) {
            mp3Buffer = writeId3v24(mp3Buffer, metadata, cover);
          }
          const mp3Blob = new Blob([mp3Buffer], { type: "audio/mpeg" });
          metadata.mp3FileName = `${baseName}.mp3`;
          if (state.exportMode === "zip") {
            addSidecar(context.zip, mp3Blob, `mp3/${metadata.mp3FileName}`);
            mp3Exported = true;
            console.info("[DOWNLOADED]", duplicateKey, `MP3 added to ZIP: ${metadata.mp3FileName}`);
          } else {
            const safeDownload = await downloadTrackSafely(
              { ...song, suggestedFileName: metadata.mp3FileName, downloadUrl: song.audioUrl },
              { blob: mp3Blob, fileName: metadata.mp3FileName }
            );
            mp3Exported = safeDownload.status === "downloaded" || safeDownload.status === "downloaded-unconfirmed";
            if (safeDownload.status === "downloaded-unconfirmed") {
              warnings.push("MP3 download was started with browser fallback, but completion could not be confirmed. Duplicate history was not updated for this track.");
            } else if (!mp3Exported) {
              mp3FailureReason = `MP3 download skipped or failed: ${safeDownload.error || safeDownload.status}`;
              warnings.push(`MP3 download skipped or failed: ${safeDownload.error || safeDownload.status}`);
            }
          }
        } catch (error) {
          if (state.exportMode === "zip") {
            mp3FailureReason = `ZIP mode could not add MP3 from the authorized audio URL: ${messageFrom(error)}. Switch Mode to Individual for this track or use Suno manual download.`;
            warnings.push(mp3FailureReason);
            console.error("[FAILED]", duplicateKey, mp3FailureReason);
          } else {
            warnings.push(`Direct MP3 fetch/embed failed: ${messageFrom(error)}. Trying visible Suno download button if available.`);
          }
        }
      } else if (state.exportMode === "zip") {
        mp3FailureReason = zipNoDirectMessage;
        warnings.push(mp3FailureReason);
        console.error("[FAILED]", duplicateKey, mp3FailureReason);
      }

      if (!mp3Exported && !mp3FailureReason && state.exportMode === "individual") {
        const officialDownload = await clickOfficialDownloadFlow(card, song);
        if (officialDownload.clicked) {
          mp3Exported = true;
          metadata.officialDownloadMethod = officialDownload.method || "";
          warnings.push("MP3 was handled by Suno/browser and will use the browser download location, not the selected script folder.");
          warnings.push("Duplicate history was not updated for this track because the official Suno/browser download cannot be confirmed by GM_download.");
        } else {
          metadata.officialDownloadError = officialDownload.error || "";
          mp3FailureReason = safeMp3UrlAvailable
            ? "Direct authorized MP3 URL failed, and no visible Suno Download/Audio/MP3 control was found after hover/menu reveal. Open the song card, make sure the Download menu is visible, then retry Individual mode."
            : individualNoControlMessage;
          warnings.push(mp3FailureReason);
          console.error("[FAILED]", duplicateKey, mp3FailureReason);
        }
      } else if (!mp3Exported && !mp3FailureReason) {
        mp3FailureReason = state.exportMode === "zip" ? zipNoDirectMessage : individualNoControlMessage;
        warnings.push(mp3FailureReason);
        console.error("[FAILED]", duplicateKey, mp3FailureReason);
      }
    }

    const sidecarsAllowed = !state.includeMp3 || mp3Exported || state.allowSidecarsWhenMp3Fails;
    if (!sidecarsAllowed) {
      const sidecarMessage = "MP3 was not exported, so sidecars were not saved. Switch to Individual mode or use Suno manual download.";
      warnings.push(sidecarMessage);
      mp3FailureReason = mp3FailureReason ? `${mp3FailureReason} ${sidecarMessage}` : sidecarMessage;
    }

    if (sidecarsAllowed && state.includeJson) {
      metadata.warnings = warnings;
      metadata.mp3Exported = mp3Exported;
      metadata.duplicateKey = duplicateKey;
      metadata.metadataFileName = `${baseName}.json`;
      const blob = new Blob([`${JSON.stringify(metadata, null, 2)}\n`], { type: "application/json;charset=utf-8" });
      sidecars.push({ blob, fileName: metadata.metadataFileName, path: `metadata/${metadata.metadataFileName}` });
    } else {
      metadata.warnings = warnings;
      metadata.mp3Exported = mp3Exported;
      metadata.duplicateKey = duplicateKey;
    }

    if (sidecarsAllowed) {
      for (const sidecar of sidecars) {
        addSidecar(context.zip, sidecar.blob, sidecar.path);
        if (state.exportMode === "individual") {
          await saveExportBlob(sidecar.blob, sidecar.fileName, sidecar.path);
        }
      }
    }

    const hardFailure = state.includeMp3 && !mp3Exported;
    if (zipGuardKey && hardFailure) {
      console.error("[FAILED]", zipGuardKey, trackLabel(song), "MP3 was not added to ZIP.");
      inProgressTrackKeys.delete(zipGuardKey);
    } else if (zipGuardKey && mp3Exported) {
      context.zipTracksToMark.push(song);
    }
    return {
      key: song.key,
      title: song.title,
      status: hardFailure ? "failed" : "success",
      warnings,
      error: hardFailure ? mp3FailureReason || "MP3 was not exported. Switch Mode to Individual, open the song details, or use Suno manual download and run the local post-processor." : "",
      metadata
    };
  }

  function buildMetadata(song, baseName) {
    const fields = {
      "Suno URL": song.sunoUrl || song.url || "",
      "Suno ID": song.id || "",
      "Suno Prompt": song.prompt || "",
      "Suno Style": song.style || "",
      "Suno Tags": Array.isArray(song.tags) ? song.tags.join(", ") : "",
      "Suno Model": song.model || "",
      "Suno Generation Date": song.creationDate || "",
      "Suno Duration": song.duration || "",
      "Suno Source Page": song.sourcePage || location.href,
      "Suno Exported At": new Date().toISOString()
    };

    return {
      schema: "suno-batch-exporter.metadata.v1",
      scriptVersion: VERSION,
      id: song.id || "",
      title: song.title || "Untitled Suno song",
      artist: song.artist || "SunoUser",
      lyrics: song.lyrics || "",
      prompt: song.prompt || "",
      style: song.style || "",
      tags: song.tags || [],
      model: song.model || "",
      sunoUrl: song.sunoUrl || song.url || "",
      creationDate: song.creationDate || "",
      duration: song.duration || "",
      coverUrl: song.coverUrl || "",
      audioUrlWasVisible: Boolean(song.audioUrl),
      sourcePage: song.sourcePage || location.href,
      baseName,
      suggestedFileName: `${baseName}.mp3`,
      txxx: fields
    };
  }

  function addSidecar(zip, blob, path) {
    if (zip) {
      zip.file(path, blob);
    }
  }

  // Fetch only Suno-owned or current-origin URLs. This prevents the script from
  // becoming a general-purpose scraper.
  async function fetchBinary(url, options) {
    if (!isAllowedSunoUrl(url)) {
      throw new Error(`Blocked non-Suno URL: ${url}`);
    }

    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const mimeType = blob.type || response.headers.get("content-type") || "";
      validateMime(mimeType, options.expected);
      return {
        blob,
        mimeType,
        arrayBuffer: await blob.arrayBuffer()
      };
    } catch (fetchError) {
      return gmFetchBinary(url, options, fetchError);
    }
  }

  function gmFetchBinary(url, options, originalError) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(originalError);
        return;
      }

      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        anonymous: false,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          const headers = parseHeaders(response.responseHeaders || "");
          const mimeType = headers["content-type"] || "";
          try {
            validateMime(mimeType, options.expected);
          } catch (error) {
            reject(error);
            return;
          }
          const blob = new Blob([response.response], { type: mimeType || defaultMime(options.expected) });
          resolve({ blob, mimeType: blob.type, arrayBuffer: response.response });
        },
        onerror() {
          reject(originalError || new Error("Network request failed."));
        },
        ontimeout() {
          reject(new Error("Network request timed out."));
        }
      });
    });
  }

  function validateMime(mimeType, expected) {
    if (!mimeType) {
      return;
    }
    const clean = mimeType.split(";")[0].trim().toLowerCase();
    if (expected === "audio" && clean && !["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(clean)) {
      throw new Error(`Unexpected audio content type: ${mimeType}`);
    }
    if (expected === "image" && clean && !clean.startsWith("image/")) {
      throw new Error(`Unexpected image content type: ${mimeType}`);
    }
  }

  function defaultMime(expected) {
    return expected === "audio" ? "audio/mpeg" : "application/octet-stream";
  }

  function assertLooksLikeMp3(buffer) {
    const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16));
    const hasId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const hasFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    if (!hasId3 && !hasFrameSync) {
      throw new Error("Downloaded audio does not look like an MP3 file.");
    }
  }

  // Minimal ID3v2.4 writer for TIT2, TPE1, USLT, APIC, and TXXX frames.
  // It removes any leading ID3v2 tag before adding the new tag.
  function writeId3v24(mp3Buffer, metadata, cover) {
    const frames = [];
    frames.push(textFrame("TIT2", metadata.title));
    frames.push(textFrame("TPE1", metadata.artist));
    if (metadata.lyrics) {
      frames.push(usltFrame(metadata.lyrics));
    }
    if (cover && cover.arrayBuffer) {
      frames.push(apicFrame(cover.mimeType || "image/jpeg", cover.arrayBuffer));
    }
    Object.entries(metadata.txxx || {}).forEach(([description, value]) => {
      if (value) {
        frames.push(txxxFrame(description, String(value)));
      }
    });

    const frameBytes = concatUint8(frames.filter(Boolean));
    const header = new Uint8Array(10);
    header.set(ascii("ID3"), 0);
    header[3] = 4;
    header[4] = 0;
    header[5] = 0;
    header.set(syncSafe(frameBytes.length), 6);

    return concatArrayBuffers([header.buffer, frameBytes.buffer, stripLeadingId3(mp3Buffer)]);
  }

  function textFrame(id, value) {
    if (!value) {
      return null;
    }
    return makeFrame(id, concatUint8([new Uint8Array([0x03]), utf8(String(value))]));
  }

  function usltFrame(lyrics) {
    const parts = [
      new Uint8Array([0x03]),
      ascii("eng"),
      new Uint8Array([0x00]),
      utf8(String(lyrics))
    ];
    return makeFrame("USLT", concatUint8(parts));
  }

  function txxxFrame(description, value) {
    const parts = [
      new Uint8Array([0x03]),
      utf8(description),
      new Uint8Array([0x00]),
      utf8(value)
    ];
    return makeFrame("TXXX", concatUint8(parts));
  }

  function apicFrame(mimeType, imageBuffer) {
    const parts = [
      new Uint8Array([0x03]),
      ascii(mimeType.split(";")[0] || "image/jpeg"),
      new Uint8Array([0x00, 0x03, 0x00]),
      new Uint8Array(imageBuffer)
    ];
    return makeFrame("APIC", concatUint8(parts));
  }

  function makeFrame(id, body) {
    const frame = new Uint8Array(10 + body.length);
    frame.set(ascii(id), 0);
    frame.set(syncSafe(body.length), 4);
    frame[8] = 0;
    frame[9] = 0;
    frame.set(body, 10);
    return frame;
  }

  function stripLeadingId3(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
      return buffer;
    }
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const hasFooter = (bytes[5] & 0x10) !== 0;
    const offset = 10 + size + (hasFooter ? 10 : 0);
    return buffer.slice(offset);
  }

  function syncSafe(size) {
    return new Uint8Array([
      (size >> 21) & 0x7f,
      (size >> 14) & 0x7f,
      (size >> 7) & 0x7f,
      size & 0x7f
    ]);
  }

  function concatUint8(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  function concatArrayBuffers(buffers) {
    return concatUint8(buffers.map((buffer) => new Uint8Array(buffer))).buffer;
  }

  function utf8(value) {
    return new TextEncoder().encode(value);
  }

  function ascii(value) {
    return Uint8Array.from(String(value), (char) => char.charCodeAt(0) & 0x7f);
  }

  function findSongUrl(card) {
    const links = [];
    if (card.matches && card.matches("a[href]")) {
      links.push(card);
    }
    links.push(...Array.from(card.querySelectorAll("a[href]")));
    const match = links.find((link) => SONG_LINK_RE.test(link.href));
    return match ? new URL(match.getAttribute("href"), location.href).href : "";
  }

  function findSongId(card, url) {
    const fromUrl = (url || "").match(SONG_LINK_RE);
    if (fromUrl) {
      return fromUrl[1];
    }
    const text = `${card.id || ""} ${card.getAttribute("data-id") || ""} ${card.getAttribute("data-song-id") || ""} ${normalizedText(card)}`;
    const uuid = text.match(UUID_RE);
    if (uuid) {
      return uuid[0];
    }
    const token = text.match(/\b[a-z0-9]{10,}\b/i);
    return token ? token[0] : "";
  }

  function findTitle(card) {
    const selectors = [
      "[data-testid*='title' i]",
      "[aria-label*='title' i]",
      "h1",
      "h2",
      "h3",
      "strong",
      "a[href*='/song']",
      "a[href*='/track']"
    ];
    for (const selector of selectors) {
      const node = Array.from(card.querySelectorAll(selector)).find((candidate) => {
        const text = normalizedText(candidate);
        return text && text.length <= 120 && !/download|play|pause|share|more/i.test(text);
      });
      if (node) {
        return cleanTitle(normalizedText(node));
      }
    }
    const lines = normalizedText(card).split(/\s{2,}|\n/).map(cleanTitle).filter(Boolean);
    return lines.find((line) => line.length >= 2 && line.length <= 100 && !/download|play|pause|create|workspace/i.test(line)) || "";
  }

  function findArtist(card) {
    return findLabeledValue(card, ["artist", "creator", "user", "by"]);
  }

  function findCurrentUser() {
    const candidates = [
      "[data-testid*='user' i]",
      "[aria-label*='profile' i]",
      "[aria-label*='account' i]"
    ];
    for (const selector of candidates) {
      const node = document.querySelector(selector);
      const text = node ? cleanTitle(normalizedText(node)) : "";
      if (text && text.length <= 60) {
        return text;
      }
    }
    return "";
  }

  function findLyrics(card) {
    const explicit = findLabeledValue(card, ["lyrics", "lyric"]);
    if (explicit && explicit.length > 20) {
      return explicit;
    }
    const blocks = Array.from(card.querySelectorAll("p, pre, [data-testid*='lyric' i], [class*='lyric' i]"));
    const block = blocks
      .map((node) => node.innerText || node.textContent || "")
      .map((text) => text.trim())
      .find((text) => text.length > 40 && /[\n\r]/.test(text));
    return block || "";
  }

  function findLabeledValue(card, labels) {
    const text = normalizedText(card);
    for (const label of labels) {
      const re = new RegExp(`${escapeRegExp(label)}\\s*[:\\-]\\s*([^\\n]{1,500})`, "i");
      const match = text.match(re);
      if (match) {
        return cleanTitle(match[1]);
      }
    }
    return "";
  }

  function findTags(card) {
    const tagNodes = Array.from(card.querySelectorAll("[data-testid*='tag' i], [class*='tag' i], [aria-label*='tag' i]"));
    const tags = tagNodes
      .map((node) => cleanTitle(normalizedText(node)))
      .filter((text) => text && text.length <= 40);
    if (tags.length) {
      return Array.from(new Set(tags));
    }
    const style = findLabeledValue(card, ["tags"]);
    return style ? style.split(/[,|]/).map(cleanTitle).filter(Boolean) : [];
  }

  function findDuration(card) {
    const match = normalizedText(card).match(/\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/);
    return match ? match[0] : "";
  }

  function findCreationDate(card) {
    const time = card.querySelector("time[datetime]");
    if (time) {
      return time.getAttribute("datetime") || normalizedText(time);
    }
    const text = normalizedText(card);
    const match = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i)
      || text.match(/\b\d{4}-\d{2}-\d{2}\b/);
    return match ? match[0] : "";
  }

  function findCoverUrl(card) {
    const image = Array.from(card.querySelectorAll("img[src], img[srcset]")).find((img) => {
      const text = `${img.alt || ""} ${img.getAttribute("aria-label") || ""} ${img.src || ""}`.toLowerCase();
      return !/avatar|profile|icon|logo/.test(text);
    });
    if (!image) {
      return "";
    }
    const raw = image.currentSrc || image.src || firstSrcSetUrl(image.getAttribute("srcset") || "");
    return raw ? new URL(raw, location.href).href : "";
  }

  function findAudioUrl(card) {
    const candidates = [];
    if (card.matches && card.matches("audio[src], audio source[src], source[src], a[href]")) {
      const rawSelf = card.getAttribute("src") || card.getAttribute("href") || "";
      if (rawSelf) {
        candidates.push(rawSelf);
      }
    }
    const media = card.querySelector("audio[src], audio source[src], source[type='audio/mpeg'][src]");
    if (media && media.getAttribute("src")) {
      candidates.push(media.getAttribute("src"));
    }
    const links = Array.from(card.querySelectorAll("a[href]"));
    links.forEach((link) => candidates.push(link.getAttribute("href") || link.href));
    return firstUsableAudioUrl(...candidates);
  }

  function refreshSongMediaInfo(song, card) {
    const audioUrlBefore = song.audioUrl || "";
    const cardAudioUrl = card ? findAudioUrl(card) : "";
    const hydratedAudioUrl = findHydratedAudioUrlForSong(song, card);
    const audioUrlAfter = firstUsableAudioUrl(cardAudioUrl, hydratedAudioUrl, audioUrlBefore);
    if (audioUrlAfter) {
      song.audioUrl = audioUrlAfter;
      song.audio_url = audioUrlAfter;
      song.downloadUrl = song.downloadUrl || audioUrlAfter;
    }
    return {
      audioUrlBefore,
      cardAudioUrl,
      hydratedAudioUrl,
      hydratedAudioUrlAvailable: Boolean(hydratedAudioUrl),
      audioUrlAfter,
      audioUrlVisibleAfterRefresh: Boolean(audioUrlAfter),
      safeMp3UrlAvailable: Boolean(audioUrlAfter)
    };
  }

  function findHydratedAudioUrlForSong(song, card) {
    const tokens = hydrationMatchTokens(song, card);
    if (!tokens.length) {
      return "";
    }

    const fields = [
      "audio_url",
      "audioUrl",
      "download_url",
      "downloadUrl",
      "stream_audio_url",
      "streamAudioUrl",
      "playable_url",
      "playableUrl"
    ].join("|");
    const fieldRe = new RegExp(`["']?(?:${fields})["']?\\s*[:=]\\s*["']([^"']+)["']`, "gi");

    for (const source of hydratedSearchSources(card)) {
      fieldRe.lastIndex = 0;
      let match = fieldRe.exec(source);
      while (match) {
        const context = source.slice(Math.max(0, match.index - 2500), Math.min(source.length, match.index + 2500));
        const url = decodeHydratedUrl(match[1]);
        if (contextMatchesHydrationTokens(context, tokens) && isUsableAudioUrl(url)) {
          return url;
        }
        match = fieldRe.exec(source);
      }
    }
    return "";
  }

  function hydratedSearchSources(card) {
    const sources = [];
    if (card) {
      sources.push(card.outerHTML || normalizedText(card));
    }
    document.querySelectorAll("script:not([src]), script[type='application/json'], script[type='application/ld+json'], script#__NEXT_DATA__").forEach((node) => {
      const text = node.textContent || "";
      if (text && text.length < 3000000) {
        sources.push(text);
      }
    });
    return sources;
  }

  function hydrationMatchTokens(song, card) {
    const values = new Set([
      song && song.id,
      song && song.songId,
      song && song.clip_id,
      song && song.fallbackId
    ]);
    const urls = [song && song.url, song && song.sunoUrl, card ? findSongUrl(card) : ""].filter(Boolean);
    urls.forEach((url) => {
      const match = String(url).match(SONG_LINK_RE);
      if (match) {
        values.add(match[1]);
      }
    });
    const combined = `${urls.join(" ")} ${card ? normalizedText(card) : ""}`;
    const uuid = combined.match(UUID_RE);
    if (uuid) {
      values.add(uuid[0]);
    }
    const title = cleanTitle(song && song.title);
    if (title && title.length >= 4) {
      values.add(title);
    }
    return Array.from(values)
      .map((value) => normalizeHydrationSearchText(value))
      .filter((value) => value.length >= 4);
  }

  function contextMatchesHydrationTokens(context, tokens) {
    const searchable = normalizeHydrationSearchText(context);
    return tokens.some((token) => searchable.includes(token));
  }

  function normalizeHydrationSearchText(value) {
    return String(value || "")
      .replace(/\\u002f/gi, "/")
      .replace(/\\u003a/gi, ":")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeHydratedUrl(value) {
    const decoded = String(value || "")
      .replace(/\\u002f/gi, "/")
      .replace(/\\u003a/gi, ":")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&")
      .trim();
    try {
      return new URL(decoded, location.href).href;
    } catch {
      return "";
    }
  }

  function firstUsableAudioUrl(...candidates) {
    for (const candidate of candidates) {
      const url = toAbsoluteUrl(candidate);
      if (url && isUsableAudioUrl(url)) {
        return url;
      }
    }
    return "";
  }

  function toAbsoluteUrl(rawUrl) {
    if (!rawUrl) {
      return "";
    }
    try {
      return new URL(String(rawUrl), location.href).href;
    } catch {
      return "";
    }
  }

  function isUsableAudioUrl(rawUrl) {
    return isAllowedSunoUrl(rawUrl) && isLikelyAudioUrl(rawUrl);
  }

  function isLikelyAudioUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl), location.href);
    } catch {
      return false;
    }
    const href = url.href.toLowerCase();
    const host = url.hostname.toLowerCase();
    return MP3_RE.test(href)
      || /\b(audio|mp3|download|stream|playable)\b/i.test(href)
      || ((host.includes("cdn") || href.includes("/media/")) && isSunoHost(host));
  }

  function findOfficialDownloadButton(card) {
    const controls = Array.from(card.querySelectorAll("button, a[href], [role='button'], [role='menuitem']"));
    return controls.find((control) => {
      if (!isVisible(control) || looksLikeWrongOfficialControl(control)) {
        return false;
      }
      const text = controlSearchText(control).toLowerCase();
      return /\b(download|audio|mp3)\b/.test(text);
    }) || null;
  }

  function findOfficialOptionsButton(card) {
    const controls = Array.from(card.querySelectorAll("button, a[href], [role='button']"));
    return controls.find((control) => {
      if (!isVisible(control) || looksLikeWrongOfficialControl(control)) {
        return false;
      }
      const text = controlSearchText(control).toLowerCase();
      const ariaHasPopup = String(control.getAttribute("aria-haspopup") || "").toLowerCase();
      const ariaExpanded = control.hasAttribute("aria-expanded");
      const ariaControls = control.hasAttribute("aria-controls");
      return /\b(more|options|menu|actions|ellipsis)\b/.test(text)
        || text.includes("...")
        || text.includes("\u22ef")
        || text.includes("\u2022\u2022\u2022")
        || /\b(more|options|menu|actions|overflow)\b/.test(control.getAttribute("data-testid") || "")
        || ariaExpanded
        || ariaControls
        || ariaHasPopup === "menu";
    }) || null;
  }

  async function clickOfficialDownloadFlow(card, track) {
    try {
      if (!card) {
        return { clicked: false, error: "No visible song card is available for the official Suno download flow." };
      }

      const key = buildTrackKey(track);
      await revealCardActions(card);

      const directButton = findOfficialDownloadButton(card);
      if (directButton) {
        console.info("[DOWNLOADING]", key, `${trackLabel(track)} via visible official Suno download button`);
        const directClick = clickVisibleControl(directButton);
        if (!directClick.ok) {
          return { clicked: false, error: directClick.error };
        }
        await delay(450);
        const audioChoice = findVisibleActionControlInRoots(getVisiblePopupRoots(directButton), [/\b(audio|mp3)\b/i], { exclude: new Set([directButton]) });
        if (audioChoice) {
          const audioClick = clickVisibleControl(audioChoice);
          if (!audioClick.ok) {
            return { clicked: false, error: audioClick.error };
          }
        }
        return { clicked: true, method: "direct", message: "Visible official Suno download button was clicked." };
      }

      const optionsButton = findOfficialOptionsButton(card);
      if (!optionsButton) {
        return { clicked: false, error: "No visible official Suno download or options button was found." };
      }

      console.info("[DOWNLOADING]", key, `${trackLabel(track)} via visible Suno options menu`);
      const optionsClick = clickVisibleControl(optionsButton);
      if (!optionsClick.ok) {
        return { clicked: false, error: optionsClick.error };
      }
      await delay(550);

      const downloadItem = findVisibleActionControlInRoots(getVisiblePopupRoots(optionsButton), [/\bdownload\b/i], { exclude: new Set([optionsButton]) });
      if (!downloadItem) {
        return { clicked: false, error: "Visible options menu opened, but no Download item was found." };
      }

      const downloadClick = clickVisibleControl(downloadItem);
      if (!downloadClick.ok) {
        return { clicked: false, error: downloadClick.error };
      }
      await delay(550);

      const audioChoice = findVisibleActionControlInRoots(getVisiblePopupRoots(optionsButton), [/\b(audio|mp3)\b/i], { exclude: new Set([optionsButton, downloadItem]) });
      if (audioChoice) {
        const audioClick = clickVisibleControl(audioChoice);
        if (!audioClick.ok) {
          return { clicked: false, error: audioClick.error };
        }
        return { clicked: true, method: "options-audio", message: "Visible Suno Download > Audio/MP3 menu item was clicked." };
      }
      return { clicked: true, method: "options-download", message: "Visible Suno Download menu item was clicked." };
    } catch (error) {
      const message = messageFrom(error);
      console.warn("[OFFICIAL DOWNLOAD WARN]", message);
      return { clicked: false, error: message };
    }
  }

  async function revealCardActions(card) {
    if (!card) {
      return { ok: false, error: "No card to reveal." };
    }

    const warnings = [];
    try {
      if (typeof card.scrollIntoView === "function") {
        try {
          card.scrollIntoView({ block: "center", inline: "center" });
        } catch (error) {
          const message = messageFrom(error);
          warnings.push(`scrollIntoView failed: ${message}`);
          console.warn("[HOVER REVEAL WARN]", message);
        }
      }

      let coords = { clientX: 1, clientY: 1 };
      try {
        const rect = card.getBoundingClientRect();
        coords = {
          clientX: Math.max(1, Math.floor(rect.left + Math.min(rect.width / 2, 40))),
          clientY: Math.max(1, Math.floor(rect.top + Math.min(rect.height / 2, 40)))
        };
      } catch (error) {
        const message = messageFrom(error);
        warnings.push(`coordinate read failed: ${message}`);
        console.warn("[HOVER REVEAL WARN]", message);
      }

      const eventResults = ["pointerenter", "mouseenter", "mouseover", "mousemove"]
        .map((type) => safeDispatchHoverEvent(card, type, coords));
      eventResults
        .filter((result) => !result.ok && result.error)
        .forEach((result) => warnings.push(`${result.type} failed: ${result.error}`));
      await delay(500);
      return {
        ok: eventResults.some((result) => result.ok),
        error: warnings.join("; ")
      };
    } catch (error) {
      const message = messageFrom(error);
      console.warn("[HOVER REVEAL WARN]", message);
      return { ok: false, error: message };
    }
  }

  function safeDispatchHoverEvent(target, type, coords) {
    const clientX = coords && Number.isFinite(coords.clientX) ? coords.clientX : 1;
    const clientY = coords && Number.isFinite(coords.clientY) ? coords.clientY : 1;
    const pointerInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 0
    };
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      buttons: 0
    };
    const eventInit = { bubbles: true, cancelable: true, composed: true };

    if (type.startsWith("pointer") && typeof PointerEvent === "function") {
      try {
        target.dispatchEvent(new PointerEvent(type, pointerInit));
        return { ok: true, error: "", type };
      } catch (error) {
        console.warn("[HOVER REVEAL WARN]", type, "PointerEvent", messageFrom(error));
      }
    }

    try {
      target.dispatchEvent(new MouseEvent(type, mouseInit));
      return { ok: true, error: "", type };
    } catch (error) {
      console.warn("[HOVER REVEAL WARN]", type, "MouseEvent", messageFrom(error));
    }

    try {
      target.dispatchEvent(new Event(type, eventInit));
      return { ok: true, error: "", type };
    } catch (error) {
      const message = messageFrom(error);
      console.warn("[HOVER REVEAL WARN]", type, "Event", message);
      return { ok: false, error: message, type };
    }
  }

  function getVisiblePopupRoots(trigger) {
    const roots = [];
    const controlledId = trigger && trigger.getAttribute && trigger.getAttribute("aria-controls");
    if (controlledId) {
      const controlled = document.getElementById(controlledId);
      if (controlled && isVisible(controlled)) {
        roots.push(controlled);
      }
    }
    document.querySelectorAll([
      "[role='menu']",
      "[role='dialog']",
      "[data-radix-popper-content-wrapper]",
      "[data-radix-menu-content]",
      "[data-radix-popover-content]",
      "[data-state='open'][role]",
      "[data-headlessui-state]"
    ].join(", ")).forEach((root) => {
      if (isVisible(root) && !roots.includes(root)) {
        roots.push(root);
      }
    });
    roots.push(document);
    return roots;
  }

  function findVisibleActionControlInRoots(roots, patterns, options = {}) {
    for (const root of roots) {
      const match = findVisibleActionControl(root, patterns, options);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function findVisibleActionControl(root, patterns, options = {}) {
    const selector = root === document
      ? "[role='menuitem'], [role='option'], [data-radix-collection-item], [data-menu-item], [cmdk-item]"
      : "button, a[href], [role='button'], [role='menuitem'], [role='option'], [data-radix-collection-item], [data-menu-item], [cmdk-item]";
    const controls = Array.from(root.querySelectorAll(selector));
    const excluded = options.exclude || new Set();
    return controls.find((control) => {
      if (excluded.has(control) || !isVisible(control) || looksLikeWrongOfficialControl(control)) {
        return false;
      }
      const text = controlSearchText(control);
      return patterns.some((pattern) => pattern.test(text));
    }) || null;
  }

  function clickVisibleControl(control) {
    if (!control || !control.isConnected) {
      return { ok: false, error: "Visible Suno control disappeared before it could be clicked." };
    }
    try {
      if (typeof control.scrollIntoView === "function") {
        control.scrollIntoView({ block: "center", inline: "center" });
      }
    } catch (error) {
      console.warn("[OFFICIAL DOWNLOAD WARN]", "scrollIntoView", messageFrom(error));
    }
    try {
      control.click();
      return { ok: true, error: "" };
    } catch (error) {
      const message = messageFrom(error);
      console.warn("[OFFICIAL DOWNLOAD WARN]", "click", message);
      return { ok: false, error: `Visible Suno control could not be clicked: ${message}` };
    }
  }

  function controlSearchText(control) {
    const parts = [
      control.textContent || "",
      control.getAttribute("aria-label") || "",
      control.getAttribute("title") || "",
      control.getAttribute("data-testid") || "",
      control.getAttribute("role") || ""
    ];
    if (control.attributes) {
      Array.from(control.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        if (name.includes("aria") || name.includes("data") || name.includes("test") || name.includes("label") || name.includes("title")) {
          parts.push(attribute.name, attribute.value || "");
        }
      });
    }
    control.querySelectorAll("svg title, title").forEach((node) => {
      parts.push(node.textContent || "");
    });
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function looksLikeWrongOfficialControl(control) {
    const text = controlSearchText(control).toLowerCase();
    return /\b(play|pause|like|share|remix|create|extend)\b/.test(text)
      && !/\b(download|audio|mp3|more|options|menu|actions)\b/.test(text);
  }

  function isCardSelected(card) {
    if (card.matches("[aria-selected='true'], [data-selected='true'], [aria-checked='true']")) {
      return true;
    }
    return Boolean(card.querySelector("input[type='checkbox']:checked, [aria-selected='true'], [data-selected='true'], [aria-checked='true'], button[aria-pressed='true']"));
  }

  function isAllowedSunoUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return false;
    }
    return isSunoHost(url.hostname) || url.hostname.toLowerCase() === location.hostname.toLowerCase();
  }

  async function saveExportBlob(blob, fileName, relativePath, options = {}) {
    if (state.downloadDirectoryHandle) {
      try {
        const savedPath = await writeBlobToSelectedFolder(blob, relativePath || fileName);
        console.info("[DOWNLOADED]", savedPath);
        return { status: "folder", path: savedPath, confirmed: true };
      } catch (error) {
        state.lastFolderError = messageFrom(error);
        state.folderWriteTestOk = false;
        state.status = `Selected folder is not active; using browser Downloads. Last folder error: ${state.lastFolderError}`;
        console.warn("[FAILED]", "selected-folder-write", fileName, state.lastFolderError);
        render();
      }
    }
    if (options.confirmedDownload) {
      return downloadBlobWithGm(blob, fileName);
    }
    console.info("[DOWNLOADING]", "browser anchor fallback", fileName);
    downloadBlob(blob, fileName);
    return {
      status: "download",
      path: fileName,
      confirmed: false,
      method: "browser-anchor",
      error: state.lastFolderError ? `Selected folder failed: ${state.lastFolderError}` : "Browser fallback download was started, but completion could not be confirmed."
    };
  }

  async function writeBlobToSelectedFolder(blob, relativePath) {
    const handle = state.downloadDirectoryHandle;
    if (!handle) {
      throw new Error("No download folder is selected.");
    }
    const allowed = await ensureDirectoryPermission(handle);
    if (!allowed) {
      throw new Error("Download folder permission was denied.");
    }
    state.folderPermissionStatus = "granted";

    const parts = String(relativePath || "download")
      .split(/[\\/]+/)
      .map((part) => cleanFileName(part))
      .filter(Boolean);
    if (!parts.length) {
      parts.push("download");
    }

    let directory = handle;
    for (const folderName of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(folderName, { create: true });
    }

    const fileName = parts[parts.length - 1];
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }
    state.lastFolderError = "";
    return `${state.downloadDirectoryName || "selected folder"}/${parts.join("/")}`;
  }

  async function downloadBlobWithGm(blob, fileName) {
    console.info("[DOWNLOADING]", "GM_download Blob attempt", fileName);
    try {
      return await gmDownloadSource(blob, fileName);
    } catch (blobError) {
      console.warn("[FAILED]", "GM_download Blob attempt", fileName, messageFrom(blobError));
    }

    const url = URL.createObjectURL(blob);
    try {
      console.info("[DOWNLOADING]", "GM_download object URL attempt", fileName);
      return await gmDownloadSource(url, fileName);
    } catch (urlError) {
      console.warn("[FAILED]", "GM_download object URL attempt", fileName, messageFrom(urlError));
      console.info("[DOWNLOADING]", "browser anchor fallback", fileName);
      downloadUrlWithAnchor(url, fileName);
      return {
        status: "download",
        path: fileName,
        confirmed: false,
        method: "browser-anchor",
        error: `GM_download Blob/object URL failed: ${messageFrom(urlError)}`
      };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  async function downloadUrlWithGm(url, fileName) {
    try {
      return await gmDownloadSource(url, fileName);
    } catch (error) {
      console.warn("[FAILED]", "GM_download URL attempt", fileName, messageFrom(error));
      console.info("[DOWNLOADING]", "browser anchor fallback", fileName);
      downloadUrlWithAnchor(url, fileName);
      return {
        status: "download",
        path: fileName,
        confirmed: false,
        method: "browser-anchor",
        error: `GM_download URL failed: ${messageFrom(error)}`
      };
    }
  }

  function gmDownloadSource(source, fileName) {
    return new Promise((resolve, reject) => {
      if (typeof GM_download !== "function") {
        reject(new Error("Tampermonkey GM_download is unavailable."));
        return;
      }

      try {
        GM_download({
          url: source,
          name: cleanFileName(fileName),
          saveAs: false,
          onload: () => resolve({ status: "download", path: fileName, confirmed: true, method: "gm-download" }),
          onerror: (error) => reject(new Error(`GM_download failed: ${messageFrom(error)}`)),
          ontimeout: () => reject(new Error("GM_download timed out."))
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    downloadUrlWithAnchor(url, fileName);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function downloadUrlWithAnchor(url, fileName) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = cleanFileName(fileName);
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function uniqueBaseName(baseName, usedNames) {
    const key = baseName.toLowerCase();
    const count = usedNames.get(key) || 0;
    usedNames.set(key, count + 1);
    return count ? `${baseName} (${count + 1})` : baseName;
  }

  function cleanFileName(value) {
    return String(value || "untitled")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .slice(0, 180) || "untitled";
  }

  function cleanTitle(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^\W+|\W+$/g, "")
      .trim();
  }

  function normalizedText(node) {
    return (node.innerText || node.textContent || "").replace(/\r/g, "\n").trim();
  }

  function firstSrcSetUrl(srcset) {
    const first = srcset.split(",")[0] || "";
    return first.trim().split(/\s+/)[0] || "";
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function parseHeaders(rawHeaders) {
    return rawHeaders.split(/\r?\n/).reduce((headers, line) => {
      const index = line.indexOf(":");
      if (index > -1) {
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      return headers;
    }, {});
  }

  function extensionForMime(mimeType, fallback) {
    const clean = (mimeType || "").split(";")[0].trim().toLowerCase();
    if (clean === "image/png") {
      return ".png";
    }
    if (clean === "image/webp") {
      return ".webp";
    }
    if (clean === "image/gif") {
      return ".gif";
    }
    return fallback;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function shortHash(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function messageFrom(error) {
    return error instanceof Error ? error.message : String(error);
  }
})();
