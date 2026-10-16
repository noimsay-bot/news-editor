// 테스트 전용 합성 자료 (DEVELOPMENT_SPEC §7.1: 비민감·합성 fixture. 실제 취재 원본에 섞지 않는다)
// 결정적 난수로 매번 같은 파일을 만든다.
import fs from 'node:fs';
import path from 'node:path';
import { writeRawF32 } from './pcm.mjs';
import { EngineError, requireTool, run } from './tools.mjs';

export const SR = 48000;

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// 말소리 비슷한 신호: 기본음 + 배음, 음절 단위(약 4Hz) 진폭 변조, 사이사이 쉼
export function speechLike(seconds, { silenceHead = 1.5, seed = 7 } = {}) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const rnd = prng(seed);
  let f0 = 140, t = 0;
  const syllables = [];
  for (let s = silenceHead; s < seconds - 0.3; ) {
    const dur = 0.18 + rnd() * 0.22;
    if (rnd() < 0.8) syllables.push([s, s + dur, 110 + rnd() * 90]);
    s += dur + 0.05 + rnd() * 0.25;
  }
  for (const [a, b, f] of syllables) {
    const i0 = Math.round(a * SR), i1 = Math.round(b * SR);
    for (let i = i0; i < i1 && i < n; i++) {
      const tt = (i - i0) / (i1 - i0);
      const env = Math.sin(Math.PI * tt) ** 2;
      f0 = f;
      t = i / SR;
      let v = 0;
      for (let h = 1; h <= 12; h++) {
        const fh = f0 * h;
        // 성도 공명 근사(700Hz, 1200Hz, 2600Hz 부근 강조)
        const formant = Math.exp(-((fh - 700) ** 2) / 2e5) + 0.7 * Math.exp(-((fh - 1200) ** 2) / 3e5) + 0.4 * Math.exp(-((fh - 2600) ** 2) / 5e5);
        v += (0.15 + formant) * Math.sin(2 * Math.PI * fh * t) / h;
      }
      x[i] = 0.18 * env * v;
    }
  }
  return { x, syllables };
}

// 지속 잡음: 갈색(공조·차량 저역) + 흰색 + 60Hz 험
export function steadyNoise(seconds, { level = 0.03, hum = 0.02, seed = 11 } = {}) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const rnd = prng(seed);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    brown = 0.995 * brown + 0.05 * w;
    x[i] = level * (0.7 * brown + 0.3 * w) + hum * Math.sin((2 * Math.PI * 60 * i) / SR) + hum * 0.3 * Math.sin((2 * Math.PI * 180 * i) / SR);
  }
  return x;
}

async function encodeWav(file, channels, codec = 'pcm_s24le') {
  const raw = `${file}.f32`;
  writeRawF32(raw, channels);
  const r = await run(requireTool('ffmpeg'), ['-v', 'error', '-nostdin', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', String(channels.length), '-i', raw, '-c:a', codec, file]);
  fs.rmSync(raw, { force: true });
  if (r.code !== 0) throw new EngineError('FIXTURE_FAILED', r.stderr, 5);
  return file;
}

export async function makeFixtures(dir, seconds = 10) {
  fs.mkdirSync(dir, { recursive: true });
  const { x: clean, syllables } = speechLike(seconds);
  const noise = steadyNoise(seconds);
  const noisy = Float32Array.from(clean, (v, i) => v + noise[i]);
  const files = {
    clean: await encodeWav(path.join(dir, 'clean.wav'), [clean]),
    noise: await encodeWav(path.join(dir, 'noise.wav'), [noise]),
    noisy: await encodeWav(path.join(dir, 'noisy.wav'), [noisy]),
    silent: await encodeWav(path.join(dir, 'silent.wav'), [new Float32Array(seconds * SR)]),
    stereo: await encodeWav(path.join(dir, 'stereo.wav'), [noisy, Float32Array.from(noise)], 'pcm_s16le'),
  };
  // 짧은 영상(29.97fps, 프레임 번호 표시) + 잡음 섞인 음성 — 립싱크·스트림 복사 확인용
  files.video = path.join(dir, 'video.mov');
  const r = await run(requireTool('ffmpeg'), [
    '-v', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30000/1001:duration=${seconds}`,
    '-i', files.noisy,
    '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg2video', '-q:v', '4', '-c:a', 'pcm_s24le', '-shortest', files.video,
  ]);
  if (r.code !== 0) throw new EngineError('FIXTURE_FAILED', r.stderr, 5);
  // 지원하지 않는 입력(T-14): 미디어가 아닌 바이트
  files.garbage = path.join(dir, 'not_media.mxf');
  fs.writeFileSync(files.garbage, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)));
  return { files, syllables, seconds, noiseOnly: [0.2, 1.3] };
}
