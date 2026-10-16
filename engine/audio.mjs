// M1 오디오 복구 (DEVELOPMENT_SPEC F-02) — 비생성형 신호 처리만 사용
//
// 처리 순서: 하이패스 → 노치(50/60Hz+고조파) → 파라메트릭 EQ → STFT 스펙트럼 감쇠 → 구간별 바이패스 → 원음 혼합(wet/dry)
//
// 생성 금지 보장:
//  - 스펙트럼 단계의 이득 g(t,f)는 항상 [gmin, 1]로 고정한다. 어떤 주파수 성분도 증폭하지 않고 감쇠만 한다.
//    → 입력에 없는 성분(새 발화·새 음향)이 출력에 생길 수 없다. 무음 입력 → 무음 출력.
//  - 위상은 입력 그대로 쓴다(크기만 줄인다).
//  - 바이쿼드(EQ)는 사용자가 지정한 경우에만 쓰며, 부스트는 사용자 설정값으로만 발생한다(자동 부스트 없음).
//
// 강도(strength 0~100) 매핑 (문서화된 내부 파라미터):
//   최대 감쇠 att_db = 0.30 × strength   (100 → 30 dB, 0 → 처리 없음)
//   과감산 계수 alpha = 1 + strength/100  (1.0 ~ 2.0)
//   음성 대역(300~3400Hz) 보호: 음성이 있는 프레임에서는 감쇠를 min(att_db, 12dB) × (1 - protect)로 제한
//   이득 g = clamp(1 - alpha·N/P, 10^(-att_db/20), 1)   (N: 잡음 파워 추정, P: 신호 파워)
import { EngineError } from './tools.mjs';

export const AUDIO_ALGORITHM = 'nrs-spectral-attenuation-1';
const N_FFT = 2048;
const HOP = 512; // 75% 겹침, sqrt-Hann 분석/합성 창 → 이득 1이면 완전 재구성

export function isAudioActive(filter) {
  if (!filter?.enabled) return false;
  const p = filter.params || {};
  const wet = p.wet ?? 100;
  if (wet <= 0) return false; // 원음 100% = 원본과 동일
  return (p.strength || 0) > 0 || (p.highpass_hz || 0) > 0 || (p.notch_hz || 0) > 0 || (p.eq || []).some((b) => b.gain_db);
}

export function validateAudioParams(p) {
  const bad = (m) => {
    throw new EngineError('BAD_PARAM', m, 2);
  };
  const num = (v, lo, hi, name) => {
    if (v == null) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) bad(`${name}는 ${lo}~${hi} 사이 숫자여야 합니다.`);
  };
  num(p.strength, 0, 100, 'strength');
  num(p.wet, 0, 100, 'wet');
  num(p.highpass_hz, 0, 1000, 'highpass_hz');
  num(p.notch_hz, 0, 400, 'notch_hz');
  num(p.notch_harmonics, 0, 8, 'notch_harmonics');
  num(p.attack_ms, 1, 2000, 'attack_ms');
  num(p.release_ms, 1, 5000, 'release_ms');
  num(p.speech_protect, 0, 100, 'speech_protect');
  if (p.notch_hz && ![50, 60].includes(p.notch_hz)) bad('notch_hz는 0(끔), 50, 60 중 하나여야 합니다.');
  for (const b of p.eq || []) {
    num(b.freq_hz, 20, 20000, 'eq.freq_hz');
    num(b.gain_db, -24, 12, 'eq.gain_db');
    num(b.q, 0.1, 20, 'eq.q');
  }
  if (p.noise_profile) {
    const { start_sec, end_sec } = p.noise_profile;
    if (!(end_sec > start_sec && start_sec >= 0)) bad('noise_profile 구간이 올바르지 않습니다.');
    if (end_sec - start_sec < 0.25) bad('잡음 샘플 구간은 0.25초 이상이어야 합니다.');
  }
  for (const r of p.bypass_ranges || []) if (!(r.end_sec > r.start_sec)) bad('bypass_ranges 구간이 올바르지 않습니다.');
}

