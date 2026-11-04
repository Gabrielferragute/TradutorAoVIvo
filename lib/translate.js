// lib/translate.js — tradução EN -> PT-BR (ou idioma configurado).
//
// Interface estável usada pelo resto da extensão:
//   translate(text, context, apiKey, opts?) -> Promise<string>
//   context = [{ en, pt }, ...]  (últimas traduções bem-sucedidas, mais antiga primeiro)
// Para trocar de provedor (DeepL etc.), basta outro módulo com a mesma assinatura que
// lance ApiError (lib/api-error.js) com os mesmos "kind".

import { ApiError, redactSecrets, errorFromFetchFailure, errorFromResponse } from './api-error.js';
import { LANGUAGES } from './settings.js';

// Função para gerar o prompt de sistema de acordo com o idioma de destino.
export function getSystemPrompt(targetLang = 'pt-BR') {
  const langName = LANGUAGES[targetLang] || 'português do Brasil';
  return [
    'Você traduz legendas ao vivo.',
    `Traduza do inglês para o ${langName}, em linguagem natural de legenda: curta e direta.`,
    'Contexto: curso técnico da IBM sobre mainframe, COBOL, JCL, z/OS e Zowe.',
    'Mantenha em inglês nomes de produtos, comandos, siglas e termos técnicos consagrados (ex.: JCL, dataset, job, copybook, Zowe, VS Code, Copilot, z/OS).',
    'As mensagens anteriores desta conversa são as últimas frases já traduzidas e servem apenas como contexto de coerência. Traduza SOMENTE o trecho novo (a última mensagem).',
    'O trecho pode começar ou terminar no meio de uma frase, porque o áudio é cortado em intervalos fixos. Traduza o que existe sem inventar o que falta.',
    'Responda APENAS com a tradução, sem aspas, explicações ou prefixos.',
  ].join('\n');
}

// Mantido por compatibilidade com testes e chamadas sem parâmetro
export const SYSTEM_PROMPT = getSystemPrompt('pt-BR');

export const TRANSLATE_MODEL = 'gpt-4o-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// Português costuma ter ~20% mais caracteres que o inglês; em tokens, metade do número
// de caracteres de entrada já sobra bastante. O limite evita respostas descontroladas.
export function maxTokensFor(text) {
  return Math.min(512, Math.max(32, Math.ceil(text.length / 2) + 16));
}

export async function translate(text, context = [], apiKey, { timeoutMs = 6000, model = TRANSLATE_MODEL, targetLang = 'pt-BR' } = {}) {
  if (!apiKey) throw new ApiError('no_key', 'Chave da API não configurada');
  const source = String(text ?? '').trim();
  if (!source) return '';

  const sysPrompt = getSystemPrompt(targetLang);

  // O contexto vai como turnos anteriores (usuário = EN, assistente = PT): o modelo vê
  // como traduziu antes e continua no mesmo padrão, sem retraduzir o que já respondeu.
  const messages = [{ role: 'system', content: sysPrompt }];
  for (const c of context.slice(-2)) {
    messages.push({ role: 'user', content: c.en }, { role: 'assistant', content: c.pt });
  }
  messages.push({ role: 'user', content: source });

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokensFor(source), messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw errorFromFetchFailure(err, timeoutMs);
  }

  if (!res.ok) throw await errorFromResponse(res);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('http', 'Resposta inválida da API de tradução');
  }
  const out = cleanOutput(data?.choices?.[0]?.message?.content);
  if (!out) throw new ApiError('empty', 'Resposta vazia do modelo');
  return out;
}

// Rede de segurança caso o modelo ignore "sem aspas/prefixos".
function cleanOutput(s) {
  let out = String(s ?? '').trim();
  out = out.replace(/^(pt(-br)?|tradução|translation)\s*:\s*/i, '');
  const m = out.match(/^["“'«](.*)["”'»]$/s);
  if (m) out = m[1].trim();
  return out;
}

// Nunca deixa a legenda vazia por erro de tradução: devolve o inglês com o motivo.
// Se a tradução resultar numa string idêntica ao inglês (ex: termo técnico mantido), é considerada ok.
// Resultado: { ok, text, ms, kind?, message? }
export async function translateWithFallback(text, context, apiKey, opts) {
  const t0 = performance.now();
  try {
    const pt = await translate(text, context, apiKey, opts);
    return { ok: true, text: pt, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return {
      ok: false,
      text,
      ms: Math.round(performance.now() - t0),
      kind: err?.kind || 'network',
      message: redactSecrets(err?.message || String(err)),
    };
  }
}
