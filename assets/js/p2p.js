/**
 * LocalShare - WebRTC P2P Engine (PeerJS)
 * Manages direct browser-to-browser SCTP DataChannels, auto-pairing, tie-breaker logic,
 * and self-healing signaling revival across network transitions.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  let peer = null;
  const peerConnections = {}; // peerId -> { conn, name, os, type, icon, pin }
  const lastP2pAttempt = {};
  const activeConnectPromises = {}; // peerId -> Promise

  function getPeerConnections() {
    return peerConnections;
  }

  function isPeerConnected(peerId) {
    const p = peerConnections[peerId];
    if (!p || !p.conn) return false;
    const dc = p.conn.dataChannel;
    return !!(p.conn.open || (dc && dc.readyState === 'open'));
  }

  function isReady() {
    return !!(peer && !peer.destroyed && !peer.disconnected && peer.open);
  }

  function hasActiveConnections() {
    return Object.values(peerConnections).some(p => p.conn && (p.conn.open || (p.conn.dataChannel && p.conn.dataChannel.readyState === 'open')));
  }

  // 1. PeerJS Lifecycle
  function initPeer() {
    if (peer) return;
    const cfg = window.LS.config;

    try {
      const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        { urls: 'stun:stun.services.mozilla.com:3478' },
        { urls: 'stun:stun.nextcloud.com:443' },
        // High-speed UDP TURN fallback servers (without throttled TCP relay)
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turns:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ];

      peer = new Peer(cfg.myPeerId, {
        debug: 1,
        config: {
          iceServers,
          iceCandidatePoolSize: 10
        }
      });

      peer.on('open', (id) => {
        console.log('[LS:P2P] PeerJS signaling connected with ID:', id);
        const myRoomCode = document.getElementById('myRoomCode');
        if (myRoomCode) myRoomCode.textContent = cfg.myShortPin;

        // Auto-join if URL hash has invite PIN (e.g. #4821)
        const hash = window.location.hash.replace('#', '').trim();
        const joinRoomInput = document.getElementById('joinRoomInput');
        if (hash && hash !== cfg.myShortPin && /^\d{4,6}$/.test(hash)) {
          if (joinRoomInput) joinRoomInput.value = hash;
          connectToPeer('dsoan_' + hash, true);
        }

        // Trigger discovery
        window.LS.discovery.detectPublicNetwork();

        // Proactively connect to devices discovered while PeerJS was booting
        const discovered = window.LS.discovery.getDiscoveredDevices();
        Object.values(discovered).forEach(dev => {
          if (dev.peerId && dev.peerId !== cfg.myPeerId) {
            tryAutoConnectPeer(dev.peerId, false);
          }
        });
      });

      peer.on('connection', (conn) => {
        console.log('[LS:P2P] Incoming connection from peer:', conn.peer);
        const existing = peerConnections[conn.peer];
        if (existing && existing.conn && (existing.conn.open || (existing.conn.dataChannel && existing.conn.dataChannel.readyState === 'open'))) {
          console.log('[LS:P2P] Already have open connection with peer:', conn.peer, '- ignoring duplicate');
          try { conn.close(); } catch (e) {}
          return;
        }
        setupConnectionEvents(conn);
      });

      peer.on('error', (err) => {
        console.warn('[LS:P2P] PeerJS error:', err.type, err);
        if (err.type === 'unavailable-id') {
          const newPin = Math.floor(1000 + Math.random() * 9000).toString();
          localStorage.setItem('localshare_pin', newPin);
          window.LS.config.myShortPin = newPin;
          window.LS.config.myPeerId = 'dsoan_' + newPin;
          peer = null;
          setTimeout(initPeer, 800);
        }
      });
    } catch (e) {
      console.error('[LS:P2P] PeerJS init error:', e);
    }
  }

  // 2. Outgoing WebRTC Connection
  function connectToPeer(targetPeerId, isManual = false) {
    if (!targetPeerId) return Promise.resolve(null);
    const cfg = window.LS.config;

    if (!peer || !peer.open) {
      if (isManual) window.LS.ui.showToast("Waking connection engine... retrying in 2 seconds");
      ensureSignalingAlive();
      setTimeout(() => connectToPeer(targetPeerId, isManual), 1500);
      return Promise.resolve(null);
    }

    if (targetPeerId === cfg.myPeerId) {
      if (isManual) window.LS.ui.showToast("Cannot connect to your own device PIN!");
      return Promise.resolve(null);
    }
    if (isPeerConnected(targetPeerId)) {
      if (isManual) window.LS.ui.showToast("Already connected!");
      return Promise.resolve(peerConnections[targetPeerId]?.conn || null);
    }

    if (activeConnectPromises[targetPeerId]) {
      return activeConnectPromises[targetPeerId];
    }

    const pinDigits = targetPeerId.replace('dsoan_', '');
    if (isManual) window.LS.ui.showToast(`Connecting to friend PIN ${pinDigits}...`);
    console.log('[LS:P2P] Connecting to remote peer:', targetPeerId);

    const conn = peer.connect(targetPeerId, {
      serialization: 'raw',
      reliable: true,
      metadata: {
        name: cfg.myDeviceName,
        os: cfg.myDeviceOs,
        type: cfg.myDeviceType,
        icon: cfg.myDeviceIcon,
        pin: cfg.myShortPin
      }
    });

    setupConnectionEvents(conn);

    activeConnectPromises[targetPeerId] = new Promise(resolve => {
      const timeout = setTimeout(() => {
        delete activeConnectPromises[targetPeerId];
        resolve(null);
      }, 8000);

      conn.on('open', () => {
        clearTimeout(timeout);
        delete activeConnectPromises[targetPeerId];
        resolve(conn);
      });

      conn.on('close', () => {
        clearTimeout(timeout);
        delete activeConnectPromises[targetPeerId];
        resolve(null);
      });

      conn.on('error', () => {
        clearTimeout(timeout);
        delete activeConnectPromises[targetPeerId];
        resolve(null);
      });
    });

    if (isManual) {
      activeConnectPromises[targetPeerId].then(connectedConn => {
        if (!connectedConn && !isPeerConnected(targetPeerId)) {
          window.LS.ui.showToast(`Still connecting to PIN ${pinDigits}... Ensure your friend is online at transfer.digitalsoan.com`);
        }
      });
    }

    return activeConnectPromises[targetPeerId];
  }

  // 3. Auto-Pairing Throttle
  function tryAutoConnectPeer(targetPeerId, isHighPriority = false) {
    const cfg = window.LS.config;
    if (!peer || !peer.open || !targetPeerId || targetPeerId === cfg.myPeerId) return;
    if (isPeerConnected(targetPeerId)) return;
    if (activeConnectPromises[targetPeerId]) return;

    const now = Date.now();
    const lastAttempt = lastP2pAttempt[targetPeerId] || 0;
    const minInterval = isHighPriority ? 1200 : 4000;
    if (now - lastAttempt < minInterval) return;

    lastP2pAttempt[targetPeerId] = now;
    console.log('[LS:P2P] Auto-connecting to:', targetPeerId, isHighPriority ? '(Priority)' : '(Auto)');
    connectToPeer(targetPeerId, false);
  }

  // 4. Connection Events Setup
  function setupConnectionEvents(conn) {
    const cfg = window.LS.config;

    conn.on('open', () => {
      console.log('[LS:P2P] WebRTC DataChannel open with peer:', conn.peer);

      if (conn.dataChannel) {
        try {
          conn.dataChannel.binaryType = 'arraybuffer';
          conn.dataChannel.bufferedAmountLowThreshold = 256 * 1024;
        } catch (e) {}
      }

      // Send identity packet to remote peer
      conn.send(JSON.stringify({
        type: 'device-info',
        name: cfg.myDeviceName,
        os: cfg.myDeviceOs,
        type: cfg.myDeviceType,
        icon: cfg.myDeviceIcon,
        pin: cfg.myShortPin
      }));

      const discovered = window.LS.discovery && window.LS.discovery.getDiscoveredDevices ? window.LS.discovery.getDiscoveredDevices() : {};
      const disc = Object.values(discovered).find(d => d.peerId === conn.peer);
      const meta = conn.metadata || {};
      const friendName = (disc && disc.name) || meta.name || 'Remote Device';
      const friendOs = (disc && disc.os) || meta.os || 'Remote';
      const friendType = (disc && disc.type) || meta.type || 'mobile';
      const friendIcon = (disc && disc.icon) || meta.icon || (friendType === 'mobile' ? '📱' : '💻');
      const friendPin = (disc && disc.pin) || meta.pin || (conn.peer ? conn.peer.replace('dsoan_', '') : '');

      peerConnections[conn.peer] = {
        conn,
        name: friendName,
        os: friendOs,
        type: friendType,
        icon: friendIcon,
        pin: friendPin
      };

      window.LS.ui.showToast(`Connected to ${friendName}!`);
      window.LS.ui.playChime();
      window.LS.app.notifyDevicesChanged();
    });

    conn.on('data', async (data) => {
      if (!data) return;

      // Handle Device-Info handshake internally
      if (typeof data === 'string') {
        try {
          const packet = JSON.parse(data);
          if (packet && packet.type === 'device-info') {
            if (!peerConnections[conn.peer]) {
              peerConnections[conn.peer] = { conn };
            }
            peerConnections[conn.peer].name = packet.name || peerConnections[conn.peer].name || 'Friend Device';
            peerConnections[conn.peer].os = packet.os || peerConnections[conn.peer].os || 'Remote';
            peerConnections[conn.peer].type = packet.type || peerConnections[conn.peer].type || 'mobile';
            peerConnections[conn.peer].icon = packet.icon || peerConnections[conn.peer].icon || (packet.type === 'mobile' ? '📱' : '💻');
            peerConnections[conn.peer].pin = packet.pin || peerConnections[conn.peer].pin || (conn.peer ? conn.peer.replace('dsoan_', '') : '');
            window.LS.app.notifyDevicesChanged();
            return;
          }
        } catch (e) {}
      }

      // Delegate all transfer control packets and raw binary chunks to transfer manager
      window.LS.transfer.handleIncomingData(conn, data);
    });

    conn.on('close', () => {
      console.log('[LS:P2P] WebRTC DataChannel closed for peer:', conn.peer);
      if (peerConnections[conn.peer] && peerConnections[conn.peer].conn === conn) {
        delete peerConnections[conn.peer];
        window.LS.app.notifyDevicesChanged();
        window.LS.transfer.handleConnectionClosed(conn.peer);
      }
    });

    conn.on('error', (err) => {
      console.warn('[LS:P2P] WebRTC connection error:', err);
      if (peerConnections[conn.peer] && peerConnections[conn.peer].conn === conn) {
        delete peerConnections[conn.peer];
        window.LS.app.notifyDevicesChanged();
      }
    });
  }

  // 5. Signaling Revival (revives dead PeerJS & MQTT sockets without destroying active sessions)
  function ensureSignalingAlive() {
    if (!peer || peer.destroyed) {
      console.log('[LS:P2P] Peer was destroyed or null, re-initializing');
      peer = null;
      initPeer();
      return;
    }

    if (peer.disconnected) {
      console.log('[LS:P2P] Peer disconnected from signaling server, reconnecting...');
      try {
        peer.reconnect();
      } catch (e) {
        console.warn('[LS:P2P] peer.reconnect() error:', e);
      }
    }

    if (window.LS.discovery && !window.LS.discovery.isConnected()) {
      console.log('[LS:P2P] Reconnecting dead MQTT discovery client');
      window.LS.discovery.startNetworkDiscovery();
    }
  }

  // 6. Resilient Auto-Reconnect Engine
  async function waitForAutoReconnect(targetPeerId, maxWaitSec = 8) {
    if (!targetPeerId) return null;
    console.log('[LS:P2P] waitForAutoReconnect starting for peer:', targetPeerId);
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitSec * 1000) {
      if (window.LS.transfer && window.LS.transfer.isCancelled && window.LS.transfer.isCancelled()) return null;

      const existing = peerConnections[targetPeerId];
      if (existing && existing.conn && (existing.conn.open || (existing.conn.dataChannel && existing.conn.dataChannel.readyState === 'open'))) {
        return existing.conn;
      }

      ensureSignalingAlive();

      if (peer && peer.open && !isPeerConnected(targetPeerId)) {
        if (!activeConnectPromises[targetPeerId]) {
          connectToPeer(targetPeerId, false);
        }
        if (activeConnectPromises[targetPeerId]) {
          const res = await activeConnectPromises[targetPeerId];
          if (res && (res.open || (res.dataChannel && res.dataChannel.readyState === 'open'))) {
            return res;
          }
        }
      }

      await new Promise(r => setTimeout(r, 600));
    }

    const finalConn = peerConnections[targetPeerId];
    if (finalConn && finalConn.conn && (finalConn.conn.open || (finalConn.conn.dataChannel && finalConn.conn.dataChannel.readyState === 'open'))) {
      return finalConn.conn;
    }
    return null;
  }

  // 7. Identity Broadcast to Active Peers
  function broadcastIdentityUpdate() {
    const cfg = window.LS.config;
    const packet = JSON.stringify({
      type: 'device-info',
      name: cfg.myDeviceName,
      os: cfg.myDeviceOs,
      type: cfg.myDeviceType,
      icon: cfg.myDeviceIcon,
      pin: cfg.myShortPin
    });

    Object.values(peerConnections).forEach(p => {
      if (p.conn && p.conn.open && p.conn.dataChannel && p.conn.dataChannel.readyState === 'open') {
        try {
          p.conn.send(packet);
        } catch (e) {}
      }
    });

    if (window.LS.discovery) {
      window.LS.discovery.broadcastPresence('ping');
    }
  }

  window.LS.p2p = {
    initPeer,
    initInternetPeer: initPeer,
    connectToPeer,
    connectToRemotePeer: connectToPeer,
    broadcastIdentityUpdate,
    tryAutoConnectPeer,
    ensureSignalingAlive,
    waitForAutoReconnect,
    getPeerConnections,
    getActiveConnections: getPeerConnections,
    isPeerConnected,
    hasActiveConnections,
    isReady
  };

})(window);
