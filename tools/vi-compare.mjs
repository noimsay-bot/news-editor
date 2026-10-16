// 보이스 아이솔레이션 후보 비교: 말하는 구간의 음성 보존과 말하지 않는 구간의 잔여 잡음을 따로 잰다.
// 사용: node vi-compare.mjs <기준1.wav,기준2.wav> <원본.wav> <후보1.wav> [후보2.wav ...]
// 구간 판정(편향 방지): 모든 기준 신호에서 20ms 프레임 RMS가 -42dB 이상이면 음성, 모두 -65dB 이하면 비음성.
// 지연: 원본과 후보의 상호상관으로 ±100ms 안에서 시간 어긋남을 잰다(립싱크 확인).
import { execFileSync } from 'node:child_process';

const FFMPEG = 'C:/Program Files/Shotcut/ffmpeg.exe';
const FRAME = 960; // 20ms @ 48kHz

function pcm(file) {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], {
    maxBuffer: 1 << 30,
  });
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}
const frameDb = (x) => {
  const out = [];
  for (let i = 0; i + FRAME <= x.length; i += FRAME) {
    let s = 0;
    for (let j = i; j < i + FRAME; j++) s += (x[j] / 32768) ** 2;
    out.push(10 * Math.log10(s / FRAME + 1e-12));
  }
  return out;
};
const meanDb = (db, idx) => {
  const v = idx.filter((i) => i < db.length);
  if (!v.length) return NaN;
  return 10 * Math.log10(v.reduce((s, i) => s + 10 ** (db[i] / 10), 0) / v.length + 1e-12);
};
// 원본 대비 지연(ms): 앞 10초에서 ±100ms 탐색
function lagMs(a, b) {
  const n = Math.min(a.length, b.length, 48000 * 10);
  let best = 0, bestV = -Infinity;
  for (let lag = -4800; lag <= 4800; lag += 24) {
    let s = 0;
    for (let i = 5000; i < n - 5000; i += 4) s += a[i] * (b[i + lag] || 0);
    if (s > bestV) { bestV = s; best = lag; }
  }
  return (best / 48).toFixed(1);
}

const [refs, orig, ...cands] = process.argv.slice(2);
const refDbs = refs.split(',').map((f) => frameDb(pcm(f)));
const len = Math.min(...refDbs.map((r) => r.length));
const speech = [], noise = [];
for (let i = 0; i < len; i++) {
  if (refDbs.every((r) => r[i] >= -42)) speech.push(i);
  else if (refDbs.every((r) => r[i] <= -65)) noise.push(i);
}
const oPcm = pcm(orig);
const o = frameDb(oPcm);
const oS = meanDb(o, speech), oN = meanDb(o, noise);
console.log(`음성 프레임 ${speech.length}, 비음성 프레임 ${noise.length} (모든 기준이 동의한 구간만)`);
console.log(`원본            음성 ${oS.toFixed(1)}dB  잡음 ${oN.toFixed(1)}dB  SNR ${(oS - oN).toFixed(1)}dB`);
for (const c of cands) {
  const p = pcm(c);
  const d = frameDb(p);
  const s = meanDb(d, speech), n = meanDb(d, noise);
  console.log(
    `${c.split(/[\\/]/).pop().padEnd(16)}음성 보존 ${(s - oS).toFixed(1)}dB  잡음 감소 ${(oN - n).toFixed(1)}dB  SNR ${(s - n).toFixed(1)}dB  지연 ${lagMs(oPcm, p)}ms`,
  );
}
