/**
 * LocalShare - Resumable P2P Transfer Engine
 * High-performance 64KB SCTP wire chunks with 1MB disk block buffering,
 * event-driven flow-control backpressure, pause-wait loop for locked mobile displays,
 * receiver ACK validation, and Web Share API gallery export.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  let transferCancelled = false;
  let isTransferring = false;
  let currentTransferSession = null;
  let selectedTargetPeerId = null;

  // Receiver active buffers: transferId -> { meta, chunks, receivedBytes, startTime, ... }
  const activeIncomingTransfers = {};
  let incomingTransferId = null;

  // DOM Elements
  const uploadCard = document.getElementById('uploadCard');
  const progressFileName = document.getElementById('progressFileName');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressPercent = document.getElementById('progressPercent');
  const progressTransferInfo = document.getElementById('progressTransferInfo');
  const progressSpeed = document.getElementById('progressSpeed');
  const progressEta = document.getElementById('progressEta');
  const progressWakeLockHint = document.getElementById('progressWakeLockHint');
  const btnResumeTransfer = document.getElementById('btnResumeTransfer');
  const transferCompleteActions = document.getElementById('transferCompleteActions');
  const btnQuickSaveGallery = document.getElementById('btnQuickSaveGallery');
  const btnQuickSaveDownloads = document.getElementById('btnQuickSaveDownloads');
  const btnQuickSavePC = document.getElementById('btnQuickSavePC');
  const btnQuickDownloadZip = document.getElementById('btnQuickDownloadZip');

  function showTransferCompleteActions(totalCount = 0) {
    if (!transferCompleteActions) return;
    const cfg = window.LS.config || {};
    const isMobile = cfg.isIOS || cfg.isAndroid || cfg.isMobileDevice;
    const allFiles = (window.LS.app && window.LS.app.getAllFiles) ? window.LS.app.getAllFiles() : [];
    // Strictly target received files (excluding files sent by this device)
    const receivedFiles = allFiles.filter(f => !f.isSent);
    const count = totalCount || receivedFiles.length;
    const mediaFiles = receivedFiles.filter(f => f.isImage || f.isVideo);

    if (btnQuickSaveGallery) {
      btnQuickSaveGallery.style.display = (isMobile && mediaFiles.length > 0) ? 'inline-flex' : 'none';
      if (mediaFiles.length > 0) {
        btnQuickSaveGallery.innerHTML = `<span>📱</span> Save Received to Gallery (${mediaFiles.length})`;
      }
    }
    if (btnQuickSaveDownloads) {
      btnQuickSaveDownloads.style.display = (!isMobile && count > 0) ? 'inline-flex' : 'none';
      if (count > 0) {
        btnQuickSaveDownloads.innerHTML = `<span>📥</span> Save to Downloads (${count})`;
      }
    }
    if (btnQuickSavePC) {
      btnQuickSavePC.style.display = (!isMobile && count > 0) ? 'inline-flex' : 'none';
      if (count > 0) {
        btnQuickSavePC.innerHTML = `<span>📂</span> Pick Custom Folder (${count})`;
      }
    }
    if (btnQuickDownloadZip) {
      btnQuickDownloadZip.style.display = count > 0 ? 'inline-flex' : 'none';
      if (count > 0) {
        btnQuickDownloadZip.innerHTML = `<span>📦</span> Download Received ZIP (${count})`;
      }
    }

    transferCompleteActions.style.display = 'flex';
  }

  function isCancelled() {
    return transferCancelled;
  }

  function getSession() {
    return currentTransferSession;
  }

  function triggerSendToDevice(peerId) {
    selectedTargetPeerId = peerId;
    const cfg = window.LS.config;
    if (peerId && !window.LS.p2p.isPeerConnected(peerId)) {
      window.LS.p2p.tryAutoConnectPeer(peerId, true);
    }
    const mediaInput = document.getElementById('mediaInput');
    const docInput = document.getElementById('docInput');
    if (cfg.isIOS || cfg.isAndroid) {
      if (mediaInput) mediaInput.click();
    } else {
      if (docInput) docInput.click();
    }
  }

  // 1. Batch Queue Sending Controller
  async function sendFiles(files, targetPeerId = null) {
    if (!files || files.length === 0) return;
    const targetId = targetPeerId || selectedTargetPeerId;
    selectedTargetPeerId = null;

    let targets = [];
    const peerConnections = window.LS.p2p.getPeerConnections();

    if (targetId && peerConnections[targetId] && peerConnections[targetId].conn && (peerConnections[targetId].conn.open || (peerConnections[targetId].conn.dataChannel && peerConnections[targetId].conn.dataChannel.readyState === 'open'))) {
      targets = [peerConnections[targetId]];
    } else {
      targets = Object.values(peerConnections).filter(p => p.conn && (p.conn.open || (p.conn.dataChannel && p.conn.dataChannel.readyState === 'open')));
    }

    if (targets.length === 0) {
      const discovered = window.LS.discovery ? window.LS.discovery.getDiscoveredDevices() : {};
      const fallbackPeerId = targetId || Object.values(discovered)[0]?.peerId;
      if (fallbackPeerId && window.LS.p2p.isReady()) {
        window.LS.ui.showToast("Connecting to friend device...");
        const reconnectedConn = await window.LS.p2p.waitForAutoReconnect(fallbackPeerId, 8);
        if (reconnectedConn && (reconnectedConn.open || (reconnectedConn.dataChannel && reconnectedConn.dataChannel.readyState === 'open'))) {
          const freshPeers = window.LS.p2p.getPeerConnections();
          targets = [freshPeers[fallbackPeerId] || { conn: reconnectedConn }];
        }
      }
    }

    if (targets.length === 0) {
      window.LS.ui.showToast("Waiting for friend device to connect! Please ensure friend is online at transfer.digitalsoan.com.");
      return;
    }

    transferCancelled = false;
    isTransferring = true;
    if (transferCompleteActions) transferCompleteActions.style.display = 'none';
    await window.LS.power.acquireWakeLock();
    window.LS.power.startSilentAudio();
    if (uploadCard) uploadCard.style.display = 'flex';
    if (progressWakeLockHint) progressWakeLockHint.style.display = 'block';

    for (let i = 0; i < files.length; i++) {
      if (transferCancelled) break;
      const file = files[i];

      for (const target of targets) {
        if (transferCancelled) break;
        currentTransferSession = {
          file,
          currentIdx: i + 1,
          totalFiles: files.length,
          targetPeerId: target.conn.peer,
          transferId: (file.name + '_' + file.size + '_' + (file.lastModified || 0)).replace(/[^a-zA-Z0-9_]/g, '_'),
          fileOffset: 0,
          state: 'active'
        };

        await sendSingleFile(target.conn, file, i + 1, files.length);

        while (!transferCancelled && currentTransferSession && currentTransferSession.state === 'paused') {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (transferCancelled) break;

      // Add to sender's own file list with live local thumbnail
      const ext = file.name.split('.').pop().toLowerCase();
      const mimeType = window.LS.config.getMimeType(file.name, file.type);
      const objectUrl = URL.createObjectURL(file);

      window.LS.app.addReceivedFile({
        name: file.name,
        size: file.size,
        mtime: Math.floor(Date.now() / 1000),
        ext,
        mime: mimeType,
        isImage: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg'].includes(ext),
        isVideo: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext),
        isAudio: ['mp3', 'm4a', 'wav', 'aac'].includes(ext),
        isDoc: true,
        blobUrl: objectUrl,
        blobObj: file,
        isSent: true
      });

      // 250ms cool-down pause between files so receiver completes Blob creation and memory release
      if (i < files.length - 1) {
        if (progressEta) progressEta.textContent = `(${i + 1}/${files.length}) Done. Preparing next file...`;
        await new Promise(r => setTimeout(r, 250));
      }
    }

    if (transferCancelled) {
      if (uploadCard) uploadCard.style.display = 'none';
      if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
      if (transferCompleteActions) transferCompleteActions.style.display = 'none';
      isTransferring = false;
      window.LS.power.releaseWakeLock();
      window.LS.power.stopSilentAudio();
      return;
    }

    if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
    isTransferring = false;
    window.LS.power.releaseWakeLock();
    window.LS.power.stopSilentAudio();
    window.LS.ui.playChime();
    window.LS.ui.showToast('All files sent successfully!');

    if (progressBarFill) progressBarFill.style.width = '100%';
    if (progressPercent) progressPercent.textContent = '100%';
    if (progressEta) progressEta.textContent = (files.length > 1) ? `All ${files.length} files sent!` : 'File sent!';
    if (progressSpeed) progressSpeed.textContent = '0.0 MB/s';

    // SENDER completed: Automatically close progress card after 1.5 seconds.
    // Sender already holds original files on device, so do NOT show "Save All" actions here.
    setTimeout(() => {
      if (!isTransferring && uploadCard) uploadCard.style.display = 'none';
    }, 1500);
  }

  // 2. Single Resumable File Stream Engine
  async function sendSingleFile(conn, file, currentIdx, totalFiles) {
    const cfg = window.LS.config;
    const CHUNK_SIZE = cfg.CHUNK_SIZE;
    const BLOCK_SIZE = cfg.BLOCK_SIZE;
    const transferId = (file.name + '_' + file.size + '_' + (file.lastModified || 0)).replace(/[^a-zA-Z0-9_]/g, '_');

    isTransferring = true;
    await window.LS.power.acquireWakeLock();
    window.LS.power.startSilentAudio();
    if (progressWakeLockHint) progressWakeLockHint.style.display = 'block';

    const countPrefix = totalFiles > 1 ? `(${currentIdx}/${totalFiles}) ` : '';
    if (progressFileName) progressFileName.textContent = `${countPrefix}${file.name}`;
    if (progressBarFill) progressBarFill.style.width = '0%';
    if (progressPercent) progressPercent.textContent = '0%';
    if (progressEta) progressEta.textContent = 'Checking resume status...';

    const mimeType = cfg.getMimeType(file.name, file.type);

    // Step 1: Resumable Check - query if receiver already holds partial chunks
    let resumeOffset = 0;
    if (conn && conn.open) {
      conn.send(JSON.stringify({
        type: 'file-resume-query',
        transferId: transferId
      }));

      await new Promise(resolve => {
        const t = setTimeout(() => resolve(), 600);
        conn._resumeResolver = (offset) => {
          clearTimeout(t);
          resumeOffset = offset || 0;
          resolve();
        };
      });
    }

    let fileOffset = (resumeOffset > 0 && resumeOffset < file.size) ? resumeOffset : 0;
    if (fileOffset > 0) {
      window.LS.ui.showToast(`Resuming ${file.name} from ${window.LS.ui.formatBytes(fileOffset)} (${Math.round(fileOffset / file.size * 100)}%)!`);
    }

    // Step 2: Send metadata with exact startOffset
    conn.send(JSON.stringify({
      type: 'file-meta',
      transferId: transferId,
      name: file.name,
      size: file.size,
      mime: mimeType,
      startOffset: fileOffset,
      currentIdx: currentIdx,
      totalFiles: totalFiles
    }));

    await new Promise(r => setTimeout(r, 30));

    let lastSenderUiUpdate = 0;
    const startTime = Date.now();
    let lastSampleTime = startTime;
    let lastSampleBytes = fileOffset;
    let currentSpeedMBps = 0;

    if (conn.dataChannel) {
      try {
        conn.dataChannel.bufferedAmountLowThreshold = 256 * 1024; // 256 KB
        conn.dataChannel.binaryType = 'arraybuffer';
      } catch (e) {}
    }

    while (fileOffset < file.size) {
      if (transferCancelled) break;

      // Connection dropped during streaming (e.g. phone screen went to sleep)
      if (!conn || !conn.open || (conn.dataChannel && conn.dataChannel.readyState !== 'open')) {
        console.warn('[LS:Transfer] WebRTC dropped at offset:', fileOffset);
        if (currentTransferSession) {
          currentTransferSession.fileOffset = fileOffset;
          currentTransferSession.state = 'paused';
        }
        if (progressSpeed) progressSpeed.textContent = '0.0 MB/s';
        if (progressEta) progressEta.textContent = '⚠️ Stream paused (Screen locked). Unlock phone to resume.';
        window.LS.ui.showToast(`Transfer paused at ${window.LS.ui.formatBytes(fileOffset)}`);
        if (btnResumeTransfer) btnResumeTransfer.style.display = 'inline-flex';

        const targetPeerId = (currentTransferSession && currentTransferSession.targetPeerId) || conn?.peer;

        // PAUSE WAIT LOOP: Wait here without terminating the transfer session!
        while (!transferCancelled) {
          const peerConnections = window.LS.p2p.getPeerConnections();
          const activeConn = peerConnections[targetPeerId]?.conn;
          if (activeConn && activeConn.open && activeConn.dataChannel && activeConn.dataChannel.readyState === 'open') {
            conn = activeConn;
            break;
          }

          if (document.visibilityState === 'visible') {
            window.LS.p2p.ensureSignalingAlive();
            const reconnectedConn = await window.LS.p2p.waitForAutoReconnect(targetPeerId, 4);
            if (reconnectedConn && reconnectedConn.open && reconnectedConn.dataChannel && reconnectedConn.dataChannel.readyState === 'open') {
              conn = reconnectedConn;
              break;
            }
          }

          await new Promise(r => setTimeout(r, 1200));
        }

        if (transferCancelled) break;

        console.log('[LS:Transfer] Resumed streaming from offset:', fileOffset);
        window.LS.ui.showToast(`Resumed from ${window.LS.ui.formatBytes(fileOffset)}!`);
        if (progressEta) progressEta.textContent = 'Reconnected! Resuming stream...';
        if (btnResumeTransfer) btnResumeTransfer.style.display = 'none';
        if (currentTransferSession) currentTransferSession.state = 'active';

        try {
          conn.send(JSON.stringify({
            type: 'file-meta',
            transferId: transferId,
            name: file.name,
            size: file.size,
            mime: mimeType,
            startOffset: fileOffset,
            currentIdx: currentIdx,
            totalFiles: totalFiles
          }));
          await new Promise(r => setTimeout(r, 50));
        } catch (e) {
          console.warn('[LS:Transfer] Failed to send resume file-meta:', e);
        }

        continue;
      }

      // Read 1 MB block from disk once (16x reduction in flash I/O)
      const blockEnd = Math.min(fileOffset + BLOCK_SIZE, file.size);
      const blockSlice = file.slice(fileOffset, blockEnd);
      const blockBuffer = await blockSlice.arrayBuffer();

      let blockOffset = 0;
      while (blockOffset < blockBuffer.byteLength) {
        if (transferCancelled || !conn || !conn.open) break;

        // Optimal SCTP backpressure control (prevents buffer bloat & CWND collapse)
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > cfg.BACKPRESSURE_LIMIT) {
          await new Promise(resolve => {
            const checkAndResolve = () => {
              if (!conn.dataChannel || conn.dataChannel.bufferedAmount <= (cfg.BACKPRESSURE_LOW || 256 * 1024)) {
                cleanup();
                resolve();
              }
            };
            const onLow = () => checkAndResolve();
            const interval = setInterval(checkAndResolve, 10);
            const cleanup = () => {
              clearInterval(interval);
              if (conn.dataChannel) {
                conn.dataChannel.removeEventListener('bufferedamountlow', onLow);
              }
            };
            if (conn.dataChannel) {
              conn.dataChannel.addEventListener('bufferedamountlow', onLow);
            }
            checkAndResolve();
          });
        }

        const sendLen = Math.min(CHUNK_SIZE, blockBuffer.byteLength - blockOffset);
        // Zero-copy chunk view directly into existing blockBuffer (no garbage collection freezes)
        const chunkBuf = new Uint8Array(blockBuffer, blockOffset, sendLen);

        conn.send(chunkBuf);

        blockOffset += sendLen;
        fileOffset += sendLen;

        const now = Date.now();
        const inFlight = (conn.dataChannel ? conn.dataChannel.bufferedAmount : 0);
        const deliveredBytes = Math.max(0, fileOffset - inFlight);

        const timeDiff = (now - lastSampleTime) / 1000;
        if (timeDiff >= 0.5) {
          const bytesDiff = deliveredBytes - lastSampleBytes;
          currentSpeedMBps = (bytesDiff / timeDiff) / (1024 * 1024);
          lastSampleTime = now;
          lastSampleBytes = deliveredBytes;
        }

        if (now - lastSenderUiUpdate > 120 || fileOffset >= file.size) {
          lastSenderUiUpdate = now;
          const percent = Math.min(99, Math.round((deliveredBytes / file.size) * 100));
          if (progressBarFill) progressBarFill.style.width = percent + '%';
          if (progressPercent) progressPercent.textContent = percent + '%';

          const speedDisplay = currentSpeedMBps > 0 ? currentSpeedMBps.toFixed(1) : ((deliveredBytes / ((now - startTime) / 1000 || 1)) / (1024 * 1024)).toFixed(1);
          if (progressTransferInfo) progressTransferInfo.textContent = `${window.LS.ui.formatBytes(deliveredBytes)} / ${window.LS.ui.formatBytes(file.size)}`;
          if (progressSpeed) progressSpeed.textContent = `${speedDisplay} MB/s`;

          const remainingBytes = file.size - deliveredBytes;
          const currentSpeedBps = (parseFloat(speedDisplay) || 1) * 1024 * 1024;
          const etaSec = currentSpeedBps > 0 ? Math.ceil(remainingBytes / currentSpeedBps) : 0;
          if (progressEta) progressEta.textContent = etaSec > 0 ? `${etaSec}s remaining` : 'Flushing queue...';
        }
      }
    }

    if (transferCancelled) {
      if (uploadCard) uploadCard.style.display = 'none';
      if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
      isTransferring = false;
      window.LS.power.releaseWakeLock();
      window.LS.power.stopSilentAudio();
      return;
    }

    // Step 3: DRAIN BUFFER - wait until bufferedAmount is drained or threshold/timeout reached
    if (fileOffset >= file.size) {
      const drainStartTime = Date.now();
      const MAX_DRAIN_MS = 3500; // max 3.5 seconds drain wait
      const DRAIN_THRESHOLD = 64 * 1024; // If under 64 KB, it's virtually flushed

      while (!transferCancelled && conn && (conn.open || (conn.dataChannel && conn.dataChannel.readyState === 'open'))) {
        const inFlight = (conn.dataChannel ? conn.dataChannel.bufferedAmount : 0);
        if (inFlight <= DRAIN_THRESHOLD || (Date.now() - drainStartTime > MAX_DRAIN_MS)) {
          break;
        }
        const delivered = Math.max(0, file.size - inFlight);
        const percent = Math.min(99, Math.round((delivered / file.size) * 100));
        if (progressBarFill) progressBarFill.style.width = percent + '%';
        if (progressPercent) progressPercent.textContent = percent + '%';
        if (progressTransferInfo) progressTransferInfo.textContent = `${window.LS.ui.formatBytes(delivered)} / ${window.LS.ui.formatBytes(file.size)}`;
        if (progressEta) progressEta.textContent = 'Flushing network queue to PC...';
        await new Promise(r => setTimeout(r, 60));
      }

      if (transferCancelled) return;

      // Step 4: Send file-complete packet
      try {
        conn.send(JSON.stringify({
          type: 'file-complete',
          transferId: transferId,
          name: file.name,
          currentIdx: currentIdx,
          totalFiles: totalFiles
        }));
      } catch (e) {
        console.warn('[LS:Transfer] Failed to send file-complete:', e);
      }

      // Step 5: Wait for receiver confirmation ACK
      if (progressEta) progressEta.textContent = 'Verifying on PC...';
      await new Promise(resolve => {
        const t = setTimeout(() => resolve(), 3000);
        conn._ackResolver = (ackId) => {
          if (ackId === transferId) {
            clearTimeout(t);
            resolve();
          }
        };
      });

      // Step 6: Mark 100% complete
      if (progressBarFill) progressBarFill.style.width = '100%';
      if (progressPercent) progressPercent.textContent = '100%';
      if (progressTransferInfo) progressTransferInfo.textContent = `${window.LS.ui.formatBytes(file.size)} / ${window.LS.ui.formatBytes(file.size)}`;
      if (progressEta) progressEta.textContent = (totalFiles > 1 && currentIdx < totalFiles) ? `(${currentIdx}/${totalFiles}) Done! Sending next file...` : 'Completed!';
      if (currentTransferSession) {
        currentTransferSession.state = 'completed';
      }
      if (btnResumeTransfer) btnResumeTransfer.style.display = 'none';
      await new Promise(r => setTimeout(r, 150));
    }

    if (!totalFiles || currentIdx >= totalFiles || transferCancelled) {
      isTransferring = false;
      window.LS.power.releaseWakeLock();
      window.LS.power.stopSilentAudio();
      if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
    }
  }

  // Helper: Finalize a fully received file, build Blob, add to list, send ACK, and advance queue
  function finalizeReceivedFile(conn, tId, currentIdx, totalFiles) {
    const active = activeIncomingTransfers[tId];
    if (!active || active.finalized || !active.chunks || active.chunks.length === 0) return;
    active.finalized = true;

    if (active._autoFinalizeTimer) {
      clearTimeout(active._autoFinalizeTimer);
      active._autoFinalizeTimer = null;
    }

    const cfg = window.LS.config;
    const mimeType = cfg.getMimeType(active.meta.name, active.meta.mime);
    const blob = new Blob(active.chunks, { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const ext = active.meta.name.split('.').pop().toLowerCase();

    window.LS.app.addReceivedFile({
      name: active.meta.name,
      size: blob.size > 0 ? blob.size : active.meta.size,
      mtime: Math.floor(Date.now() / 1000),
      ext,
      mime: mimeType,
      isImage: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg'].includes(ext),
      isVideo: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext),
      isAudio: ['mp3', 'm4a', 'wav', 'aac'].includes(ext),
      isDoc: true,
      blobUrl: objectUrl,
      blobObj: blob,
      isSent: false,
      isReceived: true
    });

    window.LS.ui.playChime();
    window.LS.ui.showToast(`Received ${active.meta.name}!`);

    // Send confirmation ACK back to sender immediately
    if (conn && (conn.open || (conn.dataChannel && conn.dataChannel.readyState === 'open'))) {
      try {
        conn.send(JSON.stringify({
          type: 'file-ack',
          transferId: tId,
          name: active.meta.name,
          status: 'ok'
        }));
      } catch (e) {
        console.warn('[LS:Transfer] Failed to send file-ack:', e);
      }
    }

    // Free memory immediately
    active.chunks = [];
    delete activeIncomingTransfers[tId];
    if (incomingTransferId === tId) {
      incomingTransferId = null;
    }

    const cIdx = currentIdx || active.meta.currentIdx || 1;
    const tFiles = totalFiles || active.meta.totalFiles || 1;
    const isLastFile = !tFiles || cIdx >= tFiles;

    if (isLastFile) {
      if (progressBarFill) progressBarFill.style.width = '100%';
      if (progressPercent) progressPercent.textContent = '100%';
      if (progressEta) progressEta.textContent = (tFiles > 1) ? `All ${tFiles} files received!` : 'File received!';
      if (progressSpeed) progressSpeed.textContent = '0.0 MB/s';
      if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
      window.LS.power.releaseWakeLock();

      if (tFiles > 1) {
        showTransferCompleteActions(tFiles);
      } else {
        setTimeout(() => {
          if (!isTransferring && uploadCard) uploadCard.style.display = 'none';
        }, 1800);
      }
    } else {
      if (progressBarFill) progressBarFill.style.width = '100%';
      if (progressPercent) progressPercent.textContent = '100%';
      if (progressEta) progressEta.textContent = `(${cIdx}/${tFiles}) Saved! Waiting for next file...`;
    }
  }

  // 3. Receiver Pipeline & Incoming Packet Handling
  function handleIncomingData(conn, data) {
    const cfg = window.LS.config;

    // A. JSON Control Packets
    if (typeof data === 'string') {
      let packet = null;
      try {
        packet = JSON.parse(data);
      } catch (e) {
        return;
      }

      // 1. Resume Query
      if (packet && packet.type === 'file-resume-query') {
        const tId = packet.transferId;
        const existing = activeIncomingTransfers[tId];
        const haveBytes = existing ? existing.receivedBytes : 0;
        conn.send(JSON.stringify({
          type: 'file-resume-info',
          transferId: tId,
          receivedBytes: haveBytes
        }));
        return;
      }

      // 2. Resume Info
      if (packet && packet.type === 'file-resume-info') {
        if (conn._resumeResolver) {
          conn._resumeResolver(packet.receivedBytes || 0);
        }
        return;
      }

      // 3. Metadata Packet
      if (packet && packet.type === 'file-meta') {
        const tId = packet.transferId || (packet.name + '_' + packet.size);
        incomingTransferId = tId;
        if (packet.currentIdx === 1 || !packet.currentIdx) {
          if (transferCompleteActions) transferCompleteActions.style.display = 'none';
        }

        if (!activeIncomingTransfers[tId] || packet.startOffset === 0) {
          activeIncomingTransfers[tId] = {
            meta: packet,
            chunks: [],
            receivedBytes: 0,
            startTime: Date.now(),
            lastSampleTime: Date.now(),
            lastSampleBytes: 0,
            currentSpeedMBps: 0,
            lastUiTime: 0,
            lastChunkTime: Date.now()
          };
        } else {
          activeIncomingTransfers[tId].meta = packet;
          activeIncomingTransfers[tId].lastChunkTime = Date.now();
          activeIncomingTransfers[tId].lastSampleTime = Date.now();
          activeIncomingTransfers[tId].lastSampleBytes = activeIncomingTransfers[tId].receivedBytes;
        }

        const cur = activeIncomingTransfers[tId];
        window.LS.power.acquireWakeLock();
        if (uploadCard) uploadCard.style.display = 'flex';
        if (progressWakeLockHint) progressWakeLockHint.style.display = 'block';

        const countPrefix = (packet.totalFiles && packet.totalFiles > 1) ? `(${packet.currentIdx}/${packet.totalFiles}) ` : '';
        if (progressFileName) progressFileName.textContent = `${countPrefix}Receiving: ${packet.name}`;
        const pct = Math.min(99, Math.round((cur.receivedBytes / packet.size) * 100));
        if (progressBarFill) progressBarFill.style.width = pct + '%';
        if (progressPercent) progressPercent.textContent = pct + '%';
        if (progressTransferInfo) progressTransferInfo.textContent = `${window.LS.ui.formatBytes(cur.receivedBytes)} / ${window.LS.ui.formatBytes(packet.size)}`;
        if (progressEta) progressEta.textContent = cur.receivedBytes > 0 ? `Resuming from ${window.LS.ui.formatBytes(cur.receivedBytes)} (${pct}%)...` : 'Calculating...';
        return;
      }

      // 4. File Complete Packet
      if (packet && packet.type === 'file-complete') {
        const tId = packet.transferId || incomingTransferId;
        finalizeReceivedFile(conn, tId, packet.currentIdx, packet.totalFiles);
        return;
      }

      // 5. File ACK
      if (packet && packet.type === 'file-ack') {
        if (conn._ackResolver) {
          conn._ackResolver(packet.transferId);
        }
        return;
      }

      // 6. File Cancel
      if (packet && packet.type === 'file-cancel') {
        cancelCurrentTransfer(false);
        return;
      }
    }

    // B. Raw Binary Chunks (ArrayBuffer)
    if (incomingTransferId && activeIncomingTransfers[incomingTransferId]) {
      const tId = incomingTransferId;
      const active = activeIncomingTransfers[tId];
      active.chunks.push(data);
      const chunkSize = data.byteLength || data.size || (data.buffer ? data.buffer.byteLength : 0);
      active.receivedBytes += chunkSize;
      active.lastChunkTime = Date.now();

      // Auto-finalize guard: if 100% of bytes received, schedule auto-finalize in case file-complete packet is dropped/delayed
      if (active.receivedBytes >= active.meta.size && !active._autoFinalizeTimer && !active.finalized) {
        active._autoFinalizeTimer = setTimeout(() => {
          if (activeIncomingTransfers[tId] && !activeIncomingTransfers[tId].finalized) {
            console.log('[LS:Transfer] Auto-finalizing fully received file:', active.meta.name);
            finalizeReceivedFile(conn, tId);
          }
        }, 2500);
      }

      const now = Date.now();
      const timeDiff = (now - active.lastSampleTime) / 1000;
      if (timeDiff >= 0.5) {
        const bytesDiff = active.receivedBytes - active.lastSampleBytes;
        active.currentSpeedMBps = (bytesDiff / timeDiff) / (1024 * 1024);
        active.lastSampleTime = now;
        active.lastSampleBytes = active.receivedBytes;
      }

      if (now - (active.lastUiTime || 0) > 120 || active.receivedBytes >= active.meta.size) {
        active.lastUiTime = now;
        const percent = Math.min(100, Math.round((active.receivedBytes / active.meta.size) * 100));
        if (progressBarFill) progressBarFill.style.width = percent + '%';
        if (progressPercent) progressPercent.textContent = percent + '%';

        const countPrefix = (active.meta.totalFiles && active.meta.totalFiles > 1) ? `(${active.meta.currentIdx}/${active.meta.totalFiles}) ` : '';
        if (progressFileName) progressFileName.textContent = `${countPrefix}Receiving: ${active.meta.name}`;
        const speedDisplay = active.currentSpeedMBps > 0 ? active.currentSpeedMBps.toFixed(1) : ((active.receivedBytes / ((now - active.startTime) / 1000 || 1)) / (1024 * 1024)).toFixed(1);
        if (progressTransferInfo) progressTransferInfo.textContent = `${window.LS.ui.formatBytes(active.receivedBytes)} / ${window.LS.ui.formatBytes(active.meta.size)}`;
        if (progressSpeed) progressSpeed.textContent = `${speedDisplay} MB/s`;

        const remainingBytes = active.meta.size - active.receivedBytes;
        const currentSpeedBps = (parseFloat(speedDisplay) || 1) * 1024 * 1024;
        const etaSec = currentSpeedBps > 0 ? Math.ceil(remainingBytes / currentSpeedBps) : 0;
        if (progressEta) progressEta.textContent = etaSec > 0 ? `${etaSec}s remaining` : 'Finalizing on PC...';
      }
    }
  }

  function handleConnectionClosed(peerId) {
    if (incomingTransferId && activeIncomingTransfers[incomingTransferId]) {
      if (progressEta) progressEta.textContent = 'Connection paused. Ready to resume when reconnected.';
    }
  }

  // 4. Cancel Transfer (Bidirectional)
  function cancelCurrentTransfer(initiatedBySelf = true) {
    transferCancelled = true;
    isTransferring = false;
    currentTransferSession = null;
    window.LS.power.releaseWakeLock();
    window.LS.power.stopSilentAudio();

    if (incomingTransferId && activeIncomingTransfers[incomingTransferId]) {
      delete activeIncomingTransfers[incomingTransferId];
      incomingTransferId = null;
    }

    if (initiatedBySelf) {
      const peerConnections = window.LS.p2p.getPeerConnections();
      Object.values(peerConnections).forEach(p => {
        if (p.conn && p.conn.open) {
          try {
            p.conn.send(JSON.stringify({ type: 'file-cancel' }));
          } catch (e) {}
        }
      });
      window.LS.ui.showToast('Transfer cancelled');
    } else {
      window.LS.ui.showToast('Transfer cancelled by remote device');
    }

    if (uploadCard) uploadCard.style.display = 'none';
    if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
    if (btnResumeTransfer) btnResumeTransfer.style.display = 'none';
    if (transferCompleteActions) transferCompleteActions.style.display = 'none';
  }

  // Precomputed CRC-32 table for zero-dependency ZIP generation
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c >>> 0;
  }

  async function calculateBlobCrc32(blob) {
    let crc = 0xFFFFFFFF;
    try {
      if (typeof blob.stream === 'function') {
        const reader = blob.stream().getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let i = 0; i < value.length; i++) {
            crc = (crc >>> 8) ^ crcTable[(crc ^ value[i]) & 0xFF];
          }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
      }
    } catch (e) {}

    const buf = new Uint8Array(await blob.arrayBuffer());
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Pure Client-side ZIP Blob Generator (Zero external dependencies)
  async function createZipBlob(fileEntries) {
    const enc = new TextEncoder();
    const d = new Date();
    const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

    const parts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of fileEntries) {
      const name = entry.name || 'file';
      const blob = entry.blob;
      const nameBytes = enc.encode(name);
      const size = blob.size;
      const crc = await calculateBlobCrc32(blob);

      // Local file header (30 bytes + name length)
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
      lv.setUint16(8, 0, true); // Stored (no compression)
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      parts.push(localHeader);
      parts.push(blob);

      // Central directory header (46 bytes + name length)
      const cdHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cdHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); // UTF-8
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cdHeader.set(nameBytes, 46);

      centralParts.push(cdHeader);
      offset += localHeader.length + size;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const c of centralParts) cdSize += c.length;

    // End of central directory record (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, fileEntries.length, true);
    ev.setUint16(10, fileEntries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...parts, ...centralParts, eocd], { type: 'application/zip' });
  }

  // Resolve file object/blob from local store or server preview
  async function resolveFileBlob(fileItem) {
    if (!fileItem) throw new Error('File item is null');
    if (fileItem.blobObj instanceof Blob) return fileItem.blobObj;
    if (fileItem.blobUrl) {
      try {
        const res = await fetch(fileItem.blobUrl);
        if (res.ok) return await res.blob();
      } catch (e) {}
    }
    const previewUrl = `/api/preview?file=${encodeURIComponent(fileItem.name)}`;
    const res = await fetch(previewUrl);
    if (!res.ok) throw new Error(`Failed to load ${fileItem.name}`);
    return await res.blob();
  }

  // 5. Save Single File To Gallery (Web Share API for iOS & Android)
  async function saveToGallery(fileName) {
    window.LS.ui.showToast('Preparing for Photos Gallery...');
    let blob = null;
    let mime = 'image/jpeg';

    const p2pFile = window.LS.app.findFile(fileName);
    if (p2pFile && p2pFile.blobObj) {
      blob = p2pFile.blobObj;
      mime = p2pFile.mime || blob.type;
    } else {
      const previewUrl = `/api/preview?file=${encodeURIComponent(fileName)}`;
      try {
        const res = await fetch(previewUrl);
        if (!res.ok) throw new Error('Download failed');
        blob = await res.blob();
        mime = blob.type;
      } catch (e) {
        window.LS.ui.showToast('Failed to load file');
        return;
      }
    }

    const ext = fileName.split('.').pop().toLowerCase();
    if (!mime || mime === 'application/octet-stream') {
      if (['jpg', 'jpeg'].includes(ext)) mime = 'image/jpeg';
      else if (ext === 'png') mime = 'image/png';
      else if (ext === 'mov') mime = 'video/quicktime';
      else if (ext === 'mp4') mime = 'video/mp4';
      else if (ext === 'heic') mime = 'image/heic';
      else if (ext === 'webp') mime = 'image/webp';
    }

    try {
      const shareFile = new File([blob], fileName, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [shareFile] })) {
        await navigator.share({
          files: [shareFile],
          title: fileName
        });
        window.LS.ui.showToast('Shared! Tap "Save Image/Video" in the iOS sheet.');
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        window.LS.ui.showToast('Downloaded to Files!');
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        window.LS.ui.showToast('Save failed, download used instead');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
      }
    }
  }

  // Helper to extract strictly received files (excluding files sent by this device)
  function getReceivedFilesList(targetFiles) {
    if (Array.isArray(targetFiles) && targetFiles.length > 0) {
      const received = targetFiles.filter(f => !f.isSent);
      return received.length > 0 ? received : targetFiles;
    }
    const all = (window.LS.app && window.LS.app.getAllFiles) ? window.LS.app.getAllFiles() : [];
    const received = all.filter(f => !f.isSent);
    // If received files exist, strictly return ONLY received files
    if (received.length > 0) return received;
    // Fallback to all only if zero received files exist
    return all;
  }

  // 6. 1-Click Save Received Photos/Videos to Mobile Gallery (iOS & Android)
  async function saveAllToGallery(targetFiles) {
    const candidateFiles = getReceivedFilesList(targetFiles);
    const mediaFiles = candidateFiles.filter(f => f.isImage || f.isVideo || ['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif', 'mov', 'mp4', 'm4v'].includes((f.name.split('.').pop() || '').toLowerCase()));

    if (mediaFiles.length === 0) {
      window.LS.ui.showToast('No received photos or videos to save to Gallery.');
      return;
    }

    window.LS.ui.showToast(`Preparing ${mediaFiles.length} received photo/video${mediaFiles.length === 1 ? '' : 's'} for Gallery...`);

    const fileObjects = [];
    for (const item of mediaFiles) {
      try {
        const blob = await resolveFileBlob(item);
        const ext = (item.name.split('.').pop() || '').toLowerCase();
        let mime = item.mime || blob.type;
        if (!mime || mime === 'application/octet-stream') {
          if (['jpg', 'jpeg'].includes(ext)) mime = 'image/jpeg';
          else if (ext === 'png') mime = 'image/png';
          else if (ext === 'heic') mime = 'image/heic';
          else if (ext === 'webp') mime = 'image/webp';
          else if (ext === 'mov') mime = 'video/quicktime';
          else if (ext === 'mp4') mime = 'video/mp4';
        }
        fileObjects.push(new File([blob], item.name, { type: mime }));
      } catch (err) {
        console.warn('[LS:Transfer] Failed to prepare file for Gallery:', item.name, err);
      }
    }

    if (fileObjects.length === 0) {
      window.LS.ui.showToast('Could not load media files for Gallery.');
      return;
    }

    // Try multi-file Web Share API
    if (navigator.canShare && navigator.canShare({ files: fileObjects })) {
      try {
        await navigator.share({
          files: fileObjects,
          title: `Save ${fileObjects.length} Photos & Videos`
        });
        window.LS.ui.showToast('Tap "Save Images / Videos" in the share sheet!');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.warn('[LS:Transfer] Multi-share error, falling back:', err);
      }
    }

    // If multi-share unsupported, download ZIP
    window.LS.ui.showToast('Direct gallery save unavailable on this browser. Downloading ZIP...');
    await downloadAllAsZip(mediaFiles);
  }

  // 7. Direct save to user's default Downloads folder without File System Access API restrictions
  async function saveAllDirectlyToDownloads(targetFiles) {
    const files = getReceivedFilesList(targetFiles);
    if (!files || files.length === 0) {
      window.LS.ui.showToast('No received files to save.');
      return;
    }

    window.LS.ui.showToast(`Saving ${files.length} file${files.length === 1 ? '' : 's'} directly to Downloads...`);

    let saved = 0;
    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      try {
        const blob = await resolveFileBlob(item);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = item.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        saved++;
        if (i < files.length - 1) {
          await new Promise(r => setTimeout(r, 180));
        }
      } catch (err) {
        console.warn('[LS:Transfer] Failed to download file:', item.name, err);
      }
    }

    window.LS.ui.playChime();
    window.LS.ui.showToast(`Saved ${saved} file${saved === 1 ? '' : 's'} directly to Downloads!`);
  }

  // 8. Save to Custom PC Folder (File System Access API with automatic Downloads fallback)
  async function saveAllToFolder(targetFiles) {
    const files = getReceivedFilesList(targetFiles);
    if (!files || files.length === 0) {
      window.LS.ui.showToast('No received files available to save.');
      return;
    }

    // Check if File System Access API is supported (Desktop Chrome, Edge, Brave, Opera)
    if ('showDirectoryPicker' in window) {
      try {
        window.LS.ui.showToast('Select destination folder (Tip: Pick any folder, or a subfolder inside Downloads)...');
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        window.LS.ui.showToast(`Saving ${files.length} received file${files.length === 1 ? '' : 's'} to folder...`);

        let savedCount = 0;
        for (const item of files) {
          try {
            const blob = await resolveFileBlob(item);
            const fileHandle = await dirHandle.getFileHandle(item.name, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            savedCount++;
          } catch (fileErr) {
            console.warn('[LS:Transfer] Error saving file to directory:', item.name, fileErr);
          }
        }

        window.LS.ui.playChime();
        window.LS.ui.showToast(`Saved ${savedCount} received file${savedCount === 1 ? '' : 's'} directly to PC folder!`);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.warn('[LS:Transfer] Directory picker blocked, falling back to direct Downloads save:', err);
        // Automatic graceful fallback when user picks root Downloads or restricted folders:
        window.LS.ui.showToast('Browser restricted that folder. Saving files directly to Downloads instead...');
        await saveAllDirectlyToDownloads(files);
        return;
      }
    }

    // Fallback for Safari, Firefox, or Mobile
    window.LS.ui.showToast('Saving files directly to Downloads...');
    await saveAllDirectlyToDownloads(files);
  }

  // 8. 1-Click Download Received Files as a single ZIP archive
  async function downloadAllAsZip(targetFiles) {
    const files = getReceivedFilesList(targetFiles);
    if (!files || files.length === 0) {
      window.LS.ui.showToast('No received files to package into ZIP.');
      return;
    }

    window.LS.ui.showToast(`Packaging ${files.length} received file${files.length === 1 ? '' : 's'} into ZIP...`);

    const fileEntries = [];
    for (const item of files) {
      try {
        const blob = await resolveFileBlob(item);
        fileEntries.push({ name: item.name, blob });
      } catch (e) {
        console.warn('[LS:Transfer] Failed to resolve file for zip:', item.name, e);
      }
    }

    if (fileEntries.length === 0) {
      window.LS.ui.showToast('Failed to prepare files for ZIP.');
      return;
    }

    try {
      const zipBlob = await createZipBlob(fileEntries);
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const zipName = `LocalShare_Received_${dateStr}_(${fileEntries.length}_files).zip`;

      const a = document.createElement('a');
      a.href = URL.createObjectURL(zipBlob);
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      window.LS.ui.playChime();
      window.LS.ui.showToast(`Downloaded ${zipName}!`);
    } catch (zipErr) {
      console.error('[LS:Transfer] ZIP creation failed:', zipErr);
      window.LS.ui.showToast('Failed to create ZIP archive.');
    }
  }

  // Receiver stream stall monitor
  setInterval(() => {
    if (incomingTransferId && activeIncomingTransfers[incomingTransferId]) {
      const active = activeIncomingTransfers[incomingTransferId];
      if (active.lastChunkTime && (Date.now() - active.lastChunkTime > 5000) && active.receivedBytes < active.meta.size) {
        if (progressSpeed) progressSpeed.textContent = '0.0 MB/s';
        if (progressEta) progressEta.textContent = '⚠️ Stream paused (Phone screen locked). Unlock phone to resume.';
      }
    }
  }, 2000);

  async function attemptAutoResume() {
    if (!currentTransferSession || currentTransferSession.state === 'cancelled') return;
    window.LS.ui.showToast('Waking connection...');
    if (progressEta) progressEta.textContent = 'Reconnecting...';
    window.LS.p2p.ensureSignalingAlive();
    window.LS.discovery.broadcastPresence('ping');
    const targetPeerId = currentTransferSession.targetPeerId;
    if (targetPeerId) {
      window.LS.p2p.connectToRemotePeer(targetPeerId);
    }
  }

  window.LS.transfer = {
    sendFiles,
    triggerSendToDevice,
    handleIncomingData,
    handleConnectionClosed,
    cancelCurrentTransfer,
    attemptAutoResume,
    saveToGallery,
    saveAllToGallery,
    saveAllDirectlyToDownloads,
    saveAllToFolder,
    downloadAllAsZip,
    isCancelled,
    getSession
  };

})(window);
