/**
 * LocalShare - Reusable UI Components & View Controllers
 * Manages DOM rendering, device/file card components, modals, toasts, audio chime, and sanitization.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  // Security: HTML Sanitizer to prevent XSS in device names and file names
  function sanitizeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Formatting helpers
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function timeAgo(mtime) {
    const sec = Math.floor(Date.now() / 1000 - mtime);
    if (sec < 60) return 'Just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  // Audio Chime notification
  function playChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5

      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      setTimeout(() => {
        try { ctx.close(); } catch (e) {}
      }, 500);
    } catch (e) {}
  }

  // Toast Notification
  let toastTimeout = null;
  function showToast(msg, duration = 2800) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  // Theme Management
  function updateThemeFavicon(theme) {
    const favicon = document.getElementById('siteFavicon');
    if (favicon) {
      favicon.href = theme === 'light' ? 'assets/images/dgson-logo-light.png' : 'assets/images/dgson-logo.png';
    }
  }

  function initTheme() {
    const savedTheme = localStorage.getItem('localshare_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const themeIcon = document.getElementById('themeIcon');
    if (themeIcon) themeIcon.textContent = savedTheme === 'light' ? '☀️' : '🌓';
    updateThemeFavicon(savedTheme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('localshare_theme', next);
    const themeIcon = document.getElementById('themeIcon');
    if (themeIcon) themeIcon.textContent = next === 'light' ? '☀️' : '🌓';
    updateThemeFavicon(next);
  }

  // Device Cards Renderer
  function renderDevicesList(discoveredDevices, peerConnections) {
    const cfg = window.LS.config;
    const devicesGrid = document.getElementById('devicesGrid');
    const devicesCountBadge = document.getElementById('devicesCountBadge');
    const radarWaitingBox = document.getElementById('radarWaitingBox');
    const radarWaitingText = document.getElementById('radarWaitingText');

    if (!devicesGrid || !devicesCountBadge) return;

    // Safely retrieve peer connections and discovered devices from modules if not passed
    const peersObj = peerConnections || (window.LS.p2p && window.LS.p2p.getPeerConnections ? window.LS.p2p.getPeerConnections() : {});
    const discObj = discoveredDevices || (window.LS.discovery && window.LS.discovery.getDiscoveredDevices ? window.LS.discovery.getDiscoveredDevices() : {});

    const activePeers = Object.values(peersObj || {});
    const discovered = Object.values(discObj || {});
    const allRemote = [];
    const seenPeerIds = new Set();

    // 1. Discovered devices on same Wi-Fi
    discovered.forEach(d => {
      if (!d || !d.peerId || d.peerId === cfg.myPeerId) return;
      seenPeerIds.add(d.peerId);
      const connectedPeer = peersObj[d.peerId];
      const hasP2p = !!(connectedPeer && connectedPeer.conn && (connectedPeer.conn.open || (connectedPeer.conn.dataChannel && connectedPeer.conn.dataChannel.readyState === 'open')));
      const name = (connectedPeer && connectedPeer.name) || d.name || 'Friend Device';
      const os = (connectedPeer && connectedPeer.os) || d.os || 'Remote';
      const type = (connectedPeer && connectedPeer.type) || d.type || 'mobile';
      const icon = (connectedPeer && connectedPeer.icon) || d.icon || ((type === 'mobile' || os === 'iOS' || os === 'Android') ? '📱' : '💻');
      const pin = d.pin || (connectedPeer && connectedPeer.pin) || (d.peerId ? d.peerId.replace('dsoan_', '') : '');

      allRemote.push({
        id: d.id || d.peerId,
        peerId: d.peerId,
        name: name,
        os: os,
        type: type,
        icon: icon,
        pin: pin,
        isP2pReady: hasP2p,
        source: 'wifi'
      });
    });

    // 2. Active peers joined via PIN / Invite link or WebRTC
    activePeers.forEach(p => {
      if (!p || !p.conn) return;
      const isOpen = !!(p.conn.open || (p.conn.dataChannel && p.conn.dataChannel.readyState === 'open'));
      if (!isOpen) return;
      const remotePeerId = p.conn.peer;
      if (!remotePeerId || remotePeerId === cfg.myPeerId) return;
      if (!seenPeerIds.has(remotePeerId)) {
        seenPeerIds.add(remotePeerId);
        const pin = p.pin || (p.conn.metadata && p.conn.metadata.pin) || remotePeerId.replace('dsoan_', '');
        allRemote.push({
          id: remotePeerId,
          peerId: remotePeerId,
          name: p.name || 'Friend Device',
          os: p.os || 'Remote',
          type: p.type || 'mobile',
          icon: p.icon || ((p.type === 'mobile' || p.os === 'iOS' || p.os === 'Android') ? '📱' : '💻'),
          pin: pin,
          isP2pReady: true,
          source: 'internet'
        });
      }
    });

    const totalCount = allRemote.length + 1; // plus self
    devicesCountBadge.textContent = `${totalCount} Online`;

    if (radarWaitingBox && radarWaitingText) {
      if (allRemote.length === 0) {
        radarWaitingBox.style.display = 'flex';
        radarWaitingText.textContent = "Scanning your Wi-Fi network... Open https://transfer.digitalsoan.com on your phone to connect automatically!";
      } else {
        radarWaitingBox.style.display = 'none';
      }
    }

    let html = `
      <div class="device-card this-device">
        <div class="device-icon-box">
          <span>${cfg.myDeviceIcon}</span>
          <span class="device-online-dot"></span>
        </div>
        <div class="device-details">
          <div class="device-name-row">
            <span class="device-name" id="myDeviceNameDisplay">${sanitizeHtml(cfg.myDeviceName)}</span>
            <span class="device-tag">(You)</span>
            <button class="btn-edit-device-name" onclick="window.LS.ui.openDeviceNameModal()" title="Change Device Name">
              ✏️
            </button>
          </div>
          <div class="device-meta">
            <span>PIN: ${cfg.myShortPin}</span> • <span>This Device</span>
          </div>
        </div>
      </div>
    `;

    allRemote.forEach(d => {
      const isReady = d.isP2pReady;
      const tagText = isReady ? '🟢 Ready to Transfer' : '🟡 Connecting...';
      const tagClass = isReady ? 'device-tag online' : 'device-tag';
      const sourceLabel = d.source === 'wifi' ? 'Same Wi-Fi' : 'Over Internet';
      const safeName = sanitizeHtml(d.name);

      html += `
        <div class="device-card other-device" data-peer="${d.peerId}" onclick="window.LS.transfer.triggerSendToDevice('${d.peerId}')" style="cursor: pointer;" title="Click to send file to ${safeName}">
          <div class="device-icon-box">
            <span>${d.icon}</span>
            <span class="device-online-dot"></span>
          </div>
          <div class="device-details">
            <div class="device-name-row">
              <span class="device-name" title="${safeName}">${safeName}</span>
              <span class="${tagClass}">${tagText}</span>
            </div>
            <div class="device-meta">
              ${d.pin ? `<span>PIN: ${sanitizeHtml(d.pin)}</span> • ` : ''}<span>${sanitizeHtml(d.os)}</span> • <span>${sourceLabel}</span>
            </div>
          </div>
          <button class="btn-send-to-device" onclick="event.stopPropagation(); window.LS.transfer.triggerSendToDevice('${d.peerId}')">
            <span>📤</span> Send File
          </button>
        </div>
      `;
    });

    devicesGrid.innerHTML = html;
  }

  // File Cards Renderer
  function renderFilesList(files, filter = 'all', searchQuery = '') {
    const cfg = window.LS.config;
    const fileGrid = document.getElementById('fileGrid');
    const fileCountBadge = document.getElementById('fileCountBadge');
    const emptyState = document.getElementById('emptyState');
    if (!fileGrid || !fileCountBadge || !emptyState) return;

    const sourceFiles = files || [];

    const filtered = sourceFiles.filter(f => {
      if (filter === 'photo' && !f.isImage) return false;
      if (filter === 'video' && !f.isVideo) return false;
      if (filter === 'doc' && (f.isImage || f.isVideo || f.isAudio)) return false;
      if (filter === 'audio' && !f.isAudio) return false;
      if (searchQuery && !f.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });

    fileCountBadge.textContent = `${sourceFiles.length} file${sourceFiles.length === 1 ? '' : 's'}`;

    // Update 1-Click Multi-Save Action buttons in files toolbar (targets received files only)
    const btnSaveAllGallery = document.getElementById('btnSaveAllGallery');
    const btnSaveAllFolder = document.getElementById('btnSaveAllFolder');
    const btnDownloadZip = document.getElementById('btnDownloadZip');
    const isMobile = cfg.isIOS || cfg.isAndroid || cfg.isMobileDevice;
    const receivedFiles = sourceFiles.filter(f => !f.isSent);
    const hasReceivedFiles = receivedFiles.length > 0;
    const receivedMediaFiles = receivedFiles.filter(f => f.isImage || f.isVideo);

    if (btnSaveAllGallery) {
      btnSaveAllGallery.style.display = (isMobile && receivedMediaFiles.length > 0) ? 'inline-flex' : 'none';
      if (receivedMediaFiles.length > 0) {
        btnSaveAllGallery.innerHTML = `<span>📱</span> Save Received to Gallery (${receivedMediaFiles.length})`;
      }
    }
    if (btnSaveAllFolder) {
      btnSaveAllFolder.style.display = (!isMobile && hasReceivedFiles) ? 'inline-flex' : 'none';
      if (hasReceivedFiles) {
        btnSaveAllFolder.innerHTML = `<span>📂</span> Save Received to Folder (${receivedFiles.length})`;
      }
    }
    if (btnDownloadZip) {
      btnDownloadZip.style.display = hasReceivedFiles ? 'inline-flex' : 'none';
      if (hasReceivedFiles) {
        btnDownloadZip.innerHTML = `<span>📦</span> Download Received ZIP (${receivedFiles.length})`;
      }
    }

    if (filtered.length === 0) {
      fileGrid.innerHTML = '';
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';
    fileGrid.innerHTML = filtered.map(f => {
      const safeName = sanitizeHtml(f.name);
      const downloadUrl = f.blobUrl || `/api/download?file=${encodeURIComponent(f.name)}`;
      const previewUrl = f.blobUrl || `/api/preview?file=${encodeURIComponent(f.name)}`;
      const isMedia = f.isImage || f.isVideo;

      let thumbHtml = '';
      if (f.isImage) {
        thumbHtml = `<img src="${previewUrl}" alt="${safeName}" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';"><span class="file-type-icon" style="display:none;">🖼️</span>`;
      } else if (f.isVideo) {
        thumbHtml = `
          <span class="file-type-icon">🎬</span>
          <div class="video-play-overlay">▶</div>
        `;
      } else if (f.isAudio) {
        thumbHtml = `<span class="file-type-icon">🎵</span>`;
      } else if (f.ext === 'pdf') {
        thumbHtml = `<span class="file-type-icon">📕</span>`;
      } else if (['zip', 'rar', '7z'].includes(f.ext)) {
        thumbHtml = `<span class="file-type-icon">📦</span>`;
      } else {
        thumbHtml = `<span class="file-type-icon">📄</span>`;
      }

      let mediaActionHtml = '';
      if (isMedia && (cfg.isIOS || cfg.isAndroid) && !f.isSent) {
        mediaActionHtml = `
          <button class="btn-file-action btn-gallery" style="width:100%;" onclick="window.LS.transfer.saveToGallery('${safeName}')">
            <span>📱</span> Save to Gallery
          </button>
        `;
      }

      const directionBadge = f.isSent
        ? `<span style="color:var(--text-muted); font-size:0.7rem; background:rgba(255,255,255,0.06); padding:1px 5px; border-radius:4px;">↗ Sent</span>`
        : `<span style="color:var(--accent); font-size:0.7rem; background:rgba(34,197,94,0.12); padding:1px 5px; border-radius:4px;">↙ Received</span>`;

      return `
        <div class="file-card" data-name="${safeName}">
          <div class="file-thumbnail-box" onclick="window.LS.ui.openPreview('${safeName}')">
            ${thumbHtml}
          </div>
          <div class="file-meta">
            <div class="file-name" title="${safeName}">${safeName}</div>
            <div class="file-details">
              <span>${formatBytes(f.size)}</span>
              ${directionBadge}
              <span>${timeAgo(f.mtime)}</span>
            </div>
          </div>
          <div class="file-actions">
            ${mediaActionHtml}
            <div class="file-action-row">
              <button class="btn-file-action" onclick="window.LS.ui.openPreview('${safeName}')">
                👁 Preview
              </button>
              <a href="${downloadUrl}" class="btn-file-action" download="${safeName}">
                ⬇ Download
              </a>
            </div>
            <button class="btn-file-action btn-del" style="width:100%;" onclick="window.LS.app.deleteFile('${safeName}')">
              🗑 Delete
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Lightbox / File Preview Modal
  let currentPreviewFile = null;

  function openPreview(fileName) {
    const file = window.LS.app.findFile(fileName);
    if (!file) return;

    currentPreviewFile = file;
    const modal = document.getElementById('previewModal');
    const title = document.getElementById('previewTitle');
    const body = document.getElementById('previewContent');
    const meta = document.getElementById('previewMeta');
    const btnDownload = document.getElementById('btnModalDownload');
    const btnGallery = document.getElementById('btnModalGallery');
    const cfg = window.LS.config;

    title.textContent = file.name;
    meta.textContent = `${formatBytes(file.size)} • ${file.mime || file.ext}`;

    const url = file.blobUrl || `/api/preview?file=${encodeURIComponent(file.name)}`;
    const downloadUrl = file.blobUrl || `/api/download?file=${encodeURIComponent(file.name)}`;

    if (file.isImage) {
      body.innerHTML = `<img src="${url}" alt="${sanitizeHtml(file.name)}">`;
    } else if (file.isVideo) {
      body.innerHTML = `<video src="${url}" controls autoplay playsinline style="max-width:100%; max-height:65vh; border-radius:8px;"></video>`;
    } else if (file.isAudio) {
      body.innerHTML = `
        <div style="font-size:3.5rem; margin-bottom:1rem;">🎵</div>
        <audio src="${url}" controls autoplay style="width:100%; max-width:400px;"></audio>
      `;
    } else {
      body.innerHTML = `
        <div style="font-size:4rem; margin-bottom:1rem;">📄</div>
        <p style="font-size:0.95rem; font-weight:600;">${sanitizeHtml(file.name)}</p>
      `;
    }

    btnDownload.href = downloadUrl;
    btnDownload.setAttribute('download', file.name);

    if ((file.isImage || file.isVideo) && (cfg.isIOS || cfg.isAndroid)) {
      btnGallery.style.display = 'flex';
    } else {
      btnGallery.style.display = 'none';
    }

    modal.style.display = 'flex';
  }

  function closePreview() {
    const modal = document.getElementById('previewModal');
    const body = document.getElementById('previewContent');
    if (modal) modal.style.display = 'none';
    if (body) {
      const vid = body.querySelector('video');
      const aud = body.querySelector('audio');
      if (vid) vid.pause();
      if (aud) aud.pause();
      body.innerHTML = '';
    }
    currentPreviewFile = null;
  }

  window.saveCurrentPreviewToGallery = function() {
    if (currentPreviewFile) {
      window.LS.transfer.saveToGallery(currentPreviewFile.name);
    }
  };

  // Notes Modal
  function openNotes() {
    const modal = document.getElementById('notesModal');
    if (modal) modal.style.display = 'flex';
  }

  function closeNotes() {
    const modal = document.getElementById('notesModal');
    if (modal) modal.style.display = 'none';
  }

  // Device Name Editing Modal
  function openDeviceNameModal() {
    const modal = document.getElementById('deviceNameModal');
    const input = document.getElementById('inputDeviceName');
    if (!modal) return;
    if (input) {
      input.value = window.LS.config.myDeviceName || '';
      setTimeout(() => input.focus(), 80);
    }
    modal.style.display = 'flex';
  }

  function closeDeviceNameModal() {
    const modal = document.getElementById('deviceNameModal');
    if (modal) modal.style.display = 'none';
  }

  function saveDeviceNameFromInput() {
    const input = document.getElementById('inputDeviceName');
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
      showToast('Please enter a valid device name');
      return;
    }
    const newName = window.LS.config.setDeviceName(val);
    closeDeviceNameModal();
    renderDevicesList();
    if (window.LS.p2p && typeof window.LS.p2p.broadcastIdentityUpdate === 'function') {
      window.LS.p2p.broadcastIdentityUpdate();
    }
    showToast(`Device name updated to "${newName}"`);
  }

  window.LS.ui = {
    sanitizeHtml,
    formatBytes,
    timeAgo,
    playChime,
    showToast,
    initTheme,
    toggleTheme,
    renderDevicesList,
    renderFilesList,
    openPreview,
    closePreview,
    openNotes,
    closeNotes,
    openDeviceNameModal,
    closeDeviceNameModal,
    saveDeviceNameFromInput
  };

})(window);
