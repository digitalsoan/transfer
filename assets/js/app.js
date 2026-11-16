/**
 * LocalShare - Main Application Controller & Orchestrator
 * Wires together UI components, P2P engine, discovery layer, local offline API,
 * and user interactions.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  // Application State
  let allFiles = [];
  let p2pReceivedFiles = [];
  let localFiles = [];
  let currentFilter = 'all';
  let searchQuery = '';

  function mergeAndRenderFiles() {
    const map = new Map();
    localFiles.forEach(f => map.set(f.name, f));
    // p2p files take precedence because they contain in-memory Blobs and active blobUrls
    p2pReceivedFiles.forEach(f => map.set(f.name, f));
    allFiles = Array.from(map.values());
    renderFiles();
  }

  function renderFiles() {
    if (window.LS.ui && typeof window.LS.ui.renderFilesList === 'function') {
      window.LS.ui.renderFilesList(allFiles, currentFilter, searchQuery);
    }
  }

  function setLocalFiles(files) {
    localFiles = Array.isArray(files) ? files : [];
    mergeAndRenderFiles();
  }

  function addReceivedFile(fileObj) {
    if (!fileObj || !fileObj.name) return;
    const idx = p2pReceivedFiles.findIndex(f => f.name === fileObj.name);
    if (idx !== -1) {
      p2pReceivedFiles[idx] = fileObj;
    } else {
      p2pReceivedFiles.unshift(fileObj);
    }
    mergeAndRenderFiles();
  }

  function deleteFile(fileName) {
    p2pReceivedFiles = p2pReceivedFiles.filter(f => f.name !== fileName);
    localFiles = localFiles.filter(f => f.name !== fileName);
    mergeAndRenderFiles();

    if (window.LS.config && window.LS.config.isLocalServerHost && window.LS.localApi) {
      window.LS.localApi.deleteFile(fileName);
    }
    if (window.LS.ui) {
      window.LS.ui.showToast(`Deleted "${fileName}"`);
    }
  }

  function findFile(fileName) {
    return p2pReceivedFiles.find(f => f.name === fileName) ||
           localFiles.find(f => f.name === fileName) ||
           allFiles.find(f => f.name === fileName) || null;
  }

  function notifyDevicesChanged() {
    if (window.LS.ui && typeof window.LS.ui.renderDevicesList === 'function') {
      window.LS.ui.renderDevicesList();
    }
    // Attempt auto-connect to newly discovered peers
    if (window.LS.discovery && window.LS.discovery.discoveredDevices && window.LS.p2p) {
      for (const devId in window.LS.discovery.discoveredDevices) {
        window.LS.p2p.tryAutoConnectPeer(devId);
      }
    }
  }

  // File Upload Dispatcher
  async function handleUpload(fileList) {
    if (!fileList || fileList.length === 0) return;

    if (window.LS.p2p && window.LS.p2p.hasActiveConnections()) {
      await window.LS.transfer.sendFiles(fileList);
    } else if (window.LS.config && window.LS.config.isLocalServerHost && window.LS.localApi) {
      await window.LS.localApi.uploadFiles(fileList);
    } else {
      if (window.LS.ui) {
        window.LS.ui.showToast('Connecting to device... Transfer will start automatically.');
      }
      await window.LS.transfer.sendFiles(fileList);
    }
  }

  // Device Wake & Screen Lock Resume
  function handleDeviceWake() {
    if (document.visibilityState === 'visible') {
      if (window.LS.power) {
        window.LS.power.acquireWakeLock();
      }
      if (window.LS.p2p) {
        window.LS.p2p.ensureSignalingAlive();
      }
      if (window.LS.discovery) {
        window.LS.discovery.broadcastPresence('ping');
      }
      const session = window.LS.transfer ? window.LS.transfer.getSession() : null;
      if (session && session.state === 'paused') {
        window.LS.transfer.attemptAutoResume();
      }
    }
  }

  // UI Event Wiring
  function initEventListeners() {
    const cfg = window.LS.config;
    const ui = window.LS.ui;
    const p2p = window.LS.p2p;
    const transfer = window.LS.transfer;
    const localApi = window.LS.localApi;

    // Remote Friend drawer
    const btnToggleRemote = document.getElementById('btnToggleRemote');
    const remoteFriendDrawer = document.getElementById('remoteFriendDrawer');
    if (btnToggleRemote && remoteFriendDrawer) {
      btnToggleRemote.addEventListener('click', () => {
        const isHidden = remoteFriendDrawer.style.display === 'none' || !remoteFriendDrawer.style.display;
        remoteFriendDrawer.style.display = isHidden ? 'flex' : 'none';
      });
    }

    // Copy Invite Link
    const btnCopyInvite = document.getElementById('btnCopyInvite');
    if (btnCopyInvite && cfg) {
      btnCopyInvite.addEventListener('click', () => {
        const inviteUrl = `${window.location.origin}${window.location.pathname}#${cfg.myShortPin}`;
        navigator.clipboard.writeText(inviteUrl).then(() => {
          ui.showToast(`Invite Link Copied: PIN ${cfg.myShortPin}`);
        }).catch(() => {
          ui.showToast(`PIN: ${cfg.myShortPin}`);
        });
      });
    }

    // Connect to Remote PIN
    const btnJoinRoom = document.getElementById('btnJoinRoom');
    const joinRoomInput = document.getElementById('joinRoomInput');
    if (btnJoinRoom && joinRoomInput && p2p) {
      btnJoinRoom.addEventListener('click', () => {
        const pin = joinRoomInput.value.trim();
        if (!pin) {
          ui.showToast("Please enter friend's 4-digit PIN");
          return;
        }
        p2p.connectToRemotePeer('dsoan_' + pin, true);
      });
    }

    // Server URL chip
    const urlChip = document.getElementById('urlChip');
    const serverUrlText = document.getElementById('serverUrlText');
    if (urlChip && serverUrlText && ui) {
      urlChip.addEventListener('click', () => {
        const url = serverUrlText.textContent;
        navigator.clipboard.writeText(url).then(() => {
          ui.showToast(`Copied ${url} to clipboard!`);
        }).catch(() => {
          ui.showToast(`Link: ${url}`);
        });
      });
    }

    // File selection inputs
    const mediaInput = document.getElementById('mediaInput');
    if (mediaInput) {
      mediaInput.addEventListener('change', async e => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        try {
          await handleUpload(files);
        } finally {
          mediaInput.value = '';
        }
      });
    }

    const docInput = document.getElementById('docInput');
    if (docInput) {
      docInput.addEventListener('change', async e => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        try {
          await handleUpload(files);
        } finally {
          docInput.value = '';
        }
      });
    }

    // Dropzone
    const dropzone = document.getElementById('dropzone');
    if (dropzone && docInput) {
      dropzone.addEventListener('click', () => docInput.click());

      ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, e => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('dragover');
        });
      });

      ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, e => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('dragover');
        });
      });

      dropzone.addEventListener('drop', async e => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
          const files = Array.from(dt.files);
          await handleUpload(files);
        }
      });
    }

    // Filter pills
    document.querySelectorAll('.tab-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.tab-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        currentFilter = pill.getAttribute('data-filter') || 'all';
        renderFiles();
      });
    });

    // Search box
    const searchBox = document.getElementById('searchBox');
    if (searchBox) {
      searchBox.addEventListener('input', e => {
        searchQuery = e.target.value;
        renderFiles();
      });
    }

    // Refresh button
    const btnRefresh = document.getElementById('btnRefresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => {
        if (cfg && cfg.isLocalServerHost && localApi) {
          localApi.fetchFiles();
          localApi.sendHeartbeat();
        }
        ui.renderDevicesList();
        renderFiles();
        ui.showToast('Refreshed');
      });
    }

    // Open Desktop folder
    const btnOpenFolder = document.getElementById('btnOpenFolder');
    if (btnOpenFolder && localApi) {
      btnOpenFolder.addEventListener('click', () => localApi.openFolder());
    }

    // Preview modal events
    const btnClosePreview = document.getElementById('btnClosePreview');
    const previewModal = document.getElementById('previewModal');
    if (btnClosePreview && ui) {
      btnClosePreview.addEventListener('click', ui.closePreview);
    }
    if (previewModal && ui) {
      previewModal.addEventListener('click', e => {
        if (e.target === previewModal) ui.closePreview();
      });
    }

    // Notes modal events
    const btnNotes = document.getElementById('btnNotes');
    const notesModal = document.getElementById('notesModal');
    const notesText = document.getElementById('notesText');
    const btnCloseNotes = document.getElementById('btnCloseNotes');
    const btnSaveNote = document.getElementById('btnSaveNote');
    const btnCopyNote = document.getElementById('btnCopyNote');

    if (btnNotes && notesModal && notesText) {
      btnNotes.addEventListener('click', async () => {
        if (cfg && cfg.isLocalServerHost && localApi) {
          const note = await localApi.getNotes();
          if (note !== null) notesText.value = note;
        } else {
          notesText.value = localStorage.getItem('localshare_notes') || '';
        }
        notesModal.style.display = 'flex';
      });
    }

    if (btnCloseNotes && notesModal) {
      btnCloseNotes.addEventListener('click', () => {
        notesModal.style.display = 'none';
      });
    }

    if (notesModal) {
      notesModal.addEventListener('click', e => {
        if (e.target === notesModal) notesModal.style.display = 'none';
      });
    }

    if (btnSaveNote && notesText) {
      btnSaveNote.addEventListener('click', async () => {
        if (cfg && cfg.isLocalServerHost && localApi) {
          await localApi.saveNotes(notesText.value);
        }
        localStorage.setItem('localshare_notes', notesText.value);
        if (ui) ui.showToast('Notes saved!');
        if (notesModal) notesModal.style.display = 'none';
      });
    }

    if (btnCopyNote && notesText && ui) {
      btnCopyNote.addEventListener('click', () => {
        navigator.clipboard.writeText(notesText.value).then(() => {
          ui.showToast('Notes copied to clipboard!');
        });
      });
    }

    // Theme toggle
    const btnThemeToggle = document.getElementById('btnThemeToggle');
    if (btnThemeToggle && ui) {
      btnThemeToggle.addEventListener('click', ui.toggleTheme);
    }

    // Cancel / Resume transfer buttons
    const btnCancelTransfer = document.getElementById('btnCancelTransfer');
    if (btnCancelTransfer && transfer) {
      btnCancelTransfer.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        transfer.cancelCurrentTransfer();
      });
    }

    const btnResumeTransfer = document.getElementById('btnResumeTransfer');
    if (btnResumeTransfer && transfer) {
      btnResumeTransfer.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        transfer.attemptAutoResume();
      });
    }

    // Wake lifecycle listeners
    document.addEventListener('visibilitychange', handleDeviceWake);
    window.addEventListener('focus', handleDeviceWake);
    window.addEventListener('pageshow', handleDeviceWake);
  }

  // App Bootstrap
  function init() {
    const cfg = window.LS.config;
    const ui = window.LS.ui;
    const p2p = window.LS.p2p;
    const localApi = window.LS.localApi;

    // Hide iOS tip banner on desktop PC
    if (cfg && !cfg.isIOS && !cfg.isAndroid) {
      const tipBanner = document.querySelector('.ios-tip-banner');
      if (tipBanner) tipBanner.style.display = 'none';
    }

    // Initialize Theme
    if (ui) ui.initTheme();

    // Wire up events
    initEventListeners();

    // Render initial device card
    if (ui) ui.renderDevicesList();

    // Initialize P2P Signaling & Network Discovery
    if (p2p) p2p.initInternetPeer();

    // If hosted on offline desktop server
    if (cfg && cfg.isLocalServerHost && localApi) {
      localApi.fetchServerInfo();
      localApi.fetchFiles();
      localApi.sendHeartbeat();
      setInterval(localApi.sendHeartbeat, 2500);
      setInterval(localApi.fetchFiles, 4000);
    }
  }

  window.LS.app = {
    init,
    setLocalFiles,
    addReceivedFile,
    deleteFile,
    findFile,
    renderFiles,
    notifyDevicesChanged,
    handleUpload
  };

  // Launch on DOMContentLoaded or immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
