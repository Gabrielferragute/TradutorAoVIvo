// lib/gemini.js — transcrição e tradução direta de áudio em 1 única chamada (Google Gemini).

import { ApiError, redactSecrets, errorFromFetchFailure, errorFromResponse } from './api-error.js';
import { LANGUAGES } from './settings.js';
import { isWhisperHallucination } from './stt.js';

export const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];
let activeModel = 'gemini-2.5-flash';
let detectedEndpoint = null; // { model, apiVersion, available }

export function getActiveModel() {
  return activeModel;
}

export function setActiveModel(model) {
  if (model && typeof model === 'string') {
    activeModel = model;
    if (detectedEndpoint) detectedEndpoint.model = model;
  }
}

// Descobre dinamicamente qual versão da API (v1 ou v1beta) e qual modelo a chave do usuário suporta
export async function detectWorkingModel(apiKey, { timeoutMs = 4000 } = {}) {
  if (detectedEndpoint) return detectedEndpoint;
  const key = cleanKey(apiKey);
  if (!key) return { model: 'gemini-2.5-flash', apiVersion: 'v1beta', available: GEMINI_MODELS };

  for (const ver of ['v1beta', 'v1']) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/${ver}/models?key=${key}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        const available = (data?.models || [])
          .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => m.name.replace(/^models\//, ''));

        if (available.length > 0) {
          const chosen = available.find((m) => m.includes('2.5') && m.includes('flash'))
            || available.find((m) => m.includes('2.0') && m.includes('flash'))
            || available.find((m) => m.includes('1.5') && m.includes('flash'))
            || available.find((m) => m.includes('flash'))
            || available[0];

          detectedEndpoint = { model: chosen, apiVersion: ver, available };
          activeModel = chosen;
          console.log(`[gemini] Modelo detectado automaticamente: "${chosen}" na API ${ver}`);
          return detectedEndpoint;
        }
      }
    } catch (e) {
      console.warn(`[gemini] Erro ao listar modelos em ${ver}:`, e?.message || e);
    }
  }

  // Fallback padrão se não conseguir listar
  detectedEndpoint = { model: 'gemini-2.5-flash', apiVersion: 'v1beta', available: GEMINI_MODELS };
  return detectedEndpoint;
}

export function getGeminiSystemPrompt(targetLang = 'pt-BR') {
  const langName = LANGUAGES[targetLang] || 'português do Brasil';
  return [
    'Você é um assistente especialista em transcrição e tradução de legendas técnicas em tempo real.',
    `Sua tarefa é ouvir o áudio em inglês, transcrevê-lo com precisão e traduzi-lo para o ${langName}.`,
    'Contexto: curso técnico da IBM sobre mainframe, COBOL, JCL, z/OS e Zowe.',
    'Glossário e terminologia: mantenha SEMPRE em inglês nomes de produtos, comandos, siglas e termos técnicos consagrados (ex.: JCL, dataset, job, copybook, Zowe, VS Code, Copilot, z/OS, TSO, ISPF, CICS, Db2, JES, spool). Não traduza literalmente termos como "job", "dataset", "copybook".',
    'Linguagem de legenda: curta, natural e direta.',
    'O áudio é capturado em trechos contínuos, podendo começar ou terminar no meio de frases. Transcreva e traduza o que existe sem inventar o que falta.',
    'Se o áudio for silêncio, apenas ruído de fundo, respiração ou não contiver fala perceptível, responda com {"en": "", "pt": ""}.',
    'Responda ESTRITAMENTE em formato JSON com as chaves "en" (transcrição em inglês) e "pt" (tradução em português).',
  ].join('\n');
}