// ---------------------------------------------------------------- 바이쿼드 (RBJ Audio EQ Cookbook)
function biquad(type, f0, sr, q = 0.707, gainDb = 0) {
  const w = (2 * Math.PI * f0) / sr, c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; }
  else if (type === 'notch') { b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; }
  else { b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function applyBiquad(x, k) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = k.b0 * x[i] + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
export function preFilters(p, sr) {
  const list = [];
  if (p.highpass_hz > 0) {
    // 2차 2단(24dB/oct) 버터워스 근사
    list.push({ name: `highpass ${p.highpass_hz}Hz`, k: biquad('highpass', p.highpass_hz, sr, 0.5412) });
    list.push({ name: null, k: biquad('highpass', p.highpass_hz, sr, 1.3066) });
  }
  if (p.notch_hz > 0) {
    for (let h = 1; h <= 1 + (p.notch_harmonics || 0); h++) {
      const f = p.notch_hz * h;
      if (f < sr / 2 - 100) list.push({ name: `notch ${f}Hz`, k: biquad('notch', f, sr, 30) });
    }
  }
  for (const b of p.eq || []) if (b.gain_db) list.push({ name: `eq ${b.freq_hz}Hz ${b.gain_db}dB`, k: biquad('peak', b.freq_hz, sr, b.q || 1, b.gain_db) });
  return list;
}

// ---------------------------------------------------------------- FFT (반복형 radix-2)
function makeFft(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return (re, im, inverse) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = inverse ? sin[k] : -sin[k];
          const ar = re[i + j + half], ai = im[i + j + half];
          const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
          re[i + j + half] = re[i + j] - tr; im[i + j + half] = im[i + j] - ti;
          re[i + j] += tr; im[i + j] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };
}

