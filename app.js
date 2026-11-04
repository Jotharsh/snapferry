/**
 * Snapferry — Core PWA Client Application
 * Stage 3 & 4: 16 KB Chunked Transfer Engine, Backpressure, Screen Wake Lock,
 * Disconnect Handling, Gallery, Native Share Sheet & Hand-crafted Store-only ZIP
 */

(() => {
  'use strict';

  const CHUNK_SIZE = 16384; // 16 KB binary chunks
  const HIGH_WATER_MARK = 1048576; // 1 MB backpressure pause threshold
  const LOW_WATER_THRESHOLD = 65536; // 64 KB resume threshold

  // --- APPLICATION STATE ---
  const state = {
    currentScreen: 'home',
    theme: localStorage.getItem('snapferry_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    isDev: new URLSearchParams(window.location.search).has('dev') || sessionStorage.getItem('snapferry_dev') === '1',
    allowStun: false,
    deferredInstallPrompt: null,

    // File transfer state
    stagedFiles: [],
    transferQueue: [],
    completedFiles: [],
    receivedFiles: [], // [{ id, name, size, type, blob, objectUrl, sha256, selected }]
    currentSendingFile: null,
    currentReceivingFile: null,
    isTransferring: false,
    isTransferCancelled: false,

    // Transfer metrics
    transferStartTime: 0,
    totalBytesToTransfer: 0,
    totalBytesTransferred: 0,
    metricsTimer: null,
    lastMeasuredBytes: 0,
    lastMeasuredTime: 0,
    currentSpeedMbps: 0,

    // WebRTC connection
    role: null, // 'sender' | 'receiver'
    pc: null,
    dc: null,

    // UI state
    qrCycleTimer: null,
    scannerStream: null,
    scannerRaf: null,
    scannerAccumulator: {},
    activePasteTarget: null,
    wakeLock: null,
  };

  // --- DOM HELPERS ---
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screens = {
    home: $('screen-home'),
    send: $('screen-send'),
    receive: $('screen-receive'),
    transfer: $('screen-transfer'),
    gallery: $('screen-gallery'),
  };

  // --- ROUTING ---
  function showScreen(screenId) {
    if (!screens[screenId]) screenId = 'home';
    state.currentScreen = screenId;

    if (screenId !== 'receive' && state.scannerStream) {
      stopCameraScanner();
    }
    if (state.qrCycleTimer) {
      clearInterval(state.qrCycleTimer);
      state.qrCycleTimer = null;
    }

    Object.entries(screens).forEach(([id, el]) => {
      if (el) {
        if (id === screenId) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      }
    });

    window.scrollTo({ top: 0, behavior: 'instant' });

    if (window.location.hash !== `#${screenId}`) {
      window.history.pushState(null, '', `#${screenId}`);
    }
  }

  function handleHashChange() {
    const hash = window.location.hash.replace('#', '') || 'home';
    if (screens[hash]) {
      showScreen(hash);
    } else {
      showScreen('home');
    }
  }

  // --- THEME ---
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('snapferry_theme', theme);
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  // --- TOAST NOTIFICATIONS ---
  function showToast(message, duration = 3000) {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.2s';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  // --- AUDIO CHIME (Offline Web Audio API) ---
  function playChime(frequencies = [523.25, 659.25, 783.99]) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      let time = ctx.currentTime;
      frequencies.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time + idx * 0.1);
        gain.gain.setValueAtTime(0.12, time + idx * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.001, time + idx * 0.1 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time + idx * 0.1);
        osc.stop(time + idx * 0.1 + 0.4);
      });
    } catch (e) {}
  }

  // --- CONFETTI CANNON (Canvas 2D) ---
  function launchConfetti() {
    const canvas = $('confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#4f46e5', '#f97316', '#10b981', '#38bdf8', '#facc15'];
    const particles = [];
    for (let i = 0; i < 70; i++) {
      particles.push({
        x: canvas.width / 2,
        y: canvas.height * 0.35,
        vx: (Math.random() - 0.5) * 16,
        vy: (Math.random() - 0.7) * 15,
        size: Math.random() * 8 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 10,
        life: 1.0,
        decay: Math.random() * 0.015 + 0.01,
      });
    }

    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      particles.forEach((p) => {
        if (p.life > 0) {
          alive = true;
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.35;
          p.rotation += p.rotSpeed;
          p.life -= p.decay;

          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rotation * Math.PI) / 180);
          ctx.fillStyle = p.color;
          ctx.globalAlpha = Math.max(0, p.life);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
          ctx.restore();
        }
      });
      if (alive) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    requestAnimationFrame(frame);
  }

  // --- SCREEN WAKE LOCK ---
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        state.wakeLock = await navigator.wakeLock.request('screen');
        console.log('[WakeLock] Screen Wake Lock acquired.');
        const notice = $('wake-lock-notice');
        if (notice) notice.classList.remove('hidden');
        state.wakeLock.addEventListener('release', () => {
          console.log('[WakeLock] Screen Wake Lock released.');
        });
      } catch (err) {
        console.warn('[WakeLock] Request failed:', err);
      }
    }
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
    const notice = $('wake-lock-notice');
    if (notice) notice.classList.add('hidden');
  }

  // --- UTILS: SHA-256 HASHING ---
  async function computeSha256(arrayBuffer) {
    if (crypto && crypto.subtle && crypto.subtle.digest) {
      const hashBuf = await crypto.subtle.digest('SHA-256', arrayBuffer);
      return Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    return '';
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // --- BASE64URL ENCODING ---
  function bytesToBase64Url(bytes) {
    let bin = '';
    const len = bytes.length;
    for (let i = 0; i < len; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // --- SDP COMPRESSION & DECOMPRESSION ---
  async function compressSDP(sdp) {
    const minified = sdp.split('\r\n').filter((l) => {
      const line = l.trim();
      if (!line) return false;
      if (line.startsWith('a=extmap') || line.startsWith('a=msid') || line.startsWith('a=rtcp') || line.startsWith('a=ice-options:trickle')) {
        return false;
      }
      return true;
    }).join('\n');

    const rawBytes = new TextEncoder().encode(minified);

    if (typeof CompressionStream !== 'undefined') {
      try {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        writer.write(rawBytes);
        writer.close();
        const chunks = [];
        const reader = cs.readable.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        return bytesToBase64Url(merged);
      } catch (e) {}
    }

    if (window.fflate && window.fflate.deflateSync) {
      const def = window.fflate.deflateSync(rawBytes);
      return bytesToBase64Url(def);
    }

    return bytesToBase64Url(rawBytes);
  }

  async function decompressSDP(token) {
    token = token.trim();
    if (token.startsWith('SF:')) {
      const parts = token.split(':');
      token = parts.slice(4).join(':') || parts[parts.length - 1];
    }
    const bytes = base64UrlToBytes(token);

    if (typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const chunks = [];
        const reader = ds.readable.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        const text = new TextDecoder().decode(merged);
        return text.split('\n').join('\r\n') + '\r\n';
      } catch (e) {}
    }

    if (window.fflate && window.fflate.inflateSync) {
      try {
        const inf = window.fflate.inflateSync(bytes);
        const text = new TextDecoder().decode(inf);
        return text.split('\n').join('\r\n') + '\r\n';
      } catch (e) {}
    }

    const rawText = new TextDecoder().decode(bytes);
    return rawText.split('\n').join('\r\n') + '\r\n';
  }

  // --- AESTHETIC QR CODE RENDERER ---
  function renderAestheticQR(container, text) {
    if (!container || !window.qrcode) return;
    container.innerHTML = '';

    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    const moduleCount = qr.getModuleCount();
    const canvas = document.createElement('canvas');
    const scale = 8;
    const margin = 4 * scale;
    const canvasSize = moduleCount * scale + margin * 2;

    const dpr = window.devicePixelRatio || 2;
    canvas.width = canvasSize * dpr;
    canvas.height = canvasSize * dpr;
    canvas.style.width = '100%';
    canvas.style.height = '100%';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    function isFinder(r, c) {
      return (r < 7 && c < 7) || (r < 7 && c >= moduleCount - 7) || (r >= moduleCount - 7 && c < 7);
    }

    const primaryEyeColor = '#4f46e5';
    const accentEyeColor = '#f97316';
    const moduleColor = '#121316';

    // 1. Data modules as circular dots
    ctx.fillStyle = moduleColor;
    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount; c++) {
        if (qr.isDark(r, c) && !isFinder(r, c)) {
          const x = margin + c * scale;
          const y = margin + r * scale;
          const radius = scale * 0.38;
          ctx.beginPath();
          ctx.arc(x + scale / 2, y + scale / 2, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 2. Corner Finder Patterns
    const eyes = [
      { r: 0, c: 0, color: primaryEyeColor },
      { r: 0, c: moduleCount - 7, color: accentEyeColor },
      { r: moduleCount - 7, c: 0, color: primaryEyeColor },
    ];

    eyes.forEach((eye) => {
      const ox = margin + eye.c * scale;
      const oy = margin + eye.r * scale;
      const eyeSize = 7 * scale;

      ctx.fillStyle = eye.color;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(ox, oy, eyeSize, eyeSize, 12);
        ctx.fill();
      } else {
        ctx.fillRect(ox, oy, eyeSize, eyeSize);
      }

      ctx.fillStyle = '#ffffff';
      const innerCutout = 5 * scale;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(ox + scale, oy + scale, innerCutout, innerCutout, 8);
        ctx.fill();
      } else {
        ctx.fillRect(ox + scale, oy + scale, innerCutout, innerCutout);
      }

      ctx.fillStyle = eye.color;
      const coreSize = 3 * scale;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(ox + 2 * scale, oy + 2 * scale, coreSize, coreSize, 6);
        ctx.fill();
      } else {
        ctx.fillRect(ox + 2 * scale, oy + 2 * scale, coreSize, coreSize);
      }
    });

    // 3. Center Ferry Badge
    if (moduleCount >= 25) {
      const cx = canvasSize / 2;
      const cy = canvasSize / 2;
      const badgeR = 2.2 * scale;

      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#121316';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, badgeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = primaryEyeColor;
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy + 2);
      ctx.lineTo(cx - 5, cy + 8);
      ctx.lineTo(cx + 5, cy + 8);
      ctx.lineTo(cx + 9, cy + 2);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#121316';
      ctx.fillRect(cx - 4, cy - 3, 8, 4);
      ctx.fillStyle = accentEyeColor;
      ctx.fillRect(cx + 1, cy - 6, 3, 3);
    }

    container.appendChild(canvas);
  }

  // --- MULTI-FRAME ANIMATED QR ENGINE ---
  function displayPayloadAsQR(containerId, frameBadgeId, dotsId, payload) {
    const container = $(containerId);
    const badge = $(frameBadgeId);
    const dotsWrap = $(dotsId);
    if (!container) return;

    if (state.qrCycleTimer) {
      clearInterval(state.qrCycleTimer);
      state.qrCycleTimer = null;
    }

    if (payload.length <= 320) {
      renderAestheticQR(container, `SF:1:1:s:${payload}`);
      if (badge) badge.classList.add('hidden');
      if (dotsWrap) dotsWrap.classList.add('hidden');
      return;
    }

    const chunkSize = 230;
    const totalFrames = Math.ceil(payload.length / chunkSize);
    const sessionId = Math.random().toString(36).substring(2, 6);
    const frames = [];

    for (let i = 0; i < totalFrames; i++) {
      const chunk = payload.substring(i * chunkSize, (i + 1) * chunkSize);
      frames.push(`SF:${i + 1}:${totalFrames}:${sessionId}:${chunk}`);
    }

    if (badge) {
      badge.classList.remove('hidden');
      badge.textContent = `Frame 1 of ${totalFrames}`;
    }

    if (dotsWrap) {
      dotsWrap.classList.remove('hidden');
      dotsWrap.innerHTML = frames.map((_, i) => `<span class="qr-dot ${i === 0 ? 'active' : ''}"></span>`).join('');
    }

    let currentIdx = 0;
    renderAestheticQR(container, frames[0]);

    state.qrCycleTimer = setInterval(() => {
      currentIdx = (currentIdx + 1) % totalFrames;
      renderAestheticQR(container, frames[currentIdx]);
      if (badge) {
        badge.textContent = `Frame ${currentIdx + 1} of ${totalFrames}`;
      }
      if (dotsWrap) {
        const dots = dotsWrap.querySelectorAll('.qr-dot');
        dots.forEach((d, idx) => {
          if (idx === currentIdx) d.classList.add('active');
          else d.classList.remove('active');
        });
      }
    }, 360);
  }

  // --- CAMERA SCANNER LOOP ---
  async function startCameraScanner(videoElId, statusElId, onPayloadResolved) {
    const video = $(videoElId);
    const statusEl = $(statusElId);
    if (!video || !window.jsQR) return;

    state.scannerAccumulator = {};

    try {
      if (statusEl) statusEl.textContent = 'Requesting camera access...';
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      state.scannerStream = stream;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play();

      if (statusEl) statusEl.innerHTML = '<span class="status-indicator-dot"></span> Camera active. Align QR in frame.';

      const scanCanvas = document.createElement('canvas');
      const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

      function tick() {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          scanCanvas.width = video.videoWidth;
          scanCanvas.height = video.videoHeight;
          scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);

          const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          });

          if (code && code.data) {
            const raw = code.data.trim();
            if (raw.startsWith('SF:')) {
              const parts = raw.split(':');
              const partNum = parseInt(parts[1], 10);
              const totalParts = parseInt(parts[2], 10);
              const sid = parts[3];
              const chunk = parts.slice(4).join(':');

              if (!isNaN(partNum) && !isNaN(totalParts)) {
                if (!state.scannerAccumulator[sid]) {
                  state.scannerAccumulator[sid] = { total: totalParts, parts: {} };
                }
                state.scannerAccumulator[sid].parts[partNum] = chunk;
                const collected = Object.keys(state.scannerAccumulator[sid].parts).length;

                if (statusEl) {
                  statusEl.innerHTML = `<span class="status-indicator-dot"></span> Scanning: frame ${collected} of ${totalParts} (${Math.round((collected / totalParts) * 100)}%)`;
                }

                if (collected === totalParts) {
                  let fullToken = '';
                  for (let p = 1; p <= totalParts; p++) {
                    fullToken += state.scannerAccumulator[sid].parts[p];
                  }
                  stopCameraScanner();
                  playChime([659.25, 783.99]);
                  onPayloadResolved(fullToken);
                  return;
                }
              }
            } else {
              stopCameraScanner();
              playChime([659.25, 783.99]);
              onPayloadResolved(raw);
              return;
            }
          }
        }
        state.scannerRaf = requestAnimationFrame(tick);
      }
      state.scannerRaf = requestAnimationFrame(tick);
    } catch (err) {
      console.warn('[Camera] Scanner failed:', err);
      if (statusEl) {
        statusEl.innerHTML = '<span class="text-danger">Camera blocked. Use "Paste Code" fallback below.</span>';
      }
      showToast('Camera access denied. Use Paste code.');
    }
  }

  function stopCameraScanner() {
    if (state.scannerRaf) {
      cancelAnimationFrame(state.scannerRaf);
      state.scannerRaf = null;
    }
    if (state.scannerStream) {
      state.scannerStream.getTracks().forEach((t) => t.stop());
      state.scannerStream = null;
    }
  }

  // --- WEBRTC PEER CONNECTION & DATACHANNEL ---
  function createPeerConnection(isSender, allowStun) {
    const config = {
      iceServers: allowStun ? [{ urls: 'stun:stun.l.google.com:19302' }] : [],
    };
    const pc = new RTCPeerConnection(config);

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE Connection State:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        handleDisconnect();
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection State:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        showToast('Direct P2P DataChannel connected!');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        handleDisconnect();
      }
    };

    return pc;
  }

  function waitForIceGathering(pc, timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      let timeoutTimer = null;
      function check(e) {
        if (pc.iceGatheringState === 'complete' || (e && !e.candidate)) {
          cleanup();
          resolve();
        }
      }
      function cleanup() {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        pc.removeEventListener('icecandidate', check);
        pc.removeEventListener('icegatheringstatechange', check);
      }
      timeoutTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      pc.addEventListener('icecandidate', check);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function handleDisconnect() {
    console.warn('[Snapferry] WebRTC disconnected');
    releaseWakeLock();
    stopMetricsTimer();
    if (state.isTransferring) {
      state.isTransferring = false;
      showToast('Connection interrupted. Finished files are preserved.');
      $('transfer-subtitle').textContent = 'Connection paused. Reconnect to resume.';
    }
  }

  function setupDataChannel(dc) {
    state.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER_THRESHOLD;

    dc.onopen = () => {
      console.log('[DataChannel] Open and ready!');
      requestWakeLock();
      playChime([523.25, 659.25, 783.99]);
      launchConfetti();
      showScreen('transfer');

      $('transfer-role-label').textContent = state.role === 'sender' ? 'Sender (Host)' : 'Receiver (Client)';
      $('stream-from-label').textContent = state.role === 'sender' ? 'This Device' : 'Sender';
      $('stream-to-label').textContent = state.role === 'sender' ? 'Receiver' : 'This Device';

      // Sender initiates transfer if staged files exist
      if (state.role === 'sender' || state.stagedFiles.length > 0) {
        state.role = 'sender';
        const pingMsg = JSON.stringify({ type: 'ping', t: Date.now(), msg: 'Hello from Sender' });
        dc.send(pingMsg);
        logPingMessage('Sent ping to Receiver ⚡', 'sent');

        if (state.stagedFiles.length > 0) {
          setTimeout(() => {
            startBatchTransfer();
          }, 300);
        }
      }
    };

    dc.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const json = JSON.parse(event.data);
          handleControlMessage(json);
        } catch (e) {
          console.warn('[DataChannel] Error parsing message:', e);
        }
      } else if (event.data instanceof ArrayBuffer) {
        handleBinaryChunk(event.data);
      }
    };

    dc.onclose = () => {
      handleDisconnect();
    };

    dc.onerror = (err) => {
      console.error('[DataChannel] Error:', err);
    };
  }

  function logPingMessage(msg, type = 'recv') {
    const logEl = $('test-ping-log');
    if (!logEl) return;
    const row = document.createElement('div');
    row.className = `test-ping-row ${type}`;
    const time = new Date().toLocaleTimeString().split(' ')[0];
    row.textContent = `[${time}] ${msg}`;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // --- SENDER HANDSHAKE FLOW ---
  async function startSenderHandshake() {
    state.role = 'sender';
    $('sender-phase-pick').classList.add('hidden');
    $('sender-phase-pair').classList.remove('hidden');
    $('send-step-pill-1').classList.remove('active');
    $('send-step-pill-2').classList.add('active');

    const statusEl = $('sender-qr-status');
    if (statusEl) statusEl.textContent = 'Gathering local routes (non-trickle)...';

    const allowStun = $('sender-stun-toggle') ? $('sender-stun-toggle').checked : false;
    state.allowStun = allowStun;

    state.pc = createPeerConnection(true, allowStun);
    const dc = state.pc.createDataChannel('snapferry', { ordered: true });
    setupDataChannel(dc);

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);

    await waitForIceGathering(state.pc, 2500);

    const fullOfferSdp = state.pc.localDescription.sdp;
    const compressed = await compressSDP(fullOfferSdp);

    displayPayloadAsQR('sender-qr-canvas-wrap', 'sender-qr-frame-badge', 'sender-qr-dots', compressed);

    if (statusEl) statusEl.textContent = 'Ready! Scan with Receiver camera.';

    const copyBtn = $('btn-copy-offer');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(compressed).then(() => {
          showToast('Offer code copied to clipboard!');
        }).catch(() => {
          showToast('Code ready in text box below');
        });
      };
    }

    const toggleTextBtn = $('btn-toggle-offer-text');
    const textBox = $('offer-text-box');
    const textArea = $('offer-text-area');
    if (toggleTextBtn && textBox && textArea) {
      textArea.value = compressed;
      toggleTextBtn.onclick = () => {
        textBox.classList.toggle('hidden');
      };
    }
  }

  async function applyReceiverAnswer(answerToken) {
    try {
      const answerSdp = await decompressSDP(answerToken);
      await state.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      showToast('Answer applied! Connecting...');
    } catch (err) {
      console.error('[Sender] Failed to apply answer:', err);
      showToast('Invalid answer code. Please re-scan or re-paste.');
    }
  }

  // --- RECEIVER HANDSHAKE FLOW ---
  async function startReceiverScan() {
    state.role = 'receiver';
    $('receiver-phase-scan').classList.remove('hidden');
    $('receiver-phase-answer').classList.add('hidden');
    $('recv-step-pill-1').classList.add('active');
    $('recv-step-pill-2').classList.remove('active');

    startCameraScanner('receiver-video', 'receiver-scan-status', async (offerToken) => {
      await handleScannedOffer(offerToken);
    });
  }

  async function handleScannedOffer(offerToken) {
    state.role = 'receiver';
    try {
      $('receiver-phase-scan').classList.add('hidden');
      $('receiver-phase-answer').classList.remove('hidden');
      $('recv-step-pill-1').classList.remove('active');
      $('recv-step-pill-2').classList.add('active');

      const statusEl = $('receiver-qr-status');
      if (statusEl) statusEl.textContent = 'Generating local WebRTC answer...';

      const offerSdp = await decompressSDP(offerToken);

      state.pc = createPeerConnection(false, state.allowStun);
      state.pc.ondatachannel = (e) => {
        setupDataChannel(e.channel);
      };

      await state.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);

      await waitForIceGathering(state.pc, 2500);

      const fullAnswerSdp = state.pc.localDescription.sdp;
      const compressedAnswer = await compressSDP(fullAnswerSdp);

      displayPayloadAsQR('receiver-qr-canvas-wrap', 'receiver-qr-frame-badge', 'receiver-qr-dots', compressedAnswer);

      if (statusEl) statusEl.textContent = 'Waiting for sender to scan answer...';

      const copyBtn = $('btn-copy-answer');
      if (copyBtn) {
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(compressedAnswer).then(() => {
            showToast('Answer code copied to clipboard!');
          }).catch(() => {
            showToast('Answer token ready');
          });
        };
      }
    } catch (err) {
      console.error('[Receiver] Failed to process offer:', err);
      showToast('Error processing offer code.');
      $('receiver-phase-scan').classList.remove('hidden');
      $('receiver-phase-answer').classList.add('hidden');
    }
  }

  // --- TRANSFER PROTOCOL ENGINE ---

  // 1. SENDER: Start Batch Transfer
  async function startBatchTransfer() {
    if (state.stagedFiles.length === 0 || !state.dc || state.dc.readyState !== 'open') return;

    state.isTransferring = true;
    state.isTransferCancelled = false;
    state.transferStartTime = Date.now();
    state.totalBytesTransferred = 0;
    state.totalBytesToTransfer = state.stagedFiles.reduce((acc, f) => acc + f.size, 0);

    // Prepare transfer queue
    state.transferQueue = state.stagedFiles.map((file, idx) => ({
      id: `file_${idx}_${Date.now()}`,
      file,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified || Date.now(),
      status: 'pending',
    }));

    startMetricsTimer();

    // Send manifest first
    const manifestMsg = {
      type: 'manifest',
      totalFiles: state.transferQueue.length,
      totalBytes: state.totalBytesToTransfer,
      files: state.transferQueue.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        type: item.type,
        lastModified: item.lastModified,
      })),
    };
    state.dc.send(JSON.stringify(manifestMsg));

    // Send first file in queue
    sendNextFileInQueue();
  }

  // 2. SENDER: Stream Single File with Backpressure & SHA-256
  async function sendNextFileInQueue() {
    if (!state.isTransferring || state.isTransferCancelled) return;

    const nextItem = state.transferQueue.find((item) => item.status === 'pending');
    if (!nextItem) {
      // All files sent!
      completeSenderTransfer();
      return;
    }

    state.currentSendingFile = nextItem;
    nextItem.status = 'sending';

    const file = nextItem.file;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    updateFileProgressUI(nextItem.name, 0, file.size);

    // Read full file buffer to compute SHA-256 checksum for byte-for-byte verification
    const fileArrayBuffer = await file.arrayBuffer();
    const sha256 = await computeSha256(fileArrayBuffer);
    nextItem.sha256 = sha256;

    // Send File Start Header
    const startMsg = {
      type: 'file-start',
      id: nextItem.id,
      name: nextItem.name,
      size: nextItem.size,
      mimeType: nextItem.type,
      totalChunks,
      sha256,
    };
    state.dc.send(JSON.stringify(startMsg));

    // Stream 16 KB chunks with backpressure
    let offset = 0;
    let chunkIndex = 0;

    while (offset < file.size) {
      if (state.isTransferCancelled || !state.dc || state.dc.readyState !== 'open') break;

      const chunkBuffer = fileArrayBuffer.slice(offset, offset + CHUNK_SIZE);

      // Backpressure check: if bufferedAmount exceeds High Water Mark, pause until low
      if (state.dc.bufferedAmount > HIGH_WATER_MARK) {
        await new Promise((resolve) => {
          state.dc.addEventListener('bufferedamountlow', resolve, { once: true });
        });
      }

      state.dc.send(chunkBuffer);
      offset += chunkBuffer.byteLength;
      chunkIndex++;

      state.totalBytesTransferred += chunkBuffer.byteLength;
      updateFileProgressUI(nextItem.name, offset, file.size);
    }

    // Send File End Marker
    const endMsg = {
      type: 'file-end',
      id: nextItem.id,
      sha256,
      sentBytes: offset,
    };
    state.dc.send(JSON.stringify(endMsg));
    console.log(`[Sender] Finished streaming ${nextItem.name}, waiting for receiver ACK...`);
  }

  function completeSenderTransfer() {
    state.isTransferring = false;
    stopMetricsTimer();
    playChime([523.25, 659.25, 783.99, 1046.5]);
    launchConfetti();
    showToast('All files ferried successfully! 🚀');

    state.dc.send(JSON.stringify({ type: 'transfer-complete' }));

    setTimeout(() => {
      // Build gallery view for sender as well
      populateGallery(state.stagedFiles.map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        blob: f,
        objectUrl: URL.createObjectURL(f),
        selected: true,
      })));
      showScreen('gallery');
    }, 1200);
  }

  // 3. RECEIVER & SENDER: Control Messages
  async function handleControlMessage(json) {
    switch (json.type) {
      case 'ping': {
        logPingMessage(`Received ping: "${json.msg}"`, 'recv');
        if (state.dc && state.dc.readyState === 'open') {
          const pong = JSON.stringify({ type: 'pong', origT: json.t, t: Date.now(), msg: 'Pong from Receiver' });
          state.dc.send(pong);
          logPingMessage('Sent pong reply ✓', 'sent');
        }
        break;
      }
      case 'pong': {
        const rtt = Date.now() - json.origT;
        logPingMessage(`Received pong! RTT: ${rtt} ms ✓`, 'recv');
        showToast(`DataChannel Verified! RTT: ${rtt} ms`);
        break;
      }
      case 'manifest': {
        console.log('[Receiver] Received transfer manifest:', json);
        state.isTransferring = true;
        state.transferStartTime = Date.now();
        state.totalBytesToTransfer = json.totalBytes;
        state.totalBytesTransferred = 0;
        state.transferQueue = json.files;
        startMetricsTimer();
        break;
      }
      case 'file-start': {
        console.log('[Receiver] File start:', json.name);
        state.currentReceivingFile = {
          id: json.id,
          name: json.name,
          size: json.size,
          mimeType: json.mimeType,
          totalChunks: json.totalChunks,
          expectedSha256: json.sha256,
          receivedBytes: 0,
          chunks: [],
        };
        updateFileProgressUI(json.name, 0, json.size);
        break;
      }
      case 'file-end': {
        console.log('[Receiver] File end:', json.id);
        const cur = state.currentReceivingFile;
        if (cur && cur.id === json.id) {
          // Merge chunks into single Blob
          const blob = new Blob(cur.chunks, { type: cur.mimeType });
          const arrayBuf = await blob.arrayBuffer();
          const computedHash = await computeSha256(arrayBuf);

          const matches = computedHash === cur.expectedSha256;
          console.log(`[Receiver] Byte check: expected=${cur.size}, actual=${blob.size}, SHA256 match=${matches}`);

          const objectUrl = URL.createObjectURL(blob);
          state.receivedFiles.push({
            id: cur.id,
            name: cur.name,
            size: blob.size,
            type: cur.mimeType,
            blob,
            objectUrl,
            sha256: computedHash,
            selected: true,
          });

          // Send ACK back to sender
          state.dc.send(JSON.stringify({
            type: 'file-ack',
            id: cur.id,
            receivedBytes: blob.size,
            sha256: computedHash,
            matches,
          }));

          state.currentReceivingFile = null;
        }
        break;
      }
      case 'file-ack': {
        console.log('[Sender] Received file ACK:', json);
        const cur = state.currentSendingFile;
        if (cur && cur.id === json.id) {
          cur.status = 'completed';
          state.completedFiles.push(cur);
          state.currentSendingFile = null;
          // Send next file in queue
          sendNextFileInQueue();
        }
        break;
      }
      case 'transfer-complete': {
        state.isTransferring = false;
        stopMetricsTimer();
        playChime([523.25, 659.25, 783.99, 1046.5]);
        launchConfetti();
        showToast('All files received! 📸');

        setTimeout(() => {
          populateGallery(state.receivedFiles);
          showScreen('gallery');
        }, 1200);
        break;
      }
      case 'cancel-transfer': {
        state.isTransferring = false;
        stopMetricsTimer();
        showToast('Transfer cancelled by peer.');
        $('transfer-subtitle').textContent = 'Transfer was cancelled.';
        break;
      }
    }
  }

  // 4. RECEIVER: Binary Chunk Reception
  function handleBinaryChunk(arrayBuffer) {
    const cur = state.currentReceivingFile;
    if (!cur) return;

    cur.chunks.push(arrayBuffer);
    cur.receivedBytes += arrayBuffer.byteLength;
    state.totalBytesTransferred += arrayBuffer.byteLength;

    updateFileProgressUI(cur.name, cur.receivedBytes, cur.size);
  }

  // --- PROGRESS UI & SPEED MEASUREMENT ---
  function updateFileProgressUI(filename, currentBytes, totalBytes) {
    const activeName = $('active-filename');
    const activeSize = $('active-filesize');
    const activeBar = $('active-file-bar');
    const iconEl = $('active-file-icon');

    if (activeName) activeName.textContent = filename;
    if (activeSize) activeSize.textContent = `${formatBytes(currentBytes)} of ${formatBytes(totalBytes)}`;
    if (activeBar && totalBytes > 0) {
      const pct = Math.min(100, Math.round((currentBytes / totalBytes) * 100));
      activeBar.style.width = `${pct}%`;
    }

    if (iconEl) {
      iconEl.textContent = filename.match(/\.(mp4|mov|webm|mkv|avi)$/i) ? '🎬' : '📸';
    }

    // Overall progress
    const overallBar = $('overall-progress-bar');
    const pctLabel = $('metric-percent');
    const bytesLabel = $('metric-bytes');
    const filesLabel = $('metric-files');

    if (state.totalBytesToTransfer > 0) {
      const overallPct = Math.min(100, Math.round((state.totalBytesTransferred / state.totalBytesToTransfer) * 100));
      if (overallBar) overallBar.style.width = `${overallPct}%`;
      if (pctLabel) pctLabel.textContent = `${overallPct}%`;
      if (bytesLabel) bytesLabel.textContent = `${formatBytes(state.totalBytesTransferred)} of ${formatBytes(state.totalBytesToTransfer)}`;
    }

    if (filesLabel && state.transferQueue.length > 0) {
      const doneCount = state.completedFiles.length + state.receivedFiles.length;
      filesLabel.textContent = `File ${Math.min(state.transferQueue.length, doneCount + 1)} of ${state.transferQueue.length}`;
    }
  }

  function startMetricsTimer() {
    state.lastMeasuredBytes = state.totalBytesTransferred;
    state.lastMeasuredTime = Date.now();

    if (state.metricsTimer) clearInterval(state.metricsTimer);
    state.metricsTimer = setInterval(() => {
      const now = Date.now();
      const elapsedSec = (now - state.lastMeasuredTime) / 1000;
      if (elapsedSec >= 0.3) {
        const deltaBytes = state.totalBytesTransferred - state.lastMeasuredBytes;
        const currentSpeed = deltaBytes / elapsedSec / (1024 * 1024); // MB/s
        state.currentSpeedMbps = currentSpeed;

        const speedEl = $('metric-speed');
        if (speedEl) speedEl.textContent = `${currentSpeed.toFixed(1)} MB/s`;

        const remainingBytes = Math.max(0, state.totalBytesToTransfer - state.totalBytesTransferred);
        const etaSec = currentSpeed > 0 ? remainingBytes / (currentSpeed * 1024 * 1024) : 0;
        const etaEl = $('metric-eta');
        if (etaEl) etaEl.textContent = formatTime(etaSec);

        state.lastMeasuredBytes = state.totalBytesTransferred;
        state.lastMeasuredTime = now;
      }
    }, 300);
  }

  function stopMetricsTimer() {
    if (state.metricsTimer) {
      clearInterval(state.metricsTimer);
      state.metricsTimer = null;
    }
  }

  // --- HAND-CRAFTED STORE-ONLY ZIP WRITER ---
  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c;
    }
    return table;
  }
  const crcTable = makeCrcTable();

  function computeCrc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function createStoreZip(files) {
    const textEnc = new TextEncoder();
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = textEnc.encode(f.name);
      const dataBytes = new Uint8Array(await f.blob.arrayBuffer());
      const crc = computeCrc32(dataBytes);
      const size = dataBytes.length;

      // Local File Header (30 bytes + name)
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0, true); // flags
      lv.setUint16(8, 0, true); // method 0 (Store, no compression)
      lv.setUint16(10, 0, true); // mod time
      lv.setUint16(12, 0, true); // mod date
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      localHeaders.push({ lh, data: dataBytes, offset });

      // Central Directory Header (46 bytes + name)
      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
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
      ch.set(nameBytes, 46);

      centralHeaders.push(ch);
      offset += lh.length + size;
    }

    const centralOffset = offset;
    const centralSize = centralHeaders.reduce((acc, h) => acc + h.length, 0);

    // End of Central Directory Record (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);

    const totalLen = centralOffset + centralSize + 22;
    const zipBytes = new Uint8Array(totalLen);
    let cur = 0;
    for (const item of localHeaders) {
      zipBytes.set(item.lh, cur);
      cur += item.lh.length;
      zipBytes.set(item.data, cur);
      cur += item.data.length;
    }
    for (const ch of centralHeaders) {
      zipBytes.set(ch, cur);
      cur += ch.length;
    }
    zipBytes.set(eocd, cur);

    return new Blob([zipBytes], { type: 'application/zip' });
  }

  // --- GALLERY, PREVIEW & SAVING ---
  function populateGallery(items) {
    const grid = $('gallery-grid');
    if (!grid) return;
    grid.innerHTML = '';

    items.forEach((item, index) => {
      item.selected = true;
      const card = document.createElement('div');
      card.className = 'gallery-card';

      const isVideo = item.type.startsWith('video/') || item.name.match(/\.(mp4|mov|webm)$/i);

      card.innerHTML = `
        <div class="gallery-thumbnail-wrap" data-index="${index}">
          <label class="gallery-item-select" onclick="event.stopPropagation()">
            <input type="checkbox" class="file-select-cb" data-index="${index}" checked>
          </label>
          ${
            isVideo
              ? `<video src="${item.objectUrl}" class="gallery-thumb-video" preload="metadata" muted playsinline></video>`
              : `<img src="${item.objectUrl}" class="gallery-thumb-img" alt="${item.name}" loading="lazy">`
          }
        </div>
        <div class="gallery-card-meta">
          <span class="gallery-card-name" title="${item.name}">${item.name}</span>
          <span class="gallery-card-size">${formatBytes(item.size)}</span>
        </div>
      `;

      // Click card to open lightbox
      const thumbWrap = card.querySelector('.gallery-thumbnail-wrap');
      thumbWrap.addEventListener('click', () => {
        openLightbox(item);
      });

      // Checkbox selection
      const cb = card.querySelector('.file-select-cb');
      cb.addEventListener('change', (e) => {
        item.selected = e.target.checked;
        updateSelectedCount();
      });

      grid.appendChild(card);
    });

    updateSelectedCount();
  }

  function updateSelectedCount() {
    const selected = state.receivedFiles.filter((f) => f.selected);
    const label = $('gallery-selected-label');
    if (label) label.textContent = `Select all (${selected.length}/${state.receivedFiles.length})`;

    const selectAllCb = $('gallery-select-all');
    if (selectAllCb) selectAllCb.checked = selected.length === state.receivedFiles.length;
  }

  // Native Web Share Sheet
  async function saveSelectedToDevice() {
    const selected = state.receivedFiles.filter((f) => f.selected);
    if (selected.length === 0) {
      showToast('Select at least one photo or video');
      return;
    }

    const fileObjects = selected.map((s) => new File([s.blob], s.name, { type: s.type }));

    if (navigator.canShare && navigator.canShare({ files: fileObjects })) {
      try {
        await navigator.share({
          files: fileObjects,
          title: 'Snapferry Photos',
        });
        showToast('Saved to device!');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // User cancelled
        console.warn('[Share] navigator.share error, trying fallback:', err);
      }
    }

    // Fallback: trigger individual file downloads
    selected.forEach((s) => {
      const a = document.createElement('a');
      a.href = s.objectUrl;
      a.download = s.name;
      a.click();
    });
    showToast(`Downloading ${selected.length} file(s)...`);
  }

  // Download All as Store-only ZIP
  async function downloadSelectedZip() {
    const selected = state.receivedFiles.filter((f) => f.selected);
    if (selected.length === 0) {
      showToast('Select at least one file');
      return;
    }

    showToast('Building ZIP archive...');
    const zipBlob = await createStoreZip(selected);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = `snapferry-${Date.now()}.zip`;
    a.click();
    showToast('ZIP downloaded!');
  }

  // Full-screen Lightbox
  function openLightbox(item) {
    const lightbox = $('modal-lightbox');
    const mediaContainer = $('lightbox-media-container');
    const meta = $('lightbox-meta');
    if (!lightbox || !mediaContainer) return;

    mediaContainer.innerHTML = '';
    const isVideo = item.type.startsWith('video/') || item.name.match(/\.(mp4|mov|webm)$/i);

    if (isVideo) {
      const video = document.createElement('video');
      video.src = item.objectUrl;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      mediaContainer.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = item.objectUrl;
      img.alt = item.name;
      mediaContainer.appendChild(img);
    }

    if (meta) meta.textContent = `${item.name} (${formatBytes(item.size)})`;
    lightbox.classList.remove('hidden');
  }

  function closeLightbox() {
    const lightbox = $('modal-lightbox');
    const mediaContainer = $('lightbox-media-container');
    if (lightbox) lightbox.classList.add('hidden');
    if (mediaContainer) mediaContainer.innerHTML = '';
  }

  // --- MODALS & CONTROLS SETUP ---
  function initModals() {
    const wifiHelpBtn = $('wifi-help-btn');
    const wifiHelpModal = $('modal-wifi-help');
    const closeWifiBtn = $('btn-close-wifi-help');
    const dismissModalBtn = $('btn-modal-dismiss');

    const pasteModal = $('modal-paste-code');
    const closePasteBtn = $('btn-close-paste-modal');
    const submitPasteBtn = $('btn-submit-paste-code');
    const pasteTextarea = $('paste-modal-textarea');

    const senderScanModal = $('modal-sender-scanner');
    const closeSenderScanBtn = $('btn-close-sender-scanner');

    const closeLightboxBtn = $('btn-close-lightbox');

    function openModal(modal) {
      if (modal) modal.classList.remove('hidden');
    }
    function closeModal(modal) {
      if (modal) modal.classList.add('hidden');
    }

    if (wifiHelpBtn && wifiHelpModal) wifiHelpBtn.addEventListener('click', () => openModal(wifiHelpModal));
    if (closeWifiBtn && wifiHelpModal) closeWifiBtn.addEventListener('click', () => closeModal(wifiHelpModal));
    if (dismissModalBtn && wifiHelpModal) dismissModalBtn.addEventListener('click', () => closeModal(wifiHelpModal));
    if (closeLightboxBtn) closeLightboxBtn.addEventListener('click', closeLightbox);

    const btnSenderScan = $('btn-sender-open-scanner');
    if (btnSenderScan && senderScanModal) {
      btnSenderScan.addEventListener('click', () => {
        openModal(senderScanModal);
        startCameraScanner('sender-scanner-video', 'sender-scan-status', (answerToken) => {
          closeModal(senderScanModal);
          applyReceiverAnswer(answerToken);
        });
      });
    }
    if (closeSenderScanBtn && senderScanModal) {
      closeSenderScanBtn.addEventListener('click', () => {
        stopCameraScanner();
        closeModal(senderScanModal);
      });
    }

    const btnSenderPaste = $('btn-sender-paste-answer');
    if (btnSenderPaste && pasteModal) {
      btnSenderPaste.addEventListener('click', () => {
        state.activePasteTarget = 'sender-answer';
        $('paste-modal-title').textContent = 'Paste Receiver Answer Code';
        $('paste-modal-desc').textContent = 'Paste the answer code copied from Receiver:';
        if (pasteTextarea) pasteTextarea.value = '';
        openModal(pasteModal);
      });
    }

    const btnRecvPaste = $('btn-recv-paste-code');
    if (btnRecvPaste && pasteModal) {
      btnRecvPaste.addEventListener('click', () => {
        stopCameraScanner();
        state.activePasteTarget = 'receiver-offer';
        $('paste-modal-title').textContent = 'Paste Sender Offer Code';
        $('paste-modal-desc').textContent = 'Paste the offer code copied from Sender:';
        if (pasteTextarea) pasteTextarea.value = '';
        openModal(pasteModal);
      });
    }

    if (closePasteBtn && pasteModal) closePasteBtn.addEventListener('click', () => closeModal(pasteModal));

    if (submitPasteBtn && pasteModal && pasteTextarea) {
      submitPasteBtn.addEventListener('click', () => {
        const text = pasteTextarea.value.trim();
        if (!text) {
          showToast('Please paste a valid code');
          return;
        }
        closeModal(pasteModal);
        if (state.activePasteTarget === 'sender-answer') {
          applyReceiverAnswer(text);
        } else if (state.activePasteTarget === 'receiver-offer') {
          handleScannedOffer(text);
        }
      });
    }

    // Cancel Transfer Button
    const cancelBtn = $('btn-cancel-transfer');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        state.isTransferCancelled = true;
        state.isTransferring = false;
        stopMetricsTimer();
        releaseWakeLock();
        if (state.dc && state.dc.readyState === 'open') {
          state.dc.send(JSON.stringify({ type: 'cancel-transfer' }));
        }
        showToast('Transfer cancelled');
        $('transfer-subtitle').textContent = 'Transfer was cancelled.';
      });
    }

    // Gallery Actions
    const selectAllCb = $('gallery-select-all');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', (e) => {
        const val = e.target.checked;
        state.receivedFiles.forEach((f) => (f.selected = val));
        $$('.file-select-cb').forEach((cb) => (cb.checked = val));
        updateSelectedCount();
      });
    }

    const btnGalleryShare = $('btn-gallery-share');
    if (btnGalleryShare) {
      btnGalleryShare.addEventListener('click', saveSelectedToDevice);
    }

    const btnGalleryZip = $('btn-gallery-zip');
    if (btnGalleryZip) {
      btnGalleryZip.addEventListener('click', downloadSelectedZip);
    }

    $$('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay);
      });
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $$('.modal-overlay').forEach(closeModal);
        closeLightbox();
      }
    });
  }

  // --- 3D HERO TILT ---
  function init3DHero() {
    const stage = $('hero-3d-stage');
    const sceneBox = $('scene-3d-box');
    if (!stage || !sceneBox) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let targetRotX = 0, targetRotY = 0, curRotX = 0, curRotY = 0;

    function renderTilt() {
      curRotX += (targetRotX - curRotX) * 0.08;
      curRotY += (targetRotY - curRotY) * 0.08;
      sceneBox.style.transform = `rotateX(${curRotX.toFixed(2)}deg) rotateY(${curRotY.toFixed(2)}deg)`;
      requestAnimationFrame(renderTilt);
    }
    requestAnimationFrame(renderTilt);

    stage.addEventListener('mousemove', (e) => {
      const rect = stage.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      targetRotY = x * 22;
      targetRotX = -y * 18;
    });

    stage.addEventListener('mouseleave', () => {
      targetRotX = 0;
      targetRotY = 0;
    });

    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission !== 'function') {
      window.addEventListener('deviceorientation', (e) => {
        if (e.gamma !== null && e.beta !== null) {
          targetRotY = Math.max(-15, Math.min(15, e.gamma * 0.6));
          targetRotX = Math.max(-12, Math.min(12, (e.beta - 45) * 0.5));
        }
      }, { passive: true });
    }
  }

  // --- PWA INSTALLATION ---
  function initPWA() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
          .then((reg) => console.log('[PWA] SW registered:', reg.scope))
          .catch((err) => console.warn('[PWA] SW registration failed:', err));
      });
    }

    const installCard = $('install-cta');
    const installBtn = $('btn-install-pwa');
    const iosGuide = $('ios-install-guide');

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone && installCard) {
      installCard.classList.add('hidden');
      return;
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      if (installBtn) installBtn.classList.remove('hidden');
    });

    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (state.deferredInstallPrompt) {
          state.deferredInstallPrompt.prompt();
          state.deferredInstallPrompt = null;
          installBtn.classList.add('hidden');
        } else {
          showToast('Use browser menu to Add to Home Screen');
        }
      });
    }

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS && !isStandalone && iosGuide) {
      iosGuide.classList.remove('hidden');
      if (installBtn) installBtn.classList.add('hidden');
    }
  }

  // --- DEV MODE ---
  function initDevMode() {
    if (state.isDev) {
      sessionStorage.setItem('snapferry_dev', '1');
      const pill = $('dev-mode-pill');
      if (pill) {
        pill.classList.remove('hidden');
        pill.addEventListener('click', () => {
          showToast('Dev Mode: Copy/Paste fallback active. Open 2 tabs to test.');
        });
      }
      console.log('%c[Snapferry Dev Mode]%c Active! Test sender & receiver via Copy/Paste code.', 'color: #10b981; font-weight: bold', 'color: inherit');
    }
  }

  // --- FILE PICKER & DROP ZONE ---
  function initFileHandling() {
    const dropZone = $('sender-drop-zone');
    const fileInput = $('sender-file-input');
    const stagedPanel = $('staged-files-panel');
    const stagedList = $('staged-files-list');
    const countLabel = $('staged-count-label');
    const sizeLabel = $('staged-size-label');
    const clearBtn = $('btn-clear-staged');
    const continueBtn = $('btn-create-offer');

    if (!dropZone || !fileInput) return;

    function renderStagedFiles() {
      if (state.stagedFiles.length === 0) {
        stagedPanel.classList.add('hidden');
        return;
      }
      stagedPanel.classList.remove('hidden');
      stagedList.innerHTML = '';

      let totalBytes = 0;
      state.stagedFiles.forEach((file) => {
        totalBytes += file.size;
        const row = document.createElement('div');
        row.className = 'staged-file-row';
        row.innerHTML = `
          <span class="staged-file-name" title="${file.name}">${file.name}</span>
          <span class="staged-file-size">${formatBytes(file.size)}</span>
        `;
        stagedList.appendChild(row);
      });

      countLabel.textContent = `${state.stagedFiles.length} file${state.stagedFiles.length > 1 ? 's' : ''} selected`;
      sizeLabel.textContent = formatBytes(totalBytes);
    }

    function handleFiles(fileList) {
      const added = Array.from(fileList).filter((f) => f.size > 0);
      if (added.length === 0) {
        showToast('Please select photos or videos');
        return;
      }
      state.stagedFiles.push(...added);
      renderStagedFiles();
    }

    fileInput.addEventListener('change', (e) => {
      if (e.target.files) handleFiles(e.target.files);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files) {
        handleFiles(e.dataTransfer.files);
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        state.stagedFiles = [];
        fileInput.value = '';
        renderStagedFiles();
      });
    }

    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        startSenderHandshake();
      });
    }
  }

  // --- INITIALIZATION ---
  function init() {
    applyTheme(state.theme);

    const btnGotoSend = $('btn-goto-send');
    const btnGotoReceive = $('btn-goto-receive');

    if (btnGotoSend) {
      btnGotoSend.addEventListener('click', () => {
        state.role = 'sender';
        showScreen('send');
      });
    }

    if (btnGotoReceive) {
      btnGotoReceive.addEventListener('click', () => {
        state.role = 'receiver';
        showScreen('receive');
        startReceiverScan();
      });
    }

    $$('[data-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-target');
        showScreen(target);
      });
    });

    const themeToggleBtn = $('theme-toggle-btn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', toggleTheme);
    }

    const sendTestPingBtn = $('btn-send-test-ping');
    if (sendTestPingBtn) {
      sendTestPingBtn.addEventListener('click', () => {
        if (state.dc && state.dc.readyState === 'open') {
          const testMsg = JSON.stringify({ type: 'ping', t: Date.now(), msg: `Test Ping at ${new Date().toLocaleTimeString()}` });
          state.dc.send(testMsg);
          logPingMessage('Manual test ping sent ⚡', 'sent');
        } else {
          showToast('DataChannel not open yet');
        }
      });
    }

    window.addEventListener('hashchange', handleHashChange);
    if (window.location.hash) {
      handleHashChange();
    } else {
      showScreen('home');
    }

    init3DHero();
    initPWA();
    initDevMode();
    initFileHandling();
    initModals();

    console.log('[Snapferry] Engine Initialized.');
  }

  window.Snapferry = {
    state,
    showScreen,
    showToast,
    compressSDP,
    decompressSDP,
    renderAestheticQR,
    startSenderHandshake,
    startReceiverScan,
    applyReceiverAnswer,
    handleScannedOffer,
    startBatchTransfer,
    createStoreZip,
    computeSha256,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
