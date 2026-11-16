/**
 * LocalShare - WebRTC P2P Engine (PeerJS)
 * Manages direct browser-to-browser SCTP DataChannels, auto-pairing, tie-breaker logic,
 * and self-healing signaling revival across network transitions.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  let peer = null;
  const peerConnections = {}; // peerId -> { conn, name, os, type, icon }
  const lastP2pAttempt = {};

  function getPeerConnections() {
    return peerConnections;
  }

  function isPeerConnected(peerId) {
    return !!(peerConnections[peerId] && peerConnections[peerId].conn && peerConnections[peerId].conn.open);
  }

  function isReady() {
    return !!(peer && peer.open);
  }

  function hasActiveConnections() {
    return Object.values(peerConnections).some(p => p.conn && p.conn.open);
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
        // OpenRelay Public TURN servers for symmetric NAT, mobile networks & cross-ISP bypass
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
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
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
    if (!targetPeerId) return;
    const cfg = window.LS.config;

    if (!peer || !peer.open) {
      if (isManual) window.LS.ui.showToast("Waking connection engine... retrying in 2 seconds");
      ensureSignalingAlive();
      setTimeout(() => connectToPeer(targetPeerId, isManual), 1500);
      return;
    }

    if (targetPeerId === cfg.myPeerId) {
      if (isManual) window.LS.ui.showToast("Cannot connect to your own device PIN!");
      return;
    }
    if (isPeerConnected(targetPeerId)) {
      if (isManual) window.LS.ui.showToast("Already connected!");
      return;
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

    if (isManual) {
      setTimeout(() => {
        if (!isPeerConnected(targetPeerId)) {
          window.LS.ui.showToast(`Still connecting to PIN ${pinDigits}... Ensure your friend is online at transfer.digitalsoan.com`);
        }
      }, 10000);
    }
  }

  // 3. Auto-Pairing Throttle
  function tryAutoConnectPeer(targetPeerId, isHighPriority = false) {
    const cfg = window.LS.config;
    if (!peer || !peer.open || !targetPeerId || targetPeerId === cfg.myPeerId) return;
    if (isPeerConnected(targetPeerId)) return;

    const now = Date.now();
    const lastAttempt = lastP2pAttempt[targetPeerId] || 0;
    const minInterval = isHighPriority ? 1200 : 3500;
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

      // Send identity packet to remote peer
      conn.send(JSON.stringify({
        type: 'device-info',
        name: cfg.myDeviceName,
        os: cfg.myDeviceOs,
        type: cfg.myDeviceType,
        icon: cfg.myDeviceIcon,
        pin: cfg.myShortPin
      }));

      const discovered = window.LS.discovery.getDiscoveredDevices();
      const disc = Object.values(discovered).find(d => d.peerId === conn.peer);
      const meta = conn.metadata || {};
      const friendName = (disc && disc.name) || meta.name || 'Remote Device';
      const friendOs = (disc && disc.os) || meta.os || 'Remote';
      const friendType = (disc && disc.type) || meta.type || 'mobile';
      const friendIcon = (disc && disc.icon) || meta.icon || (friendType === 'mobile' ? '📱' : '💻');

      peerConnections[conn.peer] = {
        conn,
        name: friendName,
        os: friendOs,
        type: friendType,
        icon: friendIcon
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
            if (peerConnections[conn.peer]) {
              peerConnections[conn.peer].name = packet.name || 'Friend Device';
              peerConnections[conn.peer].os = packet.os || 'Remote';
              peerConnections[conn.peer].type = packet.type || 'mobile';
              peerConnections[conn.peer].icon = packet.icon || (packet.type === 'mobile' ? '📱' : '💻');
              window.LS.app.notifyDevicesChanged();
            }
            return;
          }
        } catch (e) {}
      }

      // Delegate all transfer control packets and raw binary chunks to transfer manager
      window.LS.transfer.handleIncomingData(conn, data);
    });

    conn.on('close', () => {
      console.log('[LS:P2P] WebRTC DataChannel closed for peer:', conn.peer);
      delete peerConnections[conn.peer];
      window.LS.app.notifyDevicesChanged();
      window.LS.transfer.handleConnectionClosed(conn.peer);
    });

    conn.on('error', (err) => {
      console.warn('[LS:P2P] WebRTC connection error:', err);
      delete peerConnections[conn.peer];
      window.LS.app.notifyDevicesChanged();
    });
  }

  // 5. Signaling Revival (revives dead PeerJS & MQTT sockets after long sleep)
  function ensureSignalingAlive() {
    const isPeerDead = !peer || peer.destroyed || peer.disconnected || !peer.open ||
      (!peer.socket || !peer.socket._ws || peer.socket._ws.readyState !== 1);

    if (isPeerDead) {
      console.log('[LS:P2P] Re-initializing dead PeerJS signaling socket');
      try { if (peer) peer.destroy(); } catch (e) {}
      peer = null;
      initPeer();
    }

    if (!window.LS.discovery.isConnected()) {
      console.log('[LS:P2P] Reconnecting dead MQTT discovery client');
      window.LS.discovery.startNetworkDiscovery();
    }
  }

  // 6. Resilient Auto-Reconnect Engine
  async function waitForAutoReconnect(targetPeerId, maxWaitSec = 20) {
    const cfg = window.LS.config;
    console.log('[LS:P2P] waitForAutoReconnect starting for peer:', targetPeerId);
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitSec * 1000) {
      if (window.LS.transfer.isCancelled()) return null;

      ensureSignalingAlive();

      const existing = peerConnections[targetPeerId];
      if (existing && existing.conn && existing.conn.open && existing.conn.dataChannel && existing.conn.dataChannel.readyState === 'open') {
        return existing.conn;
      }

      if (peer && peer.open && (!existing || !existing.conn || !existing.conn.open)) {
        try {
          const newConn = peer.connect(targetPeerId, {
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
          setupConnectionEvents(newConn);

          const opened = await new Promise(resolve => {
            const to = setTimeout(() => resolve(false), 3000);
            newConn.on('open', () => {
              clearTimeout(to);
              resolve(true);
            });
            newConn.on('error', () => {
              clearTimeout(to);
              resolve(false);
            });
          });

          if (opened && newConn.open && newConn.dataChannel && newConn.dataChannel.readyState === 'open') {
            return newConn;
          }
        } catch (e) {
          console.warn('[LS:P2P] Auto-reconnect attempt error:', e);
        }
      }

      await new Promise(r => setTimeout(r, 1000));
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
    isPeerConnected,
    hasActiveConnections,
    isReady
  };

})(window);
