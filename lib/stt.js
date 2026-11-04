// lib/stt.js — transcrição (speech-to-text).
//
// Interface estável usada pelo resto da extensão:
//   transcribe(blob, apiKey, opts?) -> Promise<string>
// Para trocar de provedor (Deepgram, Whisper local...), basta outro módulo com a
// mesma assinatura que lance ApiError (lib/api-error.js) com os mesmos "kind".
//
// Roda no offscreen document (é lá que os trechos de áudio existem). A host_permission
// para api.openai.com faz o fetch da extensão não depender de CORS.

import { ApiError, errorFromFetchFailure, errorFromResponse } from './api-error.js';

// Frases que o Whisper costuma "inventar" em trechos com ruído/música sem fala.
// Só são descartadas quando o trecho INTEIRO é exatamente uma delas (comparação em
// minúsculas, sem pontuação). Edite à vontade.
export const WHISPER_HALLUCINATIONS = [
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'bye',
  'you',
];

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

// Vocabulário que orienta o Whisper a grafar termos técnicos corretamente.
export const STT_PROMPT =
  'IBM, mainframe, COBOL, JCL, Zowe, z/OS, TSO, ISPF, CICS, Db2, dataset, PDS, copybook, ' +
  'job, JES, spool, VS Code, Copilot, Zowe Explorer, Zowe CLI.';

const HALLUCINATION_SET = new Set(WHISPER_HALLUCINATIONS.map(normalizePhrase));

function normalizePhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isWhisperHallucination(text) {
  return HALLUCINATION_SET.has(normalizePhrase(text));
}

export async function transcribe(blob, apiKey, { timeoutMs = 10000, filename = 'chunk.webm' } = {}) {
  if (!apiKey) throw new ApiError('no_key', 'Chave da API não configurada');

  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('prompt', STT_PROMPT);
  form.append('response_format', 'json');
  form.append('temperature', '0');

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw errorFromFetchFailure(err, timeoutMs);
  }

  if (!res.ok) throw await errorFromResponse(res);

  const data = await res.json();
  return (data?.text || '').trim();
}
