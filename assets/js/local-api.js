/**
 * LocalShare - Local Desktop Offline Server API Client
 * Manages communication with native desktop host servers (Node.js, Python, PHP)
 * for offline LAN mode (start_share.bat).
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  async function fetchServerInfo() {
    try {
      const res = await fetch('/api/info');
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) {
        const wifiEl = document.getElementById('wifiSsidName');
        const urlEl = document.getElementById('serverUrlText');
        if (wifiEl && data.wifiSsid) wifiEl.textContent = data.wifiSsid;
        if (urlEl && data.primaryIp) urlEl.textContent = `http://${data.primaryIp}:${data.port || 8080}`;
      }
    } catch (e) {
      // Ignored when not running on local desktop server
    }
  }

  async function fetchFiles() {
    try {
      const res = await fetch('/api/files');
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.files)) {
        if (window.LS.app && typeof window.LS.app.setLocalFiles === 'function') {
          window.LS.app.setLocalFiles(data.files);
        }
      }
    } catch (e) {
      // Ignored when running purely on cloud/static host
    }
  }

  async function sendHeartbeat() {
    const cfg = window.LS.config;
    if (!cfg) return;

    try {
      const res = await fetch('/api/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: cfg.myDeviceId,
          name: cfg.myDeviceName,
          type: cfg.myDeviceType,
          os: cfg.myDeviceOs
        })
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.devices)) {
        if (window.LS.discovery && window.LS.discovery.discoveredDevices) {
          data.devices.forEach(d => {
            if (d.id !== cfg.myDeviceId) {
              window.LS.discovery.discoveredDevices[d.id] = {
                id: d.id,
                name: d.name,
                os: d.os,
                type: d.type,
                lastSeen: Date.now(),
                source: 'wifi'
              };
            }
          });
          if (window.LS.ui && typeof window.LS.ui.renderDevicesList === 'function') {
            window.LS.ui.renderDevicesList();
          }
        }
      }
    } catch (e) {}
  }

  async function deleteFile(fileName) {
    try {
      await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: fileName })
      });
      await fetchFiles();
    } catch (e) {
      console.warn('Local delete failed:', e);
    }
  }

  async function openFolder() {
    const ui = window.LS.ui;
    try {
      const res = await fetch('/api/open_folder', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        if (ui) ui.showToast('Opened shared_files folder on PC');
      } else {
        if (ui) ui.showToast('Folder path: E:\\shared_files');
      }
    } catch (e) {
      if (ui) ui.showToast('Folder path: E:\\shared_files');
    }
  }

  async function getNotes() {
    try {
      const res = await fetch('/api/notes');
      if (!res.ok) return null;
      const data = await res.json();
      return data.note || '';
    } catch (e) {
      return null;
    }
  }

  async function saveNotes(noteText) {
    try {
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteText })
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function uploadFiles(files) {
    const transfer = window.LS.transfer;
    const ui = window.LS.ui;
    const uploadCard = document.getElementById('uploadCard');

    if (transfer) transfer.transferCancelled = false;
    if (uploadCard) uploadCard.style.display = 'flex';

    for (let i = 0; i < files.length; i++) {
      if (transfer && transfer.transferCancelled) break;
      await uploadSingleFile(files[i], i + 1, files.length);
    }

    if (uploadCard) uploadCard.style.display = 'none';

    if (transfer && !transfer.transferCancelled) {
      if (ui) {
        ui.playChime();
        ui.showToast('All files saved to PC!');
      }
      await fetchFiles();
    }
  }

  async function uploadSingleFile(file, currentIdx, totalFiles) {
    const transfer = window.LS.transfer;
    const ui = window.LS.ui;
    const chunkSize = 4 * 1024 * 1024;
    const totalChunks = Math.ceil(file.size / chunkSize) || 1;
    const uploadId = 'up_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    const progressFileName = document.getElementById('progressFileName');
    const progressBarFill = document.getElementById('progressBarFill');
    const progressPercent = document.getElementById('progressPercent');
    const progressTransferInfo = document.getElementById('progressTransferInfo');
    const progressSpeed = document.getElementById('progressSpeed');
    const progressStatusText = document.getElementById('progressStatusText');

    if (progressFileName) progressFileName.textContent = `(${currentIdx}/${totalFiles}) ${file.name}`;
    if (progressBarFill) progressBarFill.style.width = '0%';
    if (progressPercent) progressPercent.textContent = '0%';
    if (progressStatusText) progressStatusText.textContent = '';

    let bytesUploaded = 0;
    const startTime = Date.now();

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (transfer && transfer.transferCancelled) return;
      const start = chunkIdx * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunkBlob = file.slice(start, end);

      const res = await fetch('/api/upload_chunk', {
        method: 'POST',
        headers: {
          'X-Upload-Id': uploadId,
          'X-File-Name': encodeURIComponent(file.name),
          'X-Chunk-Index': chunkIdx.toString(),
          'X-Total-Chunks': totalChunks.toString(),
          'X-File-Size': file.size.toString()
        },
        body: chunkBlob
      });

      if (!res.ok) {
        if (ui) ui.showToast(`Upload failed for ${file.name}`);
        return;
      }

      bytesUploaded += (end - start);
      const percent = Math.min(100, Math.round((bytesUploaded / file.size) * 100));
      if (progressBarFill) progressBarFill.style.width = percent + '%';
      if (progressPercent) progressPercent.textContent = percent + '%';

      const elapsedSec = (Date.now() - startTime) / 1000;
      const speedBps = elapsedSec > 0 ? bytesUploaded / elapsedSec : 0;
      if (progressTransferInfo) progressTransferInfo.textContent = `${ui ? ui.formatBytes(bytesUploaded) : bytesUploaded} / ${ui ? ui.formatBytes(file.size) : file.size}`;
      if (progressSpeed) progressSpeed.textContent = `${(speedBps / (1024 * 1024)).toFixed(1)} MB/s`;
    }
  }

  window.LS.localApi = {
    fetchServerInfo,
    fetchFiles,
    sendHeartbeat,
    deleteFile,
    openFolder,
    getNotes,
    saveNotes,
    uploadFiles,
    uploadSingleFile
  };

})(window);