// ---------------------------------------------------------------- STFT 스펙트럼 감쇠 (채널 하나)
// opts: { strength, attackMs, releaseMs, speechProtect(0~1), noiseRange:[s0,s1] 샘플 | null }
export function spectralAttenuate(x, sr, opts) {
  const strength = opts.strength || 0;
  if (strength <= 0) return { y: Float32Array.from(x), stats: { mode: 'off' } };
  const fft = makeFft(N_FFT);
  const bins = N_FFT / 2 + 1;
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT)); // sqrt-Hann
  // sqrt-Hann² 합 = N/(2·HOP) → 합성 정규화
  const norm = (2 * HOP) / N_FFT;
  const pad = N_FFT;
  const len = x.length;
  const total = len + 2 * pad;
  const frames = Math.ceil((total - N_FFT) / HOP) + 1;
  const xp = new Float64Array(frames * HOP + N_FFT);
  for (let i = 0; i < len; i++) xp[i + pad] = x[i];

  // 1) 모든 프레임 파워 스펙트럼
  const power = new Array(frames);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const spec = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < N_FFT; i++) { re[i] = xp[o + i] * win[i]; im[i] = 0; }
    fft(re, im, false);
    const p = new Float32Array(bins), sr2 = new Float32Array(bins * 2);
    for (let b = 0; b < bins; b++) { p[b] = re[b] * re[b] + im[b] * im[b]; sr2[2 * b] = re[b]; sr2[2 * b + 1] = im[b]; }
    power[f] = p;
    spec[f] = sr2;
  }

  // 2) 잡음 파워 추정
  const noise = new Array(frames);
  let mode;
  if (opts.noiseRange) {
    // 정적: 지정한 잡음 구간 프레임의 평균 파워
    mode = 'stationary-profile';
    const f0 = Math.max(0, Math.floor((opts.noiseRange[0] + pad) / HOP)), f1 = Math.min(frames - 1, Math.floor((opts.noiseRange[1] + pad - N_FFT) / HOP));
    if (f1 <= f0) throw new EngineError('BAD_PARAM', '잡음 샘플 구간이 클립 범위를 벗어났거나 너무 짧습니다.', 2);
    const prof = new Float32Array(bins);
    for (let f = f0; f <= f1; f++) for (let b = 0; b < bins; b++) prof[b] += power[f][b] / (f1 - f0 + 1);
    for (let f = 0; f < frames; f++) noise[f] = prof;
  } else {
    // 비정적: 약 1.5초 창의 최소값 추적(minimum statistics) × 보정 계수
    mode = 'nonstationary-min-tracking';
    const span = Math.max(8, Math.round((1.5 * sr) / HOP));
    const smooth = new Array(frames);
    const a = 0.7;
    let prev = new Float32Array(bins);
    for (let f = 0; f < frames; f++) {
      const s = new Float32Array(bins);
      for (let b = 0; b < bins; b++) s[b] = f === 0 ? power[f][b] : a * prev[b] + (1 - a) * power[f][b];
      smooth[f] = s;
      prev = s;
    }
    const BIAS = 1.5; // 최소값은 평균보다 작으므로 보정
    for (let f = 0; f < frames; f++) {
      const lo = Math.max(0, f - span), hi = Math.min(frames - 1, f + span);
      const n = new Float32Array(bins);
      for (let b = 0; b < bins; b++) {
        let m = Infinity;
        for (let g = lo; g <= hi; g += 2) if (smooth[g][b] < m) m = smooth[g][b];
        n[b] = m * BIAS;
      }
      noise[f] = n;
    }
  }

  // 3) 이득 계산 (항상 gmin ≤ g ≤ 1)
  const attDb = 0.3 * strength;
  const alpha = 1 + strength / 100;
  const gmin = Math.pow(10, -attDb / 20);
  const protect = opts.speechProtect ?? 0.5;
  const speechFloor = Math.pow(10, -(Math.min(attDb, 12) * (1 - protect)) / 20);
  const bHz = sr / N_FFT;
  const s0 = Math.floor(300 / bHz), s1 = Math.ceil(3400 / bHz);
  const fps = sr / HOP;
  const relCoef = Math.exp(-1 / ((opts.releaseMs || 300) / 1000 * fps)); // 감쇠 쪽으로 천천히
  const attCoef = Math.exp(-1 / ((opts.attackMs || 50) / 1000 * fps)); // 회복 쪽으로 빠르게
  let gPrev = new Float32Array(bins).fill(1);
  let maxGain = 0;
  const out = new Float64Array(xp.length);
  for (let f = 0; f < frames; f++) {
    const p = power[f], n = noise[f];
    // 음성 존재 판단: 음성 대역 SNR > 6dB
    let ps = 0, ns = 0;
    for (let b = s0; b <= s1; b++) { ps += p[b]; ns += n[b]; }
    const speech = ns > 0 && ps / ns > 4;
    const g = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      let v = p[b] > 0 ? 1 - (alpha * n[b]) / p[b] : 0;
      let floor = gmin;
      if (speech && b >= s0 && b <= s1) floor = Math.max(gmin, speechFloor);
      v = Math.min(1, Math.max(floor, v));
      // 시간 스무딩: 이득이 내려갈 때는 release, 올라갈 때는 attack
      const c = v < gPrev[b] ? relCoef : attCoef;
      g[b] = c * gPrev[b] + (1 - c) * v;
    }
    // 주파수 스무딩(3-bin) — 뮤지컬 노이즈 완화. 평균이므로 1을 넘지 않는다.
    const gs = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const l = g[Math.max(0, b - 1)], r = g[Math.min(bins - 1, b + 1)];
      gs[b] = Math.min(1, (l + 2 * g[b] + r) / 4);
      if (gs[b] > maxGain) maxGain = gs[b];
    }
    gPrev = g;
    // 크기만 줄이고 위상 유지
    const s = spec[f];
    for (let b = 0; b < bins; b++) { re[b] = s[2 * b] * gs[b]; im[b] = s[2 * b + 1] * gs[b]; }
    for (let b = 1; b < bins - 1; b++) { re[N_FFT - b] = re[b]; im[N_FFT - b] = -im[b]; }
    fft(re, im, true);
    const o = f * HOP;
    for (let i = 0; i < N_FFT; i++) out[o + i] += re[i] * win[i] * norm;
  }
  if (maxGain > 1 + 1e-6) throw new EngineError('SAFETY_VIOLATION', '스펙트럼 이득이 1을 넘었습니다(증폭 금지 위반).', 5);
  const y = new Float32Array(len);
  for (let i = 0; i < len; i++) y[i] = out[i + pad];
  return { y, stats: { mode, att_db: attDb, alpha, gmin, max_gain: maxGain, n_fft: N_FFT, hop: HOP } };
}

