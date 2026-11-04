// offscreen.js — documento offscreen (MV3).
//
// Por que existe: o service worker não tem navigator.mediaDevices nem AudioContext.
// O offscreen document (reason USER_MEDIA) é uma página invisível da extensão onde
// essas APIs funcionam. Ele recebe o streamId gerado no background e abre a captura.
//
// Na Opção 1 (Gemini multimodal), o áudio WebM capturado é enviado diretamente para a API
// do Gemini, que transcreve e traduz em uma única requisição de alta velocidade.

import { speechTranslate, setActiveModel } from './lib/gemini.js';
import { redactSecrets } from './lib/api-error.js';
import { createSegmenter, hasEnoughVoice } from './lib/vad.js';
import { DEFAULT_SETTINGS } from './lib/settings.js';

// ---------- Parâmetros ----------
const LEVEL_SAMPLE_MS = 100;         // frequência de amostragem do RMS
const GEMINI_TIMEOUT_MS = 8000;      // limite de resposta do Gemini
const CONTEXT_SIZE = 2;              // frases anteriores mantidas para coerência
const MIME = 'audio/webm;codecs=opus';

// ---------- Estado ----------
let stream = null;
let audioCtx = null;
let levelTimer = null;
let apiKey = null;
let settings = { ...DEFAULT_SETTINGS };
let segmenter = null;
let pausedReason = null; // 'auth' | 'no_key' | 'quota' | null (pausa envio para economizar API)
let session = 0;        // invalida callbacks de uma captura anterior
let current = null;     // trecho sendo gravado
let nextSeq = 0;        // número de sequência dos trechos ENVIADOS
let nextToDeliver = 0;  // próximo seq a exibir (garante ordem)
const results = new Map();
let pipeline = Promise.resolve();
let context = [];                 // últimas traduções bem-sucedidas [{ en, pt }]
let consecutiveSilence = 0;
let stats = newStats();

function newStats() {
  return {
    total: 0,
    discardedSilent: 0,
    sent: 0,
    cutsPause: 0,
    cutsForced: 0,
    ok: 0,
    empty: 0,
    errors: 0,
    chunkDurationsMs: [],
    geminiMs: [],
  };
}

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// Para inspeção manual no console do offscreen: legendaStats()
globalThis.legendaStats = () => {
  const { chunkDurationsMs, geminiMs, ...counts } = stats;
  const summary = {
    ...counts,
    avgChunkMs: avg(chunkDurationsMs),
    avgGeminiMs: avg(geminiMs),
    pausedReason,
  };
  console.table(summary);
  return summary;
};

// ---------- Mensagens ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'start-capture') {
    apiKey = msg.apiKey || null; // nunca logar
    if (msg.settings) settings = { ...DEFAULT_SETTINGS, ...msg.settings };
    if (msg.model) setActiveModel(msg.model);
    pausedReason = !apiKey ? 'no_key' : null;
    startCapture(msg.streamId).then(
      () => sendResponse({ ok: true }),
      (err) => {
        stopCapture();
        sendResponse({ ok: false, error: redactSecrets(`${err?.name || 'Error'}: ${err?.message || err}`) });
      },
    );
    return true; // resposta assíncrona
  }

  if (msg.type === 'set-key') {
    apiKey = msg.apiKey || null;
    if (apiKey && (pausedReason === 'auth' || pausedReason === 'no_key')) {
      pausedReason = null;
      console.log('[legenda/offscreen] chave configurada; retomando envio de áudio');
      sendNotice('Chave configurada. Retomando legendas…');
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'update-settings') {
    if (msg.settings) {
      settings = { ...settings, ...msg.settings };
      segmenter?.setConfig(settings);
      console.log('[legenda/offscreen] configurações atualizadas');
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'stop-capture') {
    stopCapture();
    sendResponse({ ok: true });
  }
  return false;
});

