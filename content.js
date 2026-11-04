// content.js — injetado sob demanda (chrome.scripting) na aba onde a legenda foi ligada.
//
// Decisões:
// - Shadow DOM fechado: o CSS do site não alcança a legenda e vice-versa.
// - Elemento host com popover="manual": popovers vão para a "top layer" do navegador.
//   Quando o player entra em tela cheia (inclusive <video> nativo ou <iframe> de player),
//   o elemento em fullscreen também vai para a top layer; reabrindo o popover depois do
//   fullscreenchange, a legenda fica por cima dele. Sem isso, um position:fixed comum
//   some em tela cheia.
// - A legenda é posicionada sobre o maior <video> ou <iframe> visível da página.

(() => {
  // Reinjeção (navegação/recarga da extensão): derruba a instância anterior antes.
  window.__legendaPtBr?.destroy();

  let host = null;
  let textEl = null;
  let noticeEl = null;
  let positionTimer = null;
  let captionTimer = null;
  let noticeTimer = null;
  let currentFontSize = 20;

  // Sem fala nova (trechos de silêncio são descartados), a legenda antiga sai da tela.
  const CAPTION_HOLD_MS = 10000;
  const NOTICE_HOLD_MS = 6000;

  function ensureOverlay() {
    if (host) return;

    host = document.createElement('legenda-ptbr-overlay');
    host.setAttribute('popover', 'manual');
    // Neutraliza o estilo padrão de popover e qualquer CSS do site no host.
    const hostStyle = {
      position: 'fixed', margin: '0', padding: '0', border: '0', background: 'transparent',
      overflow: 'visible', inset: 'auto', 'pointer-events': 'none', 'z-index': '2147483647',
      left: '0px', top: '0px', width: '100vw', height: '100vh', color: 'inherit',
    };
    for (const [k, v] of Object.entries(hostStyle)) host.style.setProperty(k, v, 'important');
    host.style.setProperty('--legenda-font-size', `${currentFontSize}px`);

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .wrap {
          position: absolute; left: 0; right: 0; bottom: 8%;
          display: flex; justify-content: center; pointer-events: none;
        }
        .box {
          max-width: 90%;
          padding: 6px 14px;
          border-radius: 6px;
          background: rgba(0, 0, 0, 0.75);
          color: #fff;
          font: 500 var(--legenda-font-size, 20px) / 1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          text-align: center;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
          white-space: pre-wrap;
          word-break: break-word;
          transition: font-size 0.15s ease-out;
        }
        .box:empty { display: none; }
        .wrap { flex-direction: column; align-items: center; gap: 4px; }
        .notice {
          max-width: 80%;
          padding: 2px 8px;
          border-radius: 4px;
          background: rgba(0, 0, 0, 0.6);
          color: #fbbf24;
          font: 400 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          text-align: center;
        }
        .notice:empty { display: none; }
      </style>
      <div class="wrap"><div class="notice"></div><div class="box"></div></div>
    `;
    textEl = shadow.querySelector('.box');
    noticeEl = shadow.querySelector('.notice');

    (document.body || document.documentElement).appendChild(host);
    raise();

    document.addEventListener('fullscreenchange', onFullscreenChange, true);
    window.addEventListener('resize', updatePosition, true);
    window.addEventListener('scroll', updatePosition, true);
    // Players mudam de tamanho/posição sem disparar resize; um polling leve resolve.
    positionTimer = setInterval(updatePosition, 500);
    updatePosition();
  }

  // (Re)coloca o popover no topo da top layer.
  function raise() {
    if (!host) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Sem suporte a popover: fica como position:fixed normal.
    }
  }

  function onFullscreenChange() {
    raise();
    updatePosition();
  }

  // Escolhe o maior <video>/<iframe> visível; em tela cheia, usa a viewport inteira.
  function findTargetRect() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const viewport = { left: 0, top: 0, width: vw, height: vh };
    if (document.fullscreenElement) return viewport;

    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('video, iframe')) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) continue;
      // Recorta pela viewport para medir a área realmente visível.
      const left = Math.max(r.left, 0);
      const top = Math.max(r.top, 0);
      const right = Math.min(r.right, vw);
      const bottom = Math.min(r.bottom, vh);
      const area = Math.max(0, right - left) * Math.max(0, bottom - top);
      if (area > bestArea) {
        bestArea = area;
        best = { left, top, width: right - left, height: bottom - top };
      }
    }
    return best || viewport;
  }

  function updatePosition() {
    if (!host) return;
    const r = findTargetRect();
    host.style.setProperty('left', `${r.left}px`, 'important');
    host.style.setProperty('top', `${r.top}px`, 'important');
    host.style.setProperty('width', `${r.width}px`, 'important');
    host.style.setProperty('height', `${r.height}px`, 'important');
  }

  function setFontSize(sizePx) {
    if (!sizePx) return;
    currentFontSize = sizePx;
    if (host) host.style.setProperty('--legenda-font-size', `${sizePx}px`);
  }

  function setText(text) {
    ensureOverlay();
    textEl.textContent = text ?? '';
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => { if (textEl) textEl.textContent = ''; }, CAPTION_HOLD_MS);
  }

  function setNotice(text) {
    ensureOverlay();
    noticeEl.textContent = text ?? '';
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { if (noticeEl) noticeEl.textContent = ''; }, NOTICE_HOLD_MS);
  }

  function removeOverlay() {
    clearInterval(positionTimer);
    clearTimeout(captionTimer);
    clearTimeout(noticeTimer);
    positionTimer = captionTimer = noticeTimer = null;
    document.removeEventListener('fullscreenchange', onFullscreenChange, true);
    window.removeEventListener('resize', updatePosition, true);
    window.removeEventListener('scroll', updatePosition, true);
    host?.remove();
    host = null;
    textEl = null;
    noticeEl = null;
  }

  let hiddenByShortcut = false;

  function toggleVisibility() {
    if (!host) return;
    hiddenByShortcut = !hiddenByShortcut;
    host.style.setProperty('display', hiddenByShortcut ? 'none' : '', 'important');
  }

  function onMessage(msg) {
    if (msg?.target !== 'content') return;
    if (msg.type === 'caption') {
      if (msg.fontSize) setFontSize(msg.fontSize);
      setText(msg.text);
      if (msg.chunkEndedAt) {
        // Latência ponta a ponta: fim da gravação do trecho -> legenda na tela.
        // Date.now() é o mesmo relógio em todos os contextos da máquina.
        console.log(`[legenda] seq ${msg.seq}: latência ${Date.now() - msg.chunkEndedAt} ms`);
      }
    } else if (msg.type === 'set-font-size') {
      setFontSize(msg.fontSize);
    } else if (msg.type === 'notice') setNotice(msg.text);
    else if (msg.type === 'toggle-visibility') toggleVisibility();
    else if (msg.type === 'overlay-remove') removeOverlay();
  }

  chrome.runtime.onMessage.addListener(onMessage);

  window.__legendaPtBr = {
    destroy() {
      removeOverlay();
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* contexto invalidado */ }
    },
  };
})();
