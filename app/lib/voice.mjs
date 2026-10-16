// 보이스 아이솔레이션(음성 복구): DeepFilterNet3(오픈소스, MIT/Apache-2.0)로 음성 채널을 미리 복구 렌더링한다.
// 비교 근거(tools/vi-sisdr.mjs, 2026-10-16): 깨끗한 음성+현장 소음 합성 SI-SDR
//   0dB: 원본 0.0 → RNNoise -0.9 / DFN +6.9,  5dB: 5.0 → 1.9 / 10.0,  10dB: 10.0 → 3.8 / 12.6
//   RNNoise는 20ms 지연(립싱크 어긋남), DFN(-D)은 0ms.
// 채널 운용: P2 ch1·ch3(무선/외부 마이크) 중 실제 음성이 있는 채널만 복구한다.
//   두 채널이 서로 다른 마이크(기자+인터뷰이)면 각각 복구해 합치고(CH1 음성), 같은 마이크 복제면 하나만.
//   일반 카메라는 내장 마이크 소리를 복구한다.
// 조각(연결 클립, 고프로 분할)은 이어 붙인 뒤 한 번에 처리해 이음새에서 끊기지 않게 한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FPS } from './p2.mjs';
import { FFMPEG } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEEP_FILTER = path.join(HERE, '..', 'bin', 'deep-filter.exe');
export const available = () => fs.existsSync(DEEP_FILTER);

// 강도(0~100) → DeepFilterNet 감쇠 한계(dB). 100 = 한계 없음(최대 복구).
export const attenDb = (strength) => (strength >= 100 ? 100 : Math.max(6, Math.round(strength * 0.4)));

function run(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => (log = (log + d).slice(-4000)));
    p.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, log });
    });
    p.on('error', (e) => resolve({ code: -1, log: String(e) }));
  });
}

const tag = (shot, chs) => `${shot.id}_${chs.map((c) => `ch${c + 1}`).join('')}`;
export const channelPath = (dir, shot, ch, strength) => path.join(dir, 'voice', `${tag(shot, [ch])}_a${attenDb(strength)}.wav`);
export const busPath = (dir, shot, chs, strength) => path.join(dir, 'voice', `${tag(shot, chs)}_bus_a${attenDb(strength)}.wav`);

// 한 채널 복구(캐시). shot.channels[ch].inputs 를 이어 붙여 처리한다.
export async function restoreChannel(shot, ch, strength, dir) {
  const out = channelPath(dir, shot, ch, strength);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  const inputsList = shot.channels[ch]?.inputs || [];
  if (!inputsList.length) throw new Error(`ch${ch + 1} 입력 없음`);
  const work = path.join(dir, 'voice', 'tmp', `${tag(shot, [ch])}_${process.pid}_${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    // 1) 조각을 이어 붙여 48kHz 모노 WAV로 (영문 경로만 사용)
    const src = path.join(work, 'src.wav');
    const inputs = inputsList.flatMap((f) => ['-i', f]);
    const concat = inputsList.length > 1
      ? ['-filter_complex', `${inputsList.map((_, i) => `[${i}:a]`).join('')}concat=n=${inputsList.length}:v=0:a=1[a]`, '-map', '[a]']
      : [];
    let r = await run(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...inputs, ...concat, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', src], 600000);
    if (r.code !== 0) throw new Error('음성 추출 실패: ' + r.log);
    // 2) DeepFilterNet3 (지연 보정 -D: 립싱크 유지)
    const outDir = path.join(work, 'out');
    r = await run(DEEP_FILTER, ['-D', '-a', String(attenDb(strength)), '-o', outDir, src], 3600000);
    const enhanced = path.join(outDir, 'src.wav');
    if (r.code !== 0 || !fs.existsSync(enhanced)) throw new Error('DeepFilterNet 실패: ' + r.log);
    // 3) 길이를 샷 프레임 수에 정확히 맞춤(지연 보정으로 끝 30ms가 짧아짐 → 무음으로 채움)
    await fitLength(enhanced, out, shot.frames);
    return out;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function fitLength(input, out, frames) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.part.wav';
  const r = await run(FFMPEG, ['-v', 'error', '-nostdin', '-y', '-i', input, '-af', 'apad', '-t', (frames / FPS).toFixed(6), '-c:a', 'pcm_s16le', tmp], 600000);
  if (r.code !== 0) throw new Error('길이 맞춤 실패: ' + r.log);
  fs.renameSync(tmp, out);
}

// 음성 버스: 음성 채널들을 각각 복구한 뒤 합친다(서로 다른 마이크 = 서로 다른 화자이므로 더함).
// restoreOne: (ch) => Promise<복구 파일> (서버의 작업 대기열을 통해 호출)
export async function restoreVoiceBus(shot, chs, strength, dir, restoreOne) {
  const files = await Promise.all(chs.map((ch) => restoreOne(ch)));
  if (files.some((f) => !f)) return null;
  if (files.length === 1) return files[0];
  const out = busPath(dir, shot, chs, strength);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  const tmp = out + '.part.wav';
  const r = await run(
    FFMPEG,
    ['-v', 'error', '-nostdin', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `amix=inputs=${files.length}:normalize=0:duration=longest,alimiter=limit=0.97:level=false`, '-ac', '1', '-c:a', 'pcm_s16le', tmp],
    600000,
  );
  if (r.code !== 0) return null;
  fs.renameSync(tmp, out);
  return out;
}
