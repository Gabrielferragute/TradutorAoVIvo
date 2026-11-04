// background.js — service worker (MV3).
//
// Por que tudo passa por aqui:
// - Só o service worker recebe chrome.action.onClicked e pode chamar
//   chrome.tabCapture.getMediaStreamId (que exige o "gesto" do clique no ícone).
// - O service worker NÃO tem DOM nem navigator.mediaDevices/AudioContext. Por isso a
//   captura em si acontece num offscreen document (offscreen.js), que recebe o streamId.
// - O service worker pode ser encerrado pelo Chrome a qualquer momento quando ocioso.
//   O estado (qual aba está ativa) fica em chrome.storage.session, não em variáveis.

import { normalizeSettings } from './lib/settings.js';

const OFFSCREEN_URL = 'offscreen.html';

const ICONS_ON = {
  16: 'icons/on-16.png', 32: 'icons/on-32.png', 48: 'icons/on-48.png', 128: 'icons/on-128.png',
};
const ICONS_OFF = {
  16: 'icons/off-16.png', 32: 'icons/off-32.png', 48: 'icons/off-48.png', 128: 'icons/off-128.png',
};

// ---------- Estado persistente (sobrevive à suspensão do service worker) ----------

async function getActiveTabId() {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  return activeTabId ?? null;
}

async function setActiveTabId(tabId) {
  if (tabId == null) await chrome.storage.session.remove('activeTabId');
  else await chrome.storage.session.set({ activeTabId: tabId });
}

// ---------- Clique no ícone: liga/desliga ----------

// Evita corrida se o usuário clicar duas vezes rápido.
let busy = false;

function isRestrictedTab(tab) {
  if (!tab?.url) return false;
  const url = tab.url.toLowerCase();
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('view-source:') ||
    url.includes('chromewebstore.google.com') ||
    url.includes('chrome.google.com/webstore')
  );
}

chrome.action.onClicked.addListener(async (tab) => {
  if (busy || tab.id == null) return;
  busy = true;
  try {
    if (isRestrictedTab(tab)) {
      await flashError(tab.id, 'Páginas do navegador (chrome://) não permitem captura de áudio. Abra um vídeo normal.');
      return;
    }

    const current = await getActiveTabId();
    if (current === tab.id) {
      await stopCapture();
      return;
    }
    // Mantemos uma aba por vez.
    if (current != null) await stopCapture();
    await startCapture(tab);
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn('[legenda] falha ao iniciar:', msg);
    await stopCapture().catch(() => {});
    await flashError(tab.id, msg);
  } finally {
    busy = false;
  }
});

async function startCapture(tab) {
  // 1) Injeta o content script só nesta aba (activeTab concedido pelo clique).
  await injectContent(tab.id);

  // 2) Garante o offscreen document com handshake (ping/pong)
  await ensureOffscreen();

  // 3) Gera o streamId no service worker (precisa do gesto do usuário) e o entrega ao
  //    offscreen, que o consome com getUserMedia.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  // Offscreen documents só têm chrome.runtime; a chave e configurações vão junto.
  const apiKey = await getApiKey();
  const settings = await getSettings();
  await chrome.storage.local.remove('activeGeminiModel').catch(() => {});
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start-capture',
    streamId,
    apiKey,
    settings,
    model: 'gemini-2.5-flash',
  });
  if (!res?.ok) throw new Error(res?.error || 'Offscreen não respondeu ao start-capture');

  await setActiveTabId(tab.id);
  await setIndicator(tab.id, true);
  await sendToTab(tab.id, {
    target: 'content',
    type: 'caption',
    text: 'Legenda ativa: aguardando fala…',
    fontSize: settings.fontSize,
  });

  if (!apiKey) {
    await sendToTab(tab.id, {
      target: 'content',
      type: 'notice',
      text: 'Sem chave da API. Configure sua chave do Google Gemini nas opções.',
    });
  }
}

async function stopCapture() {
  const tabId = await getActiveTabId();
  await setActiveTabId(null);

  // Avisa o offscreen para interromper os tracks de áudio e AudioContext imediatamente.
  // Mantemos o documento offscreen vivo para evitar problemas de concorrência ao reabrir.
  if (await hasOffscreen()) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture' });
    } catch {}
  }

  if (tabId != null) {
    await setIndicator(tabId, false);
    await sendToTab(tabId, { target: 'content', type: 'overlay-remove' });
  }
}