// ---------- Captura ----------
async function startCapture(streamId) {
  if (stream) stopCapture();
  const mySession = ++session;

  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination); // Devolve áudio aos alto-falantes

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 4096;
  source.connect(analyser);

  const [track] = stream.getAudioTracks();
  track.addEventListener('ended', () => {
    stopCapture();
    chrome.runtime.sendMessage({ target: 'background', type: 'capture-ended' }).catch(() => {});
  });

  if (!MediaRecorder.isTypeSupported(MIME)) throw new Error(`MediaRecorder não suporta ${MIME}`);

  stats = newStats();
  nextSeq = 0;
  nextToDeliver = 0;
  results.clear();
  pipeline = Promise.resolve();
  context = [];
  segmenter = createSegmenter(settings);

  current = startSegment(mySession);
  startLevelSampler(analyser, mySession);

  console.log('[legenda/offscreen] captura iniciada com Gemini em 1 passo', track.label);
}

function stopCapture() {
  session++;
  clearInterval(levelTimer);
  levelTimer = null;
  if (current?.recorder.state === 'recording') current.recorder.stop();
  current = null;
  segmenter = null;
  pausedReason = null;
  results.clear();
  context = [];
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  audioCtx?.close().catch(() => {});
  audioCtx = null;
}

// ---------- Trechos e VAD ----------
function startSegment(mySession) {
  const recorder = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 32000 });
  const seg = { recorder, parts: [], startedAt: Date.now(), endedAt: null, cut: null };
  recorder.ondataavailable = (e) => { if (e.data?.size) seg.parts.push(e.data); };
  recorder.onstop = () => finishSegment(seg, mySession);
  recorder.start();
  return seg;
}

function rotate(mySession, cut) {
  if (mySession !== session || !stream) return;
  const prev = current;
  current = startSegment(mySession);
  prev.endedAt = Date.now();
  prev.cut = cut;
  prev.recorder.stop();
}

function startLevelSampler(analyser, mySession) {
  const buf = new Float32Array(analyser.fftSize);
  levelTimer = setInterval(() => {
    if (mySession !== session || !current) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    const cut = segmenter.push(rms, LEVEL_SAMPLE_MS);
    if (cut) {
      rotate(mySession, cut);
    }
  }, LEVEL_SAMPLE_MS);
}

function finishSegment(seg, mySession) {
  if (mySession !== session) return;
  stats.total++;

  const cutReason = seg.cut?.reason || 'pause';
  if (cutReason === 'forced') stats.cutsForced++;
  else stats.cutsPause++;

  const durationMs = seg.endedAt ? (seg.endedAt - seg.startedAt) : (seg.cut?.durationMs || 0);
  stats.chunkDurationsMs.push(durationMs);

  const blob = new Blob(seg.parts, { type: MIME });
  const tag = `trecho ${stats.total} [corte: ${cutReason === 'forced' ? 'forçado' : 'pausa'}, ${durationMs} ms, pico RMS ${seg.cut?.peakRms?.toFixed(4) || '0'}, voz ${seg.cut?.voicedMs || 0} ms, ${blob.size} B]`;

  if (!hasEnoughVoice(seg.cut, settings)) {
    stats.discardedSilent++;
    consecutiveSilence++;
    console.log(`[legenda/offscreen] ${tag}: descartado (silêncio)`);
    if (consecutiveSilence === 2) {
      sendNotice(`Aguardando fala audível (volume atual: RMS ${seg.cut?.peakRms?.toFixed(4) || '0'}). Aumente o som do vídeo se necessário.`);
    }
    return;
  }

  if (blob.size < 600) {
    console.log(`[legenda/offscreen] ${tag}: descartado (áudio vazio, tamanho ${blob.size} B)`);
    return;
  }
  consecutiveSilence = 0;

  if (pausedReason) {
    console.log(`[legenda/offscreen] ${tag}: descartado (envio pausado: ${pausedReason})`);
    return;
  }

  const seq = nextSeq++;
  stats.sent++;
  console.log(`[legenda/offscreen] ${tag}: enviado como seq ${seq}`);
  processSegment(seq, blob, seg, mySession);
}