export async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Limpa caracteres extras como aspas ou espaços acidentais ao copiar e colar
export function cleanKey(key) {
  return String(key ?? '').trim().replace(/^["'`]|["'`]$/g, '');
}

// Testa a chave do Gemini consultando a lista de modelos disponíveis
export async function testGeminiKey(apiKey, { timeoutMs = 6000 } = {}) {
  const key = cleanKey(apiKey);
  if (!key) throw new ApiError('no_key', 'Chave não preenchida');

  detectedEndpoint = null; // força nova detecção
  const detected = await detectWorkingModel(key, { timeoutMs });
  return { ok: true, activeModel: detected.model, apiVersion: detected.apiVersion, available: detected.available };
}

export async function speechTranslate(blob, context = [], apiKey, { timeoutMs = 8000, targetLang = 'pt-BR', model = null } = {}) {
  const key = cleanKey(apiKey);
  if (!key) throw new ApiError('no_key', 'Chave da API do Gemini não configurada');
  if (model) activeModel = model;

  const base64Audio = await blobToBase64(blob);
  // O Gemini exige MIME limpo, sem parâmetros adicionais como ";codecs=opus"
  const rawType = blob.type || 'audio/webm';
  const mimeType = rawType.split(';')[0].trim() || 'audio/webm';

  const sysPrompt = getGeminiSystemPrompt(targetLang);

  // Turnos anteriores para manter consistência de termos
  const contents = [];
  for (const c of context.slice(-2)) {
    contents.push(
      { role: 'user', parts: [{ text: `Trecho anterior em inglês: "${c.en}"` }] },
      { role: 'model', parts: [{ text: JSON.stringify({ en: c.en, pt: c.pt }) }] },
    );
  }

  // Turno atual com áudio multimodal
  contents.push({
    role: 'user',
    parts: [
      { inlineData: { mimeType, data: base64Audio } },
      { text: `Transcreva este áudio em inglês e traduza para o ${LANGUAGES[targetLang] || 'português do Brasil'}. Responda em JSON: {"en": "...", "pt": "..."}` },
    ],
  });

  // Descobre dinamicamente a versão da API e o modelo ativo para esta chave
  const detected = await detectWorkingModel(key);

  const attempts = [
    { model: detected.model, ver: detected.apiVersion },
    { model: 'gemini-2.5-flash', ver: 'v1beta' },
    { model: 'gemini-2.0-flash', ver: 'v1beta' },
    { model: 'gemini-1.5-flash', ver: 'v1beta' },
    { model: 'gemini-2.5-flash', ver: 'v1' },
    { model: 'gemini-2.0-flash', ver: 'v1' },
    { model: 'gemini-1.5-flash', ver: 'v1' },
  ];

  const uniqueAttempts = [];
  const seen = new Set();
  for (const a of attempts) {
    const k = `${a.ver}:${a.model}`;
    if (!seen.has(k)) {
      seen.add(k);
      uniqueAttempts.push(a);
    }
  }

  let lastError = null;
  for (const { model: candidate, ver } of uniqueAttempts) {
    const payload = {
      contents,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
      },
    };
    // systemInstruction só é suportado na API v1beta. Na v1 gera erro HTTP 400.
    if (ver === 'v1beta') {
      payload.systemInstruction = { parts: [{ text: sysPrompt }] };
    }

    const endpoint = `https://generativelanguage.googleapis.com/${ver}/models/${candidate}:generateContent?key=${key}`;
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw errorFromFetchFailure(err, timeoutMs);
    }

    if (!res.ok) {
      const err = await errorFromResponse(res);
      lastError = err;
      // Se for autenticação ou limite de cota, interrompe imediatamente (tentar outro modelo não resolve)
      if (err.kind === 'auth' || err.kind === 'quota') {
        throw err;
      }
      console.warn(`[gemini] ${ver}/models/${candidate} falhou (${err.message}). Tentando próximo candidato...`);
      continue;
    }

    detectedEndpoint = { model: candidate, apiVersion: ver };
    activeModel = candidate;

    let data;
    try {
      data = await res.json();
    } catch {
      throw new ApiError('http', 'Resposta inválida do Gemini (não é JSON)');
    }

    const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textContent) return { en: '', pt: '' };

    let parsed = {};
    try {
      parsed = JSON.parse(textContent);
    } catch {
      const cleaned = textContent.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      try { parsed = JSON.parse(cleaned); } catch { /* falha no parse */ }
    }

    let en = (parsed.en || '').trim();
    let pt = (parsed.pt || '').trim();

    if (isWhisperHallucination(en) || en.length < 2) {
      en = '';
      pt = '';
    }

    return { en, pt };
  }

  throw lastError || new ApiError('server', 'Não foi possível conectar a nenhum modelo Gemini');
}
