/**
 * LocalShare - Configuration & Device Profile Module
 * Detects client platform, manages persistent device identity, and resolves MIME types.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isWindows = /Windows/.test(ua) && !isIOS && !isAndroid;
  const isMac = /Macintosh/.test(ua) && !isIOS;
  const isMobileDevice = isIOS || isAndroid || /Mobile|Tablet|Android|iPhone|iPad/i.test(ua) || (navigator.maxTouchPoints > 0 && window.innerWidth <= 768);

  const hostname = window.location.hostname;
  const isLocalServerHost = ['localhost', '127.0.0.1'].includes(hostname) ||
                            hostname.startsWith('192.168.') ||
                            hostname.startsWith('10.') ||
                            hostname.endsWith('.local');

  // Device profile resolution
  let myDeviceType = 'desktop';
  let myDeviceOs = 'Desktop';
  let myDefaultName = 'PC';
  let myDeviceIcon = '💻';

  if (isIOS) {
    myDeviceType = 'mobile';
    myDeviceOs = 'iOS';
    myDefaultName = /iPad/.test(ua) ? 'iPad (iOS)' : 'iPhone (iOS)';
    myDeviceIcon = '📱';
  } else if (isAndroid) {
    myDeviceType = 'mobile';
    myDeviceOs = 'Android';
    myDefaultName = 'Android Phone';
    myDeviceIcon = '📱';
  } else if (isWindows) {
    myDeviceType = 'desktop';
    myDeviceOs = 'Windows';
    myDefaultName = 'Windows PC';
    myDeviceIcon = '💻';
  } else if (isMac) {
    myDeviceType = 'desktop';
    myDeviceOs = 'macOS';
    myDefaultName = 'Mac';
    myDeviceIcon = '💻';
  }

  // Prevent stale desktop name persistence on mobile devices
  let savedName = localStorage.getItem('localshare_device_name');
  if (savedName && (isMobileDevice || isIOS || isAndroid) && (savedName.includes('PC') || savedName.includes('Windows') || savedName.includes('Mac'))) {
    savedName = null;
    localStorage.removeItem('localshare_device_name');
  }
  let currentDeviceName = savedName || myDefaultName;

  function setDeviceName(newName) {
    if (!newName || !newName.trim()) return currentDeviceName;
    const trimmed = newName.trim().substring(0, 32);
    currentDeviceName = trimmed;
    window.LS.config.myDeviceName = trimmed;
    try {
      localStorage.setItem('localshare_device_name', trimmed);
    } catch (e) {}
    return trimmed;
  }

  // Persistent 4-digit PIN for device pairing
  let myShortPin = localStorage.getItem('localshare_pin');
  if (!myShortPin || myShortPin.length !== 4) {
    myShortPin = Math.floor(1000 + Math.random() * 9000).toString();
    localStorage.setItem('localshare_pin', myShortPin);
  }
  const myPeerId = 'dsoan_' + myShortPin;

  // Persistent unique device UUID
  let myDeviceId = localStorage.getItem('localshare_device_id');
  if (!myDeviceId) {
    myDeviceId = 'dev_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem('localshare_device_id', myDeviceId);
  }

  // Accurate MIME type mapping (specifically tuned for iOS Safari Photos & Videos)
  const MIME_MAP = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
    'heic': 'image/heic',
    'heif': 'image/heif',
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    'avi': 'video/x-msvideo',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'pdf': 'application/pdf',
    'txt': 'text/plain',
    'zip': 'application/zip',
    'rar': 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    'json': 'application/json'
  };

  function getMimeType(fileName, fallbackMime) {
    const ext = (fileName || '').split('.').pop().toLowerCase();
    if (MIME_MAP[ext]) return MIME_MAP[ext];
    if (fallbackMime && fallbackMime !== 'application/octet-stream' && fallbackMime.trim() !== '') return fallbackMime;
    return 'application/octet-stream';
  }

  function getFileCategory(ext) {
    const e = (ext || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg'].includes(e)) return 'photo';
    if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(e)) return 'video';
    if (['mp3', 'm4a', 'wav', 'aac', 'flac'].includes(e)) return 'audio';
    return 'doc';
  }

  window.LS.config = {
    ua,
    isIOS,
    isAndroid,
    isWindows,
    isMac,
    isMobileDevice,
    isLocalServerHost,
    myDeviceId,
    get myDeviceName() {
      return currentDeviceName;
    },
    set myDeviceName(val) {
      currentDeviceName = val;
    },
    setDeviceName,
    myDeviceOs,
    myDeviceType,
    myDeviceIcon,
    myShortPin,
    myPeerId,
    CHUNK_SIZE: 64 * 1024,          // 64 KB SCTP wire chunk size
    BLOCK_SIZE: 1024 * 1024,        // 1 MB disk block read buffer
    BACKPRESSURE_LIMIT: 4 * 1024 * 1024, // 4 MB flow control threshold
    getMimeType,
    getFileCategory
  };

})(window);
