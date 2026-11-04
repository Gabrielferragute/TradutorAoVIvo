// options.js — lógica da página de opções da extensão.

import { DEFAULT_SETTINGS, validateSettings, normalizeSettings } from './lib/settings.js';
import { testGeminiKey, cleanKey } from './lib/gemini.js';

const statusMessage = document.getElementById('statusMessage');
const keyStatusText = document.getElementById('keyStatusText');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const removeKeyBtn = document.getElementById('removeKeyBtn');

const targetLangSelect = document.getElementById('targetLangSelect');
const fontSizeInput = document.getElementById('fontSizeInput');
const fontPreview = document.getElementById('fontPreview');

const silenceThresholdInput = document.getElementById('silenceThresholdInput');
const pauseMsInput = document.getElementById('pauseMsInput');
const maxChunkMsInput = document.getElementById('maxChunkMsInput');

const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const resetDefaultsBtn = document.getElementById('resetDefaultsBtn');

let statusTimer = null;

function showStatus(text, type = 'success') {
  clearTimeout(statusTimer);
  statusMessage.textContent = text;
  statusMessage.className = `status-msg ${type}`;
  statusTimer = setTimeout(() => {
    statusMessage.className = 'status-msg';
    statusMessage.textContent = '';
  }, 4500);
}

function updateKeyDisplay(key) {
  if (key && typeof key === 'string' && key.trim()) {
    const trimmed = key.trim();
    const last4 = trimmed.length > 4 ? trimmed.slice(-4) : trimmed;
    const prefix = trimmed.startsWith('AIza') ? 'AIza...' : (trimmed.startsWith('sk-') ? 'sk-...' : '...');
    keyStatusText.textContent = `Chave configurada: ${prefix}${last4}`;
    keyStatusText.className = 'key-status saved';
  } else {
    keyStatusText.textContent = 'Nenhuma chave configurada';
    keyStatusText.className = 'key-status empty';
  }
}

function updatePreview() {
  const size = Math.max(12, Math.min(48, Number(fontSizeInput.value) || 20));
  fontPreview.style.fontSize = `${size}px`;
}

function fillForm(settings) {
  targetLangSelect.value = settings.targetLang || DEFAULT_SETTINGS.targetLang;
  fontSizeInput.value = settings.fontSize ?? DEFAULT_SETTINGS.fontSize;
  silenceThresholdInput.value = settings.silenceThreshold ?? DEFAULT_SETTINGS.silenceThreshold;
  pauseMsInput.value = settings.pauseMs ?? DEFAULT_SETTINGS.pauseMs;
  maxChunkMsInput.value = settings.maxChunkMs ?? DEFAULT_SETTINGS.maxChunkMs;
  updatePreview();
}

async function load() {
  const { geminiKey, openaiKey, settings } = await chrome.storage.local.get(['geminiKey', 'openaiKey', 'settings']);
  updateKeyDisplay(geminiKey || openaiKey);
  const current = normalizeSettings(settings);
  fillForm(current);
}

const testKeyBtn = document.getElementById('testKeyBtn');

// Eventos da Chave
saveKeyBtn.addEventListener('click', async () => {
  const raw = cleanKey(apiKeyInput.value);
  if (!raw) {
    showStatus('Por favor, informe uma chave válida para salvar.', 'error');
    return;
  }
  await chrome.storage.local.set({ geminiKey: raw, openaiKey: raw });
  apiKeyInput.value = '';
  updateKeyDisplay(raw);
  showStatus('Chave da API salva com sucesso! Clique em "Testar Conexão" para validar.');
});

testKeyBtn.addEventListener('click', async () => {
  let key = cleanKey(apiKeyInput.value);
  if (!key) {
    const stored = await chrome.storage.local.get(['geminiKey', 'openaiKey']);
    key = cleanKey(stored.geminiKey || stored.openaiKey);
  }
  if (!key) {
    showStatus('Por favor, informe uma chave para testar.', 'error');
    return;
  }

  showStatus('Testando comunicação com o Google Gemini...', 'success');
  try {
    const res = await testGeminiKey(key);
    showStatus(`✓ Conexão bem-sucedida! Modelo ativo: ${res.activeModel} (API ${res.apiVersion})`, 'success');
  } catch (err) {
    showStatus(`✕ Falha ao conectar: ${err.message}`, 'error');
  }
});

removeKeyBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['geminiKey', 'openaiKey']);
  apiKeyInput.value = '';
  updateKeyDisplay(null);
  showStatus('Chave da API removida.');
});

// Pré-visualização da fonte ao digitar
fontSizeInput.addEventListener('input', updatePreview);

// Salvar Configurações
saveSettingsBtn.addEventListener('click', async () => {
  const rawInput = {
    targetLang: targetLangSelect.value,
    fontSize: fontSizeInput.value,
    silenceThreshold: silenceThresholdInput.value,
    pauseMs: pauseMsInput.value,
    maxChunkMs: maxChunkMsInput.value,
  };

  const validation = validateSettings(rawInput);
  if (!validation.ok) {
    showStatus(validation.errors.join(' '), 'error');
    return;
  }

  // Preserva os outros campos internos de settings (como minChunkMs, minVoicedMs)
  const { settings: prev } = await chrome.storage.local.get('settings');
  const merged = { ...normalizeSettings(prev), ...validation.value };

  await chrome.storage.local.set({ settings: merged });
  showStatus('Configurações salvas com sucesso!');
});

// Restaurar Padrões
resetDefaultsBtn.addEventListener('click', async () => {
  fillForm(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
  showStatus('Configurações restauradas para os padrões originais.');
});

// Inicialização
load();