// ---------- Processamento direto com Gemini em 1 chamada ----------
async function processSegment(seq, blob, seg, mySession) {
  const t0 = performance.now();
  let result;
  try {
    const res = await speechTranslate(blob, context, apiKey, {
      timeoutMs: GEMINI_TIMEOUT_MS,
      targetLang: settings.targetLang,
    });
    result = { ok: true, en: res.en, pt: res.pt };
  } catch (err) {
    result = {
      ok: false,
      kind: err?.kind || 'network',
      message: redactSecrets(err?.message || String(err)),
    };
  }
  if (mySession !== session) return;

  result.ms = Math.round(performance.now() - t0);
  result.chunkEndedAt = seg.endedAt;
  results.set(seq, result);
  flushInOrder(mySession);
}

function flushInOrder(mySession) {
  while (results.has(nextToDeliver)) {
    const seq = nextToDeliver;
    const r = results.get(seq);
    results.delete(seq);
    nextToDeliver++;
    pipeline = pipeline
      .then(() => deliver(seq, r, mySession))
      .catch((e) => console.error('[legenda/offscreen] erro inesperado na entrega:', redactSecrets(e?.message || e)));
  }
}

const GEMINI_NOTICES = {
  no_key: 'Sem chave da API do Gemini. Envio pausado até configurar.',
  auth: 'Chave da API do Gemini inválida ou sem permissão. Envio pausado.',
  quota: 'Cota diária gratuita do Gemini excedida. Crie uma nova chave gratuita no Google AI Studio (aistudio.google.com).',
  rate_limit: 'Limite de requisições por minuto (429). Tentando no próximo trecho…',
  network: 'Falha de rede. Tentando no próximo trecho…',
  timeout: 'Gemini demorou para responder; trecho pulado.',
  server: 'Instabilidade no servidor do Gemini. Tentando no próximo trecho…',
  http: 'Erro ao processar áudio no Gemini. Tentando no próximo trecho…',
};

async function deliver(seq, r, mySession) {
  if (mySession !== session) return;

  if (!r.ok) {
    stats.errors++;
    console.warn(`[legenda/offscreen] seq ${seq}: erro Gemini ${r.kind} — ${r.message}`);
    if (r.kind === 'auth' || r.kind === 'no_key' || r.kind === 'quota') {
      pausedReason = r.kind;
      console.warn(`[legenda/offscreen] envio de áudio pausado devido a ${r.kind}`);
    }
    const detail = r.message ? ` (${r.message})` : '';
    const baseNotice = GEMINI_NOTICES[r.kind] || GEMINI_NOTICES.http;
    sendNotice(`${baseNotice}${detail}`);
    return;
  }

  stats.ok++;
  stats.geminiMs.push(r.ms);

  if (!r.pt || r.pt.trim().length < 2) {
    stats.empty++;
    console.log(`[legenda/offscreen] seq ${seq}: silêncio ou texto curto (${r.ms} ms)`);
    return;
  }

  // Atualiza histórico de contexto para coerência das próximas frases
  context.push({ en: r.en || r.pt, pt: r.pt });
  if (context.length > CONTEXT_SIZE) context.shift();

  console.log(`[legenda/offscreen] seq ${seq}: EN "${r.en}" -> PT "${r.pt}" (Gemini ${r.ms} ms)`);
  sendCaption(seq, r.pt, r.chunkEndedAt);
}

function sendCaption(seq, text, chunkEndedAt) {
  chrome.runtime
    .sendMessage({ target: 'background', type: 'transcript', seq, text, chunkEndedAt })
    .catch(() => {});
}

function sendNotice(text) {
  chrome.runtime.sendMessage({ target: 'background', type: 'notice', text }).catch(() => {});
}
