/**
 * LocalShare - Wi-Fi & Network Discovery Module
 * Detects same Wi-Fi peers via zero-configuration MQTT presence broadcasting over public IP room keys.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  let myPublicIp = '127.0.0.1';
  let myNetworkRoom = 'ls_net_default';
  let mqttClient = null;
  let presenceInterval = null;
  const discoveredDevices = {}; // deviceId -> { id, peerId, pin, name, os, type, icon, ip, lastSeen, _firstSeen }

  function getDiscoveredDevices() {
    return discoveredDevices;
  }

  function getMyPublicIp() {
    return myPublicIp;
  }

  // 1. Detect public IP (Grouping Wi-Fi router NAT)
  async function detectPublicNetwork() {
    const cfg = window.LS.config;
    const wifiSsidName = document.getElementById('wifiSsidName');

    if (cfg.isLocalServerHost) {
      setNetworkInfo('127.0.0.1');
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        if (data.ip) {
          setNetworkInfo(data.ip);
          return;
        }
      }
    } catch (e) {
      console.warn('[LS:Discovery] ipify lookup failed, using fallback ipapi...');
    }

    try {
      const res = await fetch('https://ipapi.co/json/');
      if (res.ok) {
        const data = await res.json();
        if (data.ip) {
          setNetworkInfo(data.ip);
          return;
        }
      }
    } catch (e) {}

    // Fallback to random room if offline
    setNetworkInfo('default_lan_' + Math.floor(Math.random() * 100));
  }

  function setNetworkInfo(ip) {
    const cfg = window.LS.config;
    const wifiSsidName = document.getElementById('wifiSsidName');

    myPublicIp = ip;
    myNetworkRoom = 'ls_net_' + myPublicIp.replace(/[^a-zA-Z0-9]/g, '_');
    if (wifiSsidName) {
      wifiSsidName.textContent = cfg.isLocalServerHost ? `Local Wi-Fi (${ip})` : 'Same Wi-Fi Network';
    }
    startNetworkDiscovery();
  }

  // 2. MQTT Discovery Client
  function startNetworkDiscovery() {
    if (typeof Paho === 'undefined' || !Paho.MQTT) {
      console.warn('[LS:Discovery] Paho MQTT library unavailable');
      return;
    }

    const cfg = window.LS.config;
    const clientId = 'ls_' + cfg.myDeviceId + '_' + Math.random().toString(36).substring(2, 6);
    const brokerHost = 'broker.emqx.io';
    const brokerPort = 8084; // Secure WSS
    const brokerPath = '/mqtt';

    try {
      mqttClient = new Paho.MQTT.Client(brokerHost, brokerPort, brokerPath, clientId);

      mqttClient.onConnectionLost = (err) => {
        console.warn('[LS:Discovery] MQTT connection lost:', err.errorMessage);
        setTimeout(startNetworkDiscovery, 4000);
      };

      mqttClient.onMessageArrived = (message) => {
        try {
          const data = JSON.parse(message.payloadString);
          handleNetworkPresenceMessage(data);
        } catch (e) {}
      };

      mqttClient.connect({
        useSSL: true,
        timeout: 6,
        keepAliveInterval: 30,
        cleanSession: true,
        onSuccess: () => {
          const statusText = document.getElementById('statusText');
          if (statusText) statusText.textContent = 'Auto-Discovery Active';
          const topic = 'digitalsoan_transfer/' + myNetworkRoom;
          mqttClient.subscribe(topic, { qos: 0 });

          broadcastPresence('join');

          if (!presenceInterval) {
            presenceInterval = setInterval(() => {
              broadcastPresence('ping');
              pruneStaleDevices();
            }, 2500);
          }
        },
        onFailure: (err) => {
          console.warn('[LS:Discovery] EMQX connect failed, trying HiveMQ fallback...', err);
          tryHiveMqFallback(clientId);
        }
      });
    } catch (e) {
      console.error('[LS:Discovery] MQTT setup error:', e);
    }
  }

  function tryHiveMqFallback(clientId) {
    try {
      mqttClient = new Paho.MQTT.Client('broker.hivemq.com', 8884, '/mqtt', clientId);
      mqttClient.onMessageArrived = (message) => {
        try {
          const data = JSON.parse(message.payloadString);
          handleNetworkPresenceMessage(data);
        } catch (e) {}
      };
      mqttClient.connect({
        useSSL: true,
        timeout: 6,
        cleanSession: true,
        onSuccess: () => {
          const topic = 'digitalsoan_transfer/' + myNetworkRoom;
          mqttClient.subscribe(topic, { qos: 0 });
          broadcastPresence('join');
          if (!presenceInterval) {
            presenceInterval = setInterval(() => {
              broadcastPresence('ping');
              pruneStaleDevices();
            }, 2500);
          }
        }
      });
    } catch (e) {}
  }

  function broadcastPresence(action = 'ping') {
    if (!mqttClient || !mqttClient.isConnected()) return;
    const cfg = window.LS.config;
    const payload = {
      action,
      id: cfg.myDeviceId,
      peerId: cfg.myPeerId,
      pin: cfg.myShortPin,
      name: cfg.myDeviceName,
      os: cfg.myDeviceOs,
      type: cfg.myDeviceType,
      icon: cfg.myDeviceIcon,
      ip: myPublicIp,
      ts: Date.now()
    };
    try {
      const message = new Paho.MQTT.Message(JSON.stringify(payload));
      message.destinationName = 'digitalsoan_transfer/' + myNetworkRoom;
      mqttClient.send(message);
    } catch (e) {}
  }

  function handleNetworkPresenceMessage(data) {
    const cfg = window.LS.config;
    if (!data || !data.id || data.id === cfg.myDeviceId) return;

    if (data.action === 'bye') {
      delete discoveredDevices[data.id];
      window.LS.app.notifyDevicesChanged();
      return;
    }

    const isNew = !discoveredDevices[data.id];
    const now = Date.now();
    discoveredDevices[data.id] = {
      ...data,
      lastSeen: now,
      _firstSeen: (discoveredDevices[data.id] && discoveredDevices[data.id]._firstSeen) || now
    };

    if (isNew) {
      window.LS.ui.playChime();
      window.LS.ui.showToast(`Found ${data.name} on same Wi-Fi!`);
    }

    // Proactive WebRTC connection & self-healing retry if not connected
    if (data.peerId && data.peerId !== cfg.myPeerId) {
      const p2p = window.LS.p2p;
      const isConnected = p2p.isPeerConnected(data.peerId);
      if (!isConnected && p2p.isReady()) {
        const firstSeen = discoveredDevices[data.id]._firstSeen;
        // Tie-breaker: lower peerId initiates first. If disconnected for > 5s, either side connects
        if (cfg.myPeerId < data.peerId || (now - firstSeen > 5000)) {
          p2p.tryAutoConnectPeer(data.peerId, false);
        }
      }
    }

    window.LS.app.notifyDevicesChanged();
  }

  function pruneStaleDevices() {
    const now = Date.now();
    let changed = false;
    for (const [id, dev] of Object.entries(discoveredDevices)) {
      if (now - dev.lastSeen > 8000) {
        delete discoveredDevices[id];
        changed = true;
      }
    }
    if (changed) {
      window.LS.app.notifyDevicesChanged();
    }
  }

  function isConnected() {
    return mqttClient && mqttClient.isConnected();
  }

  window.LS.discovery = {
    detectPublicNetwork,
    startNetworkDiscovery,
    broadcastPresence,
    getDiscoveredDevices,
    get discoveredDevices() {
      return discoveredDevices;
    },
    getMyPublicIp,
    isConnected
  };

})(window);
