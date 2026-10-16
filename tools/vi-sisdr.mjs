// 합성 시험: 깨끗한 음성 + 실제 현장 소음을 정해진 SNR로 섞고, 처리 결과가 깨끗한 음성에 얼마나 가까운지(SI-SDR) 잰다.
// 섞기:  node vi-sisdr.mjs mix <clean.wav> <noise.wav> <snrDb> <out.wav>
// 평가:  node vi-sisdr.mjs eval <clean.wav> <mix.wav> <후보1.wav> [...]
//   (후보마다 ±100ms 지연을 맞춘 뒤 SI-SDR 계산, 지연은 따로 표시)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const FFMPEG = 'C:/Program Files/Shotcut/ffmpeg.exe';
const read = (f) => {
  const b = execFileSync(FFMPEG, ['-v', 'error', '-i', f, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};
const writeWav = (file, x) => {
  const pcm = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(96000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
};
const power = (x) => x.reduce((s, v) => s + v * v, 0) / x.length;

function bestLag(ref, y) {
  let best = 0, bv = -Infinity;
  const n = Math.min(ref.length, y.length);
  for (let lag = -4800; lag <= 4800; lag += 12) {
    let s = 0;
    for (let i = 6000; i < n - 6000; i += 3) s += ref[i] * (y[i + lag] || 0);
    if (s > bv) { bv = s; best = lag; }
  }
  return best;
}
function sisdr(ref, est) {
  const n = Math.min(ref.length, est.length);
  let dot = 0, rr = 0;
  for (let i = 0; i < n; i++) { dot += ref[i] * est[i]; rr += ref[i] * ref[i]; }
  const a = dot / rr;
  let t = 0, e = 0;
  for (let i = 0; i < n; i++) { const s = a * ref[i]; t += s * s; e += (est[i] - s) ** 2; }
  return 10 * Math.log10(t / e);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'mix') {
  const [cleanF, noiseF, snr, out] = args;
  const c = read(cleanF), nz = read(noiseF);
  const n = Math.min(c.length, nz.length);
  const g = Math.sqrt(power(c.subarray(0, n)) / (power(nz.subarray(0, n)) * 10 ** (Number(snr) / 10)));
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = c[i] + g * nz[i];
  writeWav(out, m);
  console.log(`mixed ${(n / 48000).toFixed(1)}s at ${snr}dB SNR`);
} else {
  const [cleanF, ...files] = args;
  const c = read(cleanF);
  for (const f of files) {
    const y = read(f);
    const lag = bestLag(c, y);
    const aligned = lag >= 0 ? y.subarray(lag) : Float32Array.from([...new Float32Array(-lag), ...y]);
    console.log(`${f.split(/[\\/]/).pop().padEnd(18)} SI-SDR ${sisdr(c, aligned).toFixed(2)}dB  지연 ${(lag / 48).toFixed(1)}ms`);
  }
}
