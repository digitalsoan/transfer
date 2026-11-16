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

    if (targetId && peerConnections[targetId] && peerConnections[targetId].conn && peerConnections[targetId].conn.open) {
      targets = [peerConnections[targetId]];
    } else {
      targets = Object.values(peerConnections).filter(p => p.conn && p.conn.open);
    }

    if (targets.length === 0) {
      const fallbackPeerId = targetId || Object.values(window.LS.discovery.getDiscoveredDevices())[0]?.peerId;
      if (fallbackPeerId && window.LS.p2p.isReady()) {
        window.LS.ui.showToast("Connecting to friend device...");
        window.LS.p2p.tryAutoConnectPeer(fallbackPeerId, true);
        const reconnectedConn = await window.LS.p2p.waitForAutoReconnect(fallbackPeerId, 8);
        if (reconnectedConn && reconnectedConn.open) {
          targets = [peerConnections[fallbackPeerId] || { conn: reconnectedConn }];
        }
      }
    }

    if (targets.length === 0) {
      window.LS.ui.showToast("Waiting for friend device to connect! Open page on iPhone.");
      return;
    }

    transferCancelled = false;
    isTransferring = true;
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
      isTransferring = false;
      window.LS.power.releaseWakeLock();
      window.LS.power.stopSilentAudio();
      return;
    }

    if (uploadCard) uploadCard.style.display = 'none';
    if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
    isTransferring = false;
    window.LS.power.releaseWakeLock();
    window.LS.power.stopSilentAudio();
    window.LS.ui.playChime();
    window.LS.ui.showToast('All files sent successfully!');
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
        conn.dataChannel.bufferedAmountLowThreshold = 1024 * 1024; // 1 MB
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

        // Backpressure event-driven throttle
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > cfg.BACKPRESSURE_LIMIT) {
          await new Promise(resolve => {
            const onLow = () => {
              conn.dataChannel.removeEventListener('bufferedamountlow', onLow);
              resolve();
            };
            conn.dataChannel.addEventListener('bufferedamountlow', onLow);
            setTimeout(() => {
              conn.dataChannel.removeEventListener('bufferedamountlow', onLow);
              resolve();
            }, 10);
          });
        }

        const sendLen = Math.min(CHUNK_SIZE, blockBuffer.byteLength - blockOffset);
        const chunkBuf = blockBuffer.slice(blockOffset, blockOffset + sendLen);

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

    // Step 3: DRAIN BUFFER - wait until bufferedAmount is 0 before claiming 100%
    if (fileOffset >= file.size) {
      while (!transferCancelled && conn && conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 0) {
        const inFlight = conn.dataChannel.bufferedAmount;
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
      conn.send(JSON.stringify({
        type: 'file-complete',
        transferId: transferId,
        name: file.name,
        currentIdx: currentIdx,
        totalFiles: totalFiles
      }));

      // Step 5: Wait for receiver confirmation ACK
      if (progressEta) progressEta.textContent = 'Verifying on PC...';
      await new Promise(resolve => {
        const t = setTimeout(() => resolve(), 8000);
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
      if (progressEta) progressEta.textContent = (totalFiles > 1 && currentIdx < totalFiles) ? `(${currentIdx}/${totalFiles}) Completed! Next file...` : 'Completed!';
      if (currentTransferSession) {
        currentTransferSession.state = 'completed';
      }
      if (btnResumeTransfer) btnResumeTransfer.style.display = 'none';
      await new Promise(r => setTimeout(r, 200));
    }

    if (!totalFiles || currentIdx >= totalFiles || transferCancelled) {
      isTransferring = false;
      window.LS.power.releaseWakeLock();
      window.LS.power.stopSilentAudio();
      if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
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
        const active = (tId && activeIncomingTransfers[tId]);

        if (active && active.chunks.length > 0) {
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
            blobObj: blob
          });

          window.LS.ui.playChime();
          window.LS.ui.showToast(`Received ${active.meta.name}!`);

          // Send confirmation ACK back to sender
          conn.send(JSON.stringify({
            type: 'file-ack',
            transferId: tId,
            name: active.meta.name,
            status: 'ok'
          }));

          delete activeIncomingTransfers[tId];
          incomingTransferId = null;

          const isLastFile = !packet.totalFiles || packet.currentIdx >= packet.totalFiles;
          if (isLastFile) {
            if (uploadCard) uploadCard.style.display = 'none';
            if (progressWakeLockHint) progressWakeLockHint.style.display = 'none';
            window.LS.power.releaseWakeLock();
          } else {
            if (progressBarFill) progressBarFill.style.width = '100%';
            if (progressPercent) progressPercent.textContent = '100%';
            if (progressEta) progressEta.textContent = `(${packet.currentIdx}/${packet.totalFiles}) Saved! Waiting for next file...`;
          }
        }
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
      const active = activeIncomingTransfers[incomingTransferId];
      active.chunks.push(data);
      const chunkSize = data.byteLength || data.size || (data.buffer ? data.buffer.byteLength : 0);
      active.receivedBytes += chunkSize;
      active.lastChunkTime = Date.now();

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
  }

  // 5. Save To Gallery (Web Share API for iOS & Android)
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
    isCancelled,
    getSession
  };

})(window);
