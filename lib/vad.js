// lib/vad.js — corte de trechos por pausa (VAD simples por nível RMS).
//
// Lógica pura, sem APIs do navegador, para ser testável no Node. O offscreen alimenta
// push(rms, dtMs) a cada ~100 ms; quando a função devolve um "corte", ele troca de gravador.
//
// Regras:
// - nunca corta antes de max(minChunkMs, targetChunkMs);
// - a partir daí, corta assim que houver pauseMs consecutivos abaixo de silenceThreshold;
// - em maxChunkMs, corta de qualquer jeito ("forced").

export function createSegmenter(initialCfg) {
  let cfg = pick(initialCfg);
  let pending = null; // configuração nova só vale a partir do próximo trecho
  let s;

  function reset() {
    if (pending) {
      cfg = pending;
      pending = null;
    }
    s = { durationMs: 0, voicedMs: 0, silenceRunMs: 0, peakRms: 0 };
  }
  reset();

  return {
    // Retorna null ou { reason: 'pause'|'forced', durationMs, voicedMs, silenceRunMs, peakRms }.
    push(rms, dtMs) {
      s.durationMs += dtMs;
      if (rms > s.peakRms) s.peakRms = rms;
      if (rms >= cfg.silenceThreshold) {
        s.voicedMs += dtMs;
        s.silenceRunMs = 0;
      } else {
        s.silenceRunMs += dtMs;
      }

      let reason = null;
      if (s.durationMs >= cfg.maxChunkMs) reason = 'forced';
      else if (s.durationMs >= Math.max(cfg.minChunkMs, cfg.targetChunkMs) && s.silenceRunMs >= cfg.pauseMs) reason = 'pause';
      if (!reason) return null;

      const cut = { reason, ...s };
      reset();
      return cut;
    },
    setConfig(next) {
      pending = pick(next);
    },
    reset,
    get state() {
      return { ...s };
    },
  };
}

// Trecho sem voz suficiente é descartado como silêncio (não vai ao Whisper).
export function hasEnoughVoice(seg, cfg) {
  return (seg?.voicedMs ?? 0) >= cfg.minVoicedMs;
}

function pick(c) {
  return {
    minChunkMs: c.minChunkMs,
    targetChunkMs: c.targetChunkMs,
    maxChunkMs: c.maxChunkMs,
    pauseMs: c.pauseMs,
    silenceThreshold: c.silenceThreshold,
  };
}