// ---------- Offscreen document ----------

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) {
    try {
      const ping = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
      if (ping?.ok) return;
    } catch {
      // Documento órfão que não responde ao ping: fecha antes de recriar
      try { await chrome.offscreen.closeDocument(); } catch {}
    }
  }

  if (!creatingOffscreen) {
    creatingOffscreen = (async () => {
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['USER_MEDIA'],
          justification: 'Capturar o áudio da aba para gerar legendas.',
        });
      } catch (err) {
        if (!String(err).includes('Only a single offscreen document')) {
          throw err;
        }
      }

      // Aguarda até o offscreen.js carregar seus imports e responder ao ping
      for (let i = 0; i < 30; i++) {
        try {
          const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
          if (res?.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('Offscreen document criado, mas não respondeu ao ping de inicialização');
    })().finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

// ---------- Mensagens vindas do offscreen ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'background') return false;

  if (msg.type === 'capture-ended') {
    // O stream da aba terminou por fora (ex.: aba descartada). Desliga tudo.
    stopCapture().catch((e) => console.error('[legenda] stop após capture-ended:', e));
  } else if (msg.type === 'transcript') {
    relayToActiveTab({ target: 'content', type: 'caption', text: msg.text, seq: msg.seq, chunkEndedAt: msg.chunkEndedAt });
  } else if (msg.type === 'notice') {
    relayToActiveTab({ target: 'content', type: 'notice', text: msg.text });
  }
  return false;
});

async function relayToActiveTab(msg) {
  const tabId = await getActiveTabId();
  if (tabId != null) await sendToTab(tabId, msg);
}

// ---------- Chave e configurações ----------

async function getApiKey() {
  const { geminiKey, openaiKey } = await chrome.storage.local.get(['geminiKey', 'openaiKey']);
  return geminiKey || openaiKey || null;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettings(settings);
}

// Ouvir alterações em storage.local: propaga ao vivo para offscreen e content script.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  if ('geminiKey' in changes || 'openaiKey' in changes) {
    const newKey = changes.geminiKey ? changes.geminiKey.newValue : (changes.openaiKey ? changes.openaiKey.newValue : null);
    if (await hasOffscreen()) {
      chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'set-key', apiKey: newKey || null })
        .catch(() => {});
    }
  }

  if ('settings' in changes) {
    const updated = normalizeSettings(changes.settings.newValue);
    if (await hasOffscreen()) {
      chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'update-settings', settings: updated })
        .catch(() => {});
    }
    // Atualiza tamanho da fonte na legenda ao vivo
    relayToActiveTab({ target: 'content', type: 'set-font-size', fontSize: updated.fontSize });
  }
});

// ---------- Ciclo de vida da aba ----------

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getActiveTabId())) await stopCapture();
});

// Recarregar/navegar a aba destrói o content script, mas a captura continua.
// Reinjetamos; se o activeTab não valer mais (navegou para outra origem), desligamos.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  if (tabId !== (await getActiveTabId())) return;
  try {
    const settings = await getSettings();
    await injectContent(tabId);
    await setIndicator(tabId, true);
    await sendToTab(tabId, {
      target: 'content',
      type: 'caption',
      text: 'Legenda ativa: aguardando fala…',
      fontSize: settings.fontSize,
    });
  } catch (err) {
    console.warn('[legenda] não foi possível reinjetar após navegação; desligando.', err);
    await stopCapture();
  }
});

// ---------- Utilidades ----------

async function injectContent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (err) {
    throw new Error('Não foi possível injetar o script na aba (página protegida pelo navegador ou sem permissão).');
  }
}

async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Aba fechada ou sem content script: nada a fazer.
  }
}

async function setIndicator(tabId, on) {
  try {
    await chrome.action.setIcon({ tabId, path: on ? ICONS_ON : ICONS_OFF });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    await chrome.action.setTitle({
      tabId,
      title: on ? 'Legenda PT-BR: ligada (clique para desligar)' : 'Legenda PT-BR: desligada (clique para ligar)',
    });
  } catch {
    // Aba pode ter sido fechada no meio do caminho.
  }
}

// Erro antes de existir legenda na tela (ex.: página chrome://): sinaliza no ícone.
async function flashError(tabId, message) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: `Legenda PT-BR: erro — ${message}` });
    setTimeout(() => setIndicator(tabId, false), 5000);
  } catch {
    // ignora
  }
}

// ---------- Atalhos de Teclado (Fase 5) ----------

chrome.commands?.onCommand.addListener(async (command) => {
  if (command === 'toggle-overlay') {
    const tabId = await getActiveTabId();
    if (tabId != null) {
      await sendToTab(tabId, { target: 'content', type: 'toggle-visibility' });
    }
  }
});