// ---------------------------------------------------------------- 전체 처리
// channels: Float32Array[] (채널별), sr: 샘플레이트, clipStartSec: 클립이 원본에서 시작하는 시각
export function processAudio(channels, sr, params, { clipStartSec = 0 } = {}) {
  validateAudioParams(params);
  const p = { strength: 0, wet: 100, attack_ms: 50, release_ms: 300, speech_protect: 50, ...params };
  const filters = preFilters(p, sr);
  const toSample = (sec) => Math.round((sec - clipStartSec) * sr);
  const noiseRange = p.noise_profile ? [toSample(p.noise_profile.start_sec), toSample(p.noise_profile.end_sec)] : null;
  if (noiseRange && (noiseRange[0] < 0 || noiseRange[1] > channels[0].length)) throw new EngineError('BAD_PARAM', '잡음 샘플 구간이 클립 범위를 벗어났습니다.', 2);
  const wet = p.wet / 100;
  const xfade = Math.round(0.01 * sr); // 바이패스 경계 10ms 크로스페이드
  const bypass = (p.bypass_ranges || []).map((r) => [toSample(r.start_sec), toSample(r.end_sec)]);
  const outputs = [];
  let stats;
  let clipIn = 0, clipOut = 0;
  for (const x of channels) {
    let y = x;
    for (const f of filters) y = applyBiquad(y, f.k);
    const r = spectralAttenuate(y, sr, { strength: p.strength, attackMs: p.attack_ms, releaseMs: p.release_ms, speechProtect: p.speech_protect / 100, noiseRange });
    stats = r.stats;
    y = r.y;
    const o = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      // 구간별 바이패스(원음), 경계는 선형 크로스페이드
      let w = wet;
      for (const [a, b] of bypass) {
        if (i >= a - xfade && i < b + xfade) {
          const d = i < a ? (a - i) / xfade : i >= b ? (i - b + 1) / xfade : 0;
          w = Math.min(w, wet * Math.min(1, d));
        }
      }
      o[i] = w * y[i] + (1 - w) * x[i];
      if (Math.abs(x[i]) >= 1) clipIn++;
      if (Math.abs(o[i]) >= 1) clipOut++;
    }
    outputs.push(o);
  }
  const pipeline = [
    ...filters.filter((f) => f.name).map((f) => f.name),
    p.strength > 0 ? `${AUDIO_ALGORITHM} strength=${p.strength} (${stats.mode}, max ${stats.att_db.toFixed(1)}dB)` : null,
    p.bypass_ranges?.length ? `bypass ranges ×${p.bypass_ranges.length}` : null,
    `wet=${p.wet}%`,
  ].filter(Boolean);
  const warnings = [];
  if (clipOut > 0) warnings.push({ code: 'OUTPUT_CLIPPING', message: `출력에 클리핑 샘플 ${clipOut}개(0dBFS 이상)가 있습니다. EQ 부스트를 줄이세요.` });
  if ((p.notch_hz || 0) > 0 && (p.notch_harmonics || 0) >= 1) warnings.push({ code: 'NOTCH_SPEECH_OVERLAP', message: `노치 고조파(${p.notch_hz * 2}Hz 이상)는 남성 목소리 기본음(약 85~180Hz)과 겹쳐 음성 성분도 깎을 수 있습니다. 험이 실제로 있을 때만 쓰세요.` });
  if (clipIn > 0) warnings.push({ code: 'SOURCE_CLIPPING', message: `원본에 이미 클리핑된 샘플 ${clipIn}개가 있습니다. 잘린 파형은 복구할 수 없습니다.` });
  return { channels: outputs, pipeline, warnings, stats: { ...stats, clip_in: clipIn, clip_out: clipOut } };
}

// 제거된 성분(원본 − 결과): 무엇을 덜어냈는지 따로 듣기
export const removedComponent = (dry, out) => dry.map((x, c) => Float32Array.from(x, (v, i) => v - out[c][i]));

// 파형 요약(화면용): bucket 개수만큼 [min,max]
export function waveformPeaks(x, buckets = 1000) {
  const n = Math.max(1, Math.floor(x.length / buckets));
  const peaks = [];
  for (let i = 0; i < x.length; i += n) {
    let lo = 0, hi = 0;
    for (let j = i; j < Math.min(x.length, i + n); j++) { if (x[j] < lo) lo = x[j]; if (x[j] > hi) hi = x[j]; }
    peaks.push([Number(lo.toFixed(4)), Number(hi.toFixed(4))]);
  }
  return peaks;
}

// 지연 측정(샘플): 원본 대비 결과의 상호상관 최대 위치(±maxLag)
export function measureLagSamples(a, b, maxLag = 2400) {
  const n = Math.min(a.length, b.length);
  let best = 0, bv = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = maxLag; i < n - maxLag; i += 7) s += a[i] * b[i + lag];
    if (s > bv) { bv = s; best = lag; }
  }
  return best;
}
