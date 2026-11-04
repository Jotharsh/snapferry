/**
 * Snapferry — Core PWA Client Application
 * Stage 2: Aesthetic QR Pairing, Multi-Frame Scanning, Serverless WebRTC DataChannel
 */

(() => {
  'use strict';

  // --- STATE ---
  const state = {
    currentScreen: 'home',
    theme: localStorage.getItem('snapferry_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    isDev: new URLSearchParams(window.location.search).has('dev') || sessionStorage.getItem('snapferry_dev') === '1',
    allowStun: false,
    deferredInstallPrompt: null,
    stagedFiles: [],
    receivedFiles: [],
    role: null, // 'sender' | 'receiver'
    pc: null,
    dc: null,
    qrCycleTimer: null,
    scannerStream: null,
    scannerRaf: null,
    scannerAccumulator: {},
    activePasteTarget: null, // 'sender-answer' | 'receiver-offer'
    wakeLock: null,
  };

  // --- DOM SELECTORS ---
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

    // Stop active camera when leaving scanner
    if (screenId !== 'receive' && state.scannerStream) {
      stopCameraScanner();
    }
    // Stop active QR cycling
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
    } catch (e) {
      // Audio autoplay policy or unavailable, silently ignore
    }
  }

  // --- CONFETTI CANNON (Pure Canvas 2D) ---
  function launchConfetti() {
    const canvas = $('confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#4f46e5', '#f97316', '#10b981', '#38bdf8', '#facc15'];
    const particles = [];
    for (let i = 0; i < 65; i++) {
      particles.push({
        x: canvas.width / 2,
        y: canvas.height * 0.4,
        vx: (Math.random() - 0.5) * 16,
        vy: (Math.random() - 0.7) * 14,
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
  }

  // --- BASE64URL ENCODING HELPERS ---
  function bytesToBase64Url(bytes) {
    let bin = '';
    const len = bytes.length;
    for (let i = 0; i < len; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  // --- COMPRESSION & DECOMPRESSION (CompressionStream with fflate fallback) ---
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
      } catch (e) {
        console.warn('[Compression] Native CompressionStream failed, trying fflate:', e);
      }
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
      } catch (e) {
        console.warn('[Decompression] Native DecompressionStream failed, trying fflate:', e);
      }
    }

    if (window.fflate && window.fflate.inflateSync) {
      try {
        const inf = window.fflate.inflateSync(bytes);
        const text = new TextDecoder().decode(inf);
        return text.split('\n').join('\r\n') + '\r\n';
      } catch (e) {
        console.warn('[Decompression] fflate failed:', e);
      }
    }

    const rawText = new TextDecoder().decode(bytes);
    return rawText.split('\n').join('\r\n') + '\r\n';
  }

  // --- AESTHETIC & DECORATIVE QR RENDERER ---
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

    // 1. Draw Data Modules as smooth rounded circles/dots
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

    // 2. Draw 3 Finder Patterns (Top-Left, Top-Right, Bottom-Left)
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

    // 3. Center Ferry Badge (with safe quiet zone)
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

  // --- CAMERA SCANNER (jsQR Loop + Multi-Frame Reassembly) ---
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
      console.warn('[Camera] Scanner initialization failed:', err);
      if (statusEl) {
        statusEl.innerHTML = '<span class="text-danger">Camera blocked. Use "Paste Code" fallback below.</span>';
      }
      showToast('Camera access denied or unavailable. Use Paste code.');
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

  // --- WEBRTC CORE (Non-trickle ICE, serverless) ---
  function createPeerConnection(isSender, allowStun) {
    const config = {
      iceServers: allowStun ? [{ urls: 'stun:stun.l.google.com:19302' }] : [],
    };
    const pc = new RTCPeerConnection(config);

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE Connection State:', pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection State:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        showToast('Direct P2P DataChannel connected!');
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

  function setupDataChannel(dc) {
    state.dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      console.log('[DataChannel] Open and ready!');
      requestWakeLock();
      playChime([523.25, 659.25, 783.99]);
      launchConfetti();
      showScreen('transfer');

      $('transfer-role-label').textContent = state.role === 'sender' ? 'Sender (Host)' : 'Receiver (Client)';
      $('stream-from-label').textContent = state.role === 'sender' ? 'This Device' : 'Sender';
      $('stream-to-label').textContent = state.role === 'sender' ? 'Receiver' : 'This Device';

      if (state.role === 'sender') {
        const pingMsg = JSON.stringify({ type: 'ping', t: Date.now(), msg: 'Hello from Sender' });
        dc.send(pingMsg);
        logPingMessage('Sent ping to Receiver ⚡', 'sent');
      }
    };

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const json = JSON.parse(event.data);
          if (json.type === 'ping') {
            logPingMessage(`Received ping from Sender: "${json.msg}"`, 'recv');
            const pongMsg = JSON.stringify({ type: 'pong', origT: json.t, t: Date.now(), msg: 'Pong from Receiver' });
            dc.send(pongMsg);
            logPingMessage('Sent pong to Sender ✓', 'sent');
          } else if (json.type === 'pong') {
            const rtt = Date.now() - json.origT;
            logPingMessage(`Received pong! RTT: ${rtt} ms ✓`, 'recv');
            showToast(`DataChannel Verified! RTT: ${rtt} ms`);
          }
        } catch (e) {
          console.warn('[DataChannel] String parse error:', e);
        }
      } else {
        console.log('[DataChannel] Received binary chunk:', event.data.byteLength);
      }
    };

    dc.onclose = () => {
      console.log('[DataChannel] Closed');
      releaseWakeLock();
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
    console.log('[Sender] Full Offer SDP Length:', fullOfferSdp.length);

    const compressed = await compressSDP(fullOfferSdp);
    console.log('[Sender] Compressed Offer Token Length:', compressed.length);

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
      console.log('[Sender] Decompressed Answer SDP Length:', answerSdp.length);
      await state.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      showToast('Answer applied! Establishing channel...');
    } catch (err) {
      console.error('[Sender] Failed to apply answer:', err);
      showToast('Invalid answer code. Please re-scan or re-paste.');
    }
  }

  // --- RECEIVER HANDSHAKE FLOW ---
  async function startReceiverScan() {
    $('receiver-phase-scan').classList.remove('hidden');
    $('receiver-phase-answer').classList.add('hidden');
    $('recv-step-pill-1').classList.add('active');
    $('recv-step-pill-2').classList.remove('active');

    startCameraScanner('receiver-video', 'receiver-scan-status', async (offerToken) => {
      console.log('[Receiver] Scanned Offer Token Length:', offerToken.length);
      await handleScannedOffer(offerToken);
    });
  }

  async function handleScannedOffer(offerToken) {
    try {
      $('receiver-phase-scan').classList.add('hidden');
      $('receiver-phase-answer').classList.remove('hidden');
      $('recv-step-pill-1').classList.remove('active');
      $('recv-step-pill-2').classList.add('active');

      const statusEl = $('receiver-qr-status');
      if (statusEl) statusEl.textContent = 'Generating local WebRTC answer...';

      const offerSdp = await decompressSDP(offerToken);
      console.log('[Receiver] Decompressed Offer SDP Length:', offerSdp.length);

      state.pc = createPeerConnection(false, state.allowStun);
      state.pc.ondatachannel = (e) => {
        console.log('[Receiver] Received Remote DataChannel');
        setupDataChannel(e.channel);
      };

      await state.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);

      await waitForIceGathering(state.pc, 2500);

      const fullAnswerSdp = state.pc.localDescription.sdp;
      console.log('[Receiver] Full Answer SDP Length:', fullAnswerSdp.length);

      const compressedAnswer = await compressSDP(fullAnswerSdp);
      console.log('[Receiver] Compressed Answer Token Length:', compressedAnswer.length);

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
      showToast('Error processing offer code. Try again.');
      $('receiver-phase-scan').classList.remove('hidden');
      $('receiver-phase-answer').classList.add('hidden');
    }
  }

  // --- MODALS & PASTE FALLBACK ---
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

    function openModal(modal) {
      if (modal) modal.classList.remove('hidden');
    }
    function closeModal(modal) {
      if (modal) modal.classList.add('hidden');
    }

    if (wifiHelpBtn && wifiHelpModal) {
      wifiHelpBtn.addEventListener('click', () => openModal(wifiHelpModal));
    }
    if (closeWifiBtn && wifiHelpModal) {
      closeWifiBtn.addEventListener('click', () => closeModal(wifiHelpModal));
    }
    if (dismissModalBtn && wifiHelpModal) {
      dismissModalBtn.addEventListener('click', () => closeModal(wifiHelpModal));
    }

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

    if (closePasteBtn && pasteModal) {
      closePasteBtn.addEventListener('click', () => closeModal(pasteModal));
    }

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

    $$('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay);
      });
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $$('.modal-overlay').forEach(closeModal);
      }
    });
  }

  // --- 3D HERO TILT & INTERACTION ---
  function init3DHero() {
    const stage = $('hero-3d-stage');
    const sceneBox = $('scene-3d-box');
    if (!stage || !sceneBox) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    let targetRotX = 0;
    let targetRotY = 0;
    let curRotX = 0;
    let curRotY = 0;

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

  // --- PWA INSTALLATION & SERVICE WORKER ---
  function initPWA() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
          .then((reg) => console.log('[PWA] Service Worker registered:', reg.scope))
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
          const { outcome } = await state.deferredInstallPrompt.userChoice;
          console.log('[PWA] Outcome:', outcome);
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

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    }

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

    console.log('[Snapferry] Pairing Engine, Aesthetic QR & Handshake Ready.');
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
  };

  document.addEventListener('DOMContentLoaded', init);
})();
