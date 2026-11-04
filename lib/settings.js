// lib/settings.js — configurações: padrões, limites e validação.
//
// Fonte única dos valores padrão, compartilhada por options.js (formulário), background.js
// (lê do storage e normaliza) e offscreen.js (usa no corte e na tradução).
// Lógica pura, sem chrome.*, para ser testável no Node.
//
// Armazenamento (chrome.storage.local):
//   openaiKey: string            (mantido separado, compatível com o método pelo console)
//   settings:  { ...campos abaixo }

export const LANGUAGES = {
  'pt-BR': 'português do Brasil',
  'pt-PT': 'português de Portugal',
  es: 'espanhol',
  fr: 'francês',
  de: 'alemão',
  it: 'italiano',
};

export const DEFAULT_SETTINGS = Object.freeze({
  // Legenda
  fontSize: 20,             // px
  targetLang: 'pt-BR',
  // Corte por pausa (lib/vad.js) otimizado para baixa latência (~3s total)
  silenceThreshold: 0.003,  // RMS abaixo disso = silêncio
  pauseMs: 250,             // pausa rápida para cortar logo após a frase (250 ms)
  minChunkMs: 1200,         // nunca corta antes de 1.2s
  targetChunkMs: 2200,      // a partir de 2.2s, corta na primeira respiração/pausa
  maxChunkMs: 4500,         // corte forçado em 4.5s
  minVoicedMs: 200,         // tempo mínimo de voz para enviar (200 ms)
});

// Faixas aceitas. Os 4 primeiros aparecem na página de opções; os demais só podem ser
// alterados direto no storage (ou mudando DEFAULT_SETTINGS).
export const LIMITS = {
  fontSize: { min: 12, max: 48, integer: true, label: 'Tamanho da fonte', unit: 'px' },
  silenceThreshold: { min: 0.001, max: 0.2, label: 'Limiar de silêncio' },
  pauseMs: { min: 150, max: 2000, integer: true, label: 'Pausa mínima', unit: 'ms' },
  maxChunkMs: { min: 2500, max: 15000, integer: true, label: 'Duração máxima do trecho', unit: 'ms' },
  minChunkMs: { min: 1000, max: 5000, integer: true, label: 'Duração mínima do trecho', unit: 'ms' },
  targetChunkMs: { min: 1500, max: 10000, integer: true, label: 'Duração alvo do trecho', unit: 'ms' },
  minVoicedMs: { min: 0, max: 2000, integer: true, label: 'Tempo mínimo de voz', unit: 'ms' },
};

const fmt = (n) => Number(n).toLocaleString('pt-BR');

// Valida um objeto parcial (valores podem vir como string do formulário).
// Retorna { ok, errors: string[], value } com apenas os campos válidos convertidos.
export function validateSettings(input) {
  const errors = [];
  const value = {};
  for (const [key, raw] of Object.entries(input || {})) {
    if (key === 'targetLang') {
      if (Object.hasOwn(LANGUAGES, raw)) value.targetLang = raw;
      else errors.push('Idioma de destino inválido.');
      continue;
    }
    const lim = LIMITS[key];
    if (!lim) continue; // campo desconhecido: ignora
    const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw.trim().replace(',', '.'))) : Number(raw);
    if (!Number.isFinite(n) || n < lim.min || n > lim.max) {
      errors.push(`${lim.label}: informe um número entre ${fmt(lim.min)} e ${fmt(lim.max)}${lim.unit ? ` ${lim.unit}` : ''}.`);
      continue;
    }
    value[key] = lim.integer ? Math.round(n) : n;
  }

  const min = value.minChunkMs ?? DEFAULT_SETTINGS.minChunkMs;
  const max = value.maxChunkMs ?? DEFAULT_SETTINGS.maxChunkMs;
  if (max < min) errors.push(`Duração máxima do trecho deve ser maior ou igual à mínima (${fmt(min)} ms).`);

  return { ok: errors.length === 0, errors, value };
}

// Mescla o que está salvo com os padrões, ignorando valores inválidos/corrompidos.
export function normalizeSettings(stored) {
  const out = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') Object.assign(out, validateSettings(stored).value);
  if (out.maxChunkMs < out.minChunkMs) out.maxChunkMs = Math.max(DEFAULT_SETTINGS.maxChunkMs, out.minChunkMs);
  return out;
}
