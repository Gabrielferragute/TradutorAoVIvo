// lib/api-error.js — erros e higiene de segredos compartilhados pelos provedores.
//
// Todos os provedores lançam ApiError com o mesmo conjunto de "kind", para o offscreen
// tratar falhas de forma uniforme independentemente de quem as gerou.
// kind: 'no_key' | 'auth' | 'quota' | 'rate_limit' | 'server' | 'http' | 'network' | 'timeout' | 'empty'

export class ApiError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

// Remove trechos de chaves da OpenAI (sk-...) e do Google Gemini (AIza...) de mensagens.
// Tudo que vai para log ou tela passa por aqui.
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9_\-*.]+/g, 'sk-***')
    .replace(/AIza[0-9A-Za-z-_]{35}/g, 'AIza***');
}

// Converte falha do fetch (antes de haver resposta HTTP) em ApiError.
export function errorFromFetchFailure(err, timeoutMs) {
  if (err?.name === 'TimeoutError') return new ApiError('timeout', `Sem resposta em ${timeoutMs} ms`);
  return new ApiError('network', redactSecrets(err?.message || 'Falha de rede'));
}

// Converte resposta HTTP não-2xx em ApiError, já sem segredos na mensagem.
export async function errorFromResponse(res) {
  let code = '';
  let detail = '';
  let statusName = '';
  try {
    const body = await res.json();
    code = body?.error?.code || '';
    detail = body?.error?.message || '';
    statusName = body?.error?.status || '';
  } catch {
    // corpo não-JSON: fica só o status
  }
  const msg = redactSecrets(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);

  // Trata 401/403 e 400 com erro explícito de chave como auth
  const isKeyError = detail.toLowerCase().includes('api key') || detail.toLowerCase().includes('api_key');
  if (res.status === 401 || res.status === 403 || (res.status === 400 && isKeyError)) {
    return new ApiError('auth', msg, res.status);
  }
  if (res.status === 429 || statusName === 'RESOURCE_EXHAUSTED') {
    const isDailyQuota = detail.toLowerCase().includes('per day') || detail.toLowerCase().includes('quota exceeded') || code === 'insufficient_quota';
    return new ApiError(isDailyQuota ? 'quota' : 'rate_limit', msg, 429);
  }
  if (res.status >= 500) return new ApiError('server', msg, res.status);
  return new ApiError('http', msg, res.status);
}
