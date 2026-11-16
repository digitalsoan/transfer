/**
 * LocalShare - Power & Keep-Awake Management Module
 * Implements dual-layer screen wake-lock (W3C Wake Lock API + Canvas-stream NoSleep Video loop)
 * and silent Web Audio session to keep the browser networking thread active during transfers.
 */
(function(window) {
  'use strict';

  window.LS = window.LS || {};

  let wakeLock = null;
  let keepAwakeVideo = null;
  let keepAwakeCanvasInterval = null;
  let keepAliveAudioCtx = null;
  let keepAliveOsc = null;

  // 1. Invisible Canvas-Stream Video Loop (iOS Safari & Android fallback)
  function enableVideoKeepAwake() {
    if (keepAwakeVideo) return;
    try {
      keepAwakeVideo = document.createElement('video');
      keepAwakeVideo.setAttribute('playsinline', '');
      keepAwakeVideo.setAttribute('webkit-playsinline', '');
      keepAwakeVideo.muted = true;
      keepAwakeVideo.loop = true;
      keepAwakeVideo.style.position = 'fixed';
      keepAwakeVideo.style.top = '-100px';
      keepAwakeVideo.style.left = '-100px';
      keepAwakeVideo.style.width = '1px';
      keepAwakeVideo.style.height = '1px';
      keepAwakeVideo.style.opacity = '0.001';
      keepAwakeVideo.style.pointerEvents = 'none';
      document.body.appendChild(keepAwakeVideo);

      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const ctx = canvas.getContext('2d');
      if (canvas.captureStream) {
        const stream = canvas.captureStream(1);
        keepAwakeVideo.srcObject = stream;
        keepAwakeVideo.play().catch(() => {});
        keepAwakeCanvasInterval = setInterval(() => {
          if (ctx) {
            ctx.fillStyle = ctx.fillStyle === '#000000' ? '#ffffff' : '#000000';
            ctx.fillRect(0, 0, 2, 2);
          }
        }, 1000);
      }
    } catch (e) {
      console.warn('[LS:Power] Video keep-awake initialization error:', e);
    }
  }

  function disableVideoKeepAwake() {
    if (keepAwakeCanvasInterval) {
      clearInterval(keepAwakeCanvasInterval);
      keepAwakeCanvasInterval = null;
    }
    if (keepAwakeVideo) {
      try {
        keepAwakeVideo.pause();
        if (keepAwakeVideo.srcObject) {
          keepAwakeVideo.srcObject.getTracks().forEach(track => track.stop());
        }
        keepAwakeVideo.remove();
      } catch (e) {}
      keepAwakeVideo = null;
    }
  }

  // 2. W3C Screen Wake Lock API
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch (e) {
      console.warn('[LS:Power] Wake Lock request error:', e);
    }
    enableVideoKeepAwake();
  }

  function releaseWakeLock() {
    if (wakeLock) {
      try {
        wakeLock.release();
      } catch (e) {}
      wakeLock = null;
    }
    disableVideoKeepAwake();
  }

  // 3. Web Audio Session Keep-Alive
  function startSilentAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!keepAliveAudioCtx) {
        keepAliveAudioCtx = new AudioCtx();
      }
      if (keepAliveAudioCtx.state === 'suspended') {
        keepAliveAudioCtx.resume();
      }
      if (!keepAliveOsc) {
        keepAliveOsc = keepAliveAudioCtx.createOscillator();
        const gain = keepAliveAudioCtx.createGain();
        gain.gain.value = 0.0001; // inaudible
        keepAliveOsc.frequency.setValueAtTime(30, keepAliveAudioCtx.currentTime);
        keepAliveOsc.connect(gain);
        gain.connect(keepAliveAudioCtx.destination);
        keepAliveOsc.start();
      }
    } catch (e) {
      console.warn('[LS:Power] Audio keep-alive error:', e);
    }
  }

  function stopSilentAudio() {
    try {
      if (keepAliveOsc) {
        keepAliveOsc.stop();
        keepAliveOsc.disconnect();
        keepAliveOsc = null;
      }
      if (keepAliveAudioCtx && keepAliveAudioCtx.state === 'running') {
        keepAliveAudioCtx.suspend();
      }
    } catch (e) {}
  }

  window.LS.power = {
    acquireWakeLock,
    releaseWakeLock,
    startSilentAudio,
    stopSilentAudio
  };

})(window);
