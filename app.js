/**
 * Snapferry — Core PWA Client Application
 * Stage 1: App Shell, Routing, PWA Setup, 3D Hero Scene & Handshake Foundations
 */

(() => {
  'use strict';

  // --- STATE ---
  const state = {
    currentScreen: 'home',
    theme: localStorage.getItem('snapferry_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    isDev: new URLSearchParams(window.location.search).has('dev') || sessionStorage.getItem('snapferry_dev') === '1',
    deferredInstallPrompt: null,
    stagedFiles: [],
    // Placeholders for WebRTC connection in next stages
    role: null, // 'sender' | 'receiver'
    pc: null,
    dc: null,
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

    // Update URL hash without extra history spam
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

  // --- THEME MANAGEMENT ---
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
    let rafId = null;

    function renderTilt() {
      curRotX += (targetRotX - curRotX) * 0.08;
      curRotY += (targetRotY - curRotY) * 0.08;
      sceneBox.style.transform = `rotateX(${curRotX.toFixed(2)}deg) rotateY(${curRotY.toFixed(2)}deg)`;
      rafId = requestAnimationFrame(renderTilt);
    }
    rafId = requestAnimationFrame(renderTilt);

    // Mouse movement on desktop
    stage.addEventListener('mousemove', (e) => {
      const rect = stage.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      targetRotY = x * 22; // max tilt 11 deg
      targetRotX = -y * 18;
    });

    stage.addEventListener('mouseleave', () => {
      targetRotX = 0;
      targetRotY = 0;
    });

    // Device orientation on mobile
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
    // Register Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
          .then((reg) => {
            console.log('[PWA] Service Worker registered:', reg.scope);
          })
          .catch((err) => {
            console.warn('[PWA] Service Worker registration failed:', err);
          });
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

    // Chrome / Android beforeinstallprompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      if (installBtn) {
        installBtn.classList.remove('hidden');
      }
    });

    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (state.deferredInstallPrompt) {
          state.deferredInstallPrompt.prompt();
          const { outcome } = await state.deferredInstallPrompt.userChoice;
          console.log('[PWA] Install prompt outcome:', outcome);
          state.deferredInstallPrompt = null;
          installBtn.classList.add('hidden');
        } else {
          showToast('Use browser menu to Add to Home Screen');
        }
      });
    }

    // Detect iOS Safari
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
          showToast('Dev Mode: Copy/Paste fallback active. Open another tab with ?dev=1 to test.');
        });
      }
      console.log('%c[Snapferry Dev Mode]%c Active! Two tabs can pair via Copy/Paste code.', 'color: #10b981; font-weight: bold', 'color: inherit');
    }
  }

  // --- FILE PICKER & DROP ZONE HANDLING ---
  function initFileHandling() {
    const dropZone = $('sender-drop-zone');
    const fileInput = $('sender-file-input');
    const stagedPanel = $('staged-files-panel');
    const stagedList = $('staged-files-list');
    const countLabel = $('staged-count-label');
    const sizeLabel = $('staged-size-label');
    const clearBtn = $('btn-clear-staged');

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
      state.stagedFiles.forEach((file, index) => {
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
      const added = Array.from(fileList).filter((f) => {
        return f.type.startsWith('image/') || f.type.startsWith('video/') || f.size > 0;
      });
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
  }

  // --- MODALS & HELP SHEET ---
  function initModals() {
    const wifiHelpBtn = $('wifi-help-btn');
    const wifiHelpModal = $('modal-wifi-help');
    const closeWifiBtn = $('btn-close-wifi-help');
    const dismissModalBtn = $('btn-modal-dismiss');

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

    // Close on overlay click
    $$('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay);
      });
    });

    // Close on Escape key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $$('.modal-overlay').forEach(closeModal);
      }
    });
  }

  // --- INITIALIZATION ---
  function init() {
    applyTheme(state.theme);

    // Event Listeners for Navigation Buttons
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

    console.log('[Snapferry] App Shell & Foundations Ready.');
  }

  // Export state & helpers to global for stage checks and dev console
  window.Snapferry = {
    state,
    showScreen,
    showToast,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
