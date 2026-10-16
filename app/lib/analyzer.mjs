// 샷 자동 분석: 프록시(640x360)와 채널1 모노 파일만 읽는다(원본을 읽지 않음).
// 기준값은 E:\CONTENTS 실측(2026-10-15)으로 정함.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { FPS } from './p2.mjs';
import { zoneParams } from './hdr.mjs';
import { FFMPEG } from './paths.mjs';

export const RULES = {
  speechMinSeconds: 2.0, // 채널1 음성 최소 길이
  speechMinRatio: 0.35, // 분석 구간 중 음성 비율
  speechMinRmsDb: -45.0, // 채널1 평균 레벨
  speechWindowSec: 30.0, // 앞 30초만
  wbMinDeviation: 0.08, // 무채색 픽셀 평균의 색 치우침 8% 이상
  shakeMinFrames: 120, // 4초 이상 스케치만
  shakeWindowFrames: 60, // 앞/뒤 2초 검사
  shakeMaxTrim: 45, // 최대 1.5초
  shakeEdgeFrames: 6, // 0.2초 안에 시작한 흔들림만 녹화 흔들림으로 봄
  shakeCalmRun: 8, // 연속 안정 프레임 수
  minRemainFrames: 90, // 자른 뒤 최소 3초
};
const GRID_W = 32;
const GRID_H = 18;

function run(args, { timeoutMs = 60000, binary = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostats', '-nostdin', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      resolve({ stdout: binary ? buf : buf.toString('latin1'), stderr: err });
    });
    p.on('error', () => resolve({ stdout: binary ? Buffer.alloc(0) : '', stderr: err }));
  });
}

export async function analyzeSpeech(ch1Path, seconds) {
  const window = Math.min(seconds, RULES.speechWindowSec);
  const { stderr } = await run([
    '-t', window.toFixed(2), '-i', ch1Path,
    '-af', 'highpass=f=200,lowpass=f=3500,astats=metadata=0:measure_perchannel=none:measure_overall=RMS_level+Noise_floor,silencedetect=n=-40dB:d=0.35',
    '-f', 'null', '-',
  ]);
  let silence = 0;
  for (const m of stderr.matchAll(/silence_duration: ([0-9.]+)/g)) silence += Number(m[1]);
  const rms = stderr.match(/RMS level dB: (-?[0-9.]+|-inf)/);
  const ch1RmsDb = rms && rms[1] !== '-inf' ? Number(rms[1]) : -100;
  const nf = stderr.match(/Noise floor dB: (-?[0-9.]+|-inf)/);
  const noiseFloorDb = nf && nf[1] !== '-inf' ? Number(nf[1]) : -100;
  const voicedSeconds = Math.max(0, window - silence);
  const voicedRatio = window > 0 ? voicedSeconds / window : 0;
  const isSync =
    voicedSeconds >= RULES.speechMinSeconds && voicedRatio >= RULES.speechMinRatio && ch1RmsDb >= RULES.speechMinRmsDb;
  return { voicedSeconds, voicedRatio, ch1RmsDb, noiseFloorDb, isSync };
}

const median = (v) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// 가장자리에서 시작한 흔들림이 끝나는 위치(프레임). 없으면 0.
function edgeShake(m, thr) {
  let first = -1;
  for (let i = 0; i < Math.min(RULES.shakeEdgeFrames, m.length); i++) {
    if (m[i] > thr) {
      first = i;
      break;
    }
  }
  if (first < 0) return 0;
  let last = first;
  let calm = 0;
  for (let i = first; i < m.length && i < RULES.shakeMaxTrim + RULES.shakeCalmRun; i++) {
    if (m[i] > thr) {
      last = i;
      calm = 0;
    } else if (++calm >= RULES.shakeCalmRun) break;
  }
  // tblend 차이 i는 프레임 i와 i+1 사이 → 흔들린 마지막 프레임 다음 + 여유 1프레임
  return Math.min(last + 2, RULES.shakeMaxTrim);
}

export function computeTrim(head, tail, frames) {
  if (frames < RULES.shakeMinFrames) return { trimHead: 0, trimTail: 0, threshold: 0 };
  const thr = Math.max(2.0, median([...head, ...tail]) * 3);
  let trimHead = edgeShake(head, thr);
  let trimTail = edgeShake([...tail].reverse(), thr);
  const maxTotal = Math.max(0, frames - RULES.minRemainFrames);
  if (trimHead + trimTail > maxTotal) {
    const k = trimHead + trimTail > 0 ? maxTotal / (trimHead + trimTail) : 0;
    trimHead = Math.floor(trimHead * k);
    trimTail = Math.floor(trimTail * k);
  }
  return { trimHead, trimTail, threshold: thr };
}

const motionFilter =
  'scale=160:90,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-';
const parseMotion = (s) => [...s.matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));

export async function motionWindow(proxyPath, fromEnd) {
  const secs = (RULES.shakeWindowFrames / FPS).toFixed(3);
  const pos = fromEnd ? ['-sseof', `-${secs}`] : ['-t', secs];
  const { stdout } = await run([...pos, '-i', proxyPath, '-an', '-vf', motionFilter, '-f', 'null', '-'], {
    timeoutMs: 30000,
  });
  return parseMotion(stdout);
}

export async function analyzeColor(proxyPath, seconds) {
  const span = Math.min(Math.max(seconds, 1), 60);
  const vf = `fps=${(8 / span).toFixed(4)},scale=${GRID_W}:${GRID_H}:flags=area,format=rgb24`;
  const { stdout: raw } = await run(['-t', span.toFixed(2), '-i', proxyPath, '-an', '-vf', vf, '-f', 'rawvideo', '-'], {
    binary: true,
    timeoutMs: 30000,
  });
  const frameBytes = GRID_W * GRID_H * 3;
  const frames = Math.floor(raw.length / frameBytes);
  const result = { wbNeeded: false, wbNeutral: '#7f7f7f', exposureNeeded: false };
  if (!frames) return result;

  const luma = new Float64Array(GRID_W * GRID_H);
  const cellRgb = new Float64Array(GRID_W * GRID_H * 3);
  let sr = 0, sg = 0, sb = 0, count = 0;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < GRID_W * GRID_H; i++) {
      const o = f * frameBytes + i * 3;
      const r = raw[o], g = raw[o + 1], b = raw[o + 2];
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luma[i] += y / frames;
      cellRgb[i * 3] += r / frames;
      cellRgb[i * 3 + 1] += g / frames;
      cellRgb[i * 3 + 2] += b / frames;
      // 무채색에 가까운 픽셀(벽·흰 셔츠 등)만 색 틀어짐 판단에 쓴다 → 나무색 같은 장면 고유색 제외
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (y > 60 && y < 230 && mx < 250 && mx - mn < mx * 0.25) {
        sr += r; sg += g; sb += b; count++;
      }
    }
  }

  // 화이트밸런스: 그레이월드. 치우침 4~35%일 때만, 70%만 보정(과보정 방지).
  result.neutralPixelRatio = count / (frames * GRID_W * GRID_H);
  if (result.neutralPixelRatio >= 0.05) {
    sr /= count; sg /= count; sb /= count;
    const mean = (sr + sg + sb) / 3;
    const dev = Math.max(Math.abs(sr - mean), Math.abs(sg - mean), Math.abs(sb - mean)) / mean;
    result.wbDeviation = dev;
    result.averageColor = [sr, sg, sb].map(Math.round);
    if (dev > RULES.wbMinDeviation && dev < 0.35) {
      const n = (c) => Math.max(0, Math.min(255, Math.round((127 * (mean + (c - mean) * 0.7)) / mean)));
      result.wbNeeded = true;
      result.wbNeutral = '#' + [n(sr), n(sg), n(sb)].map((v) => v.toString(16).padStart(2, '0')).join('');
    }
  }

  // 역광 인물: 화면 중앙 아래(인터뷰 피사체 자리)가 바깥보다 확연히 어두우면
  const cell = (x, y) => luma[y * GRID_W + x];
  let cs = 0, cn = 0, os = 0, on = 0;
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++) {
      if (x >= 10 && x < 22 && y >= 4) { cs += cell(x, y); cn++; }
      else { os += cell(x, y); on++; }
    }
  const lc = cs / cn, lo = os / on;
  // 얼굴 자리(중앙 위쪽): 몸(어두운 양복)이 아니라 얼굴이 그늘져야 역광으로 본다
  let hs = 0, hn = 0, hr = 0, hg = 0, hb = 0;
  for (let y = 3; y <= 8; y++)
    for (let x = 12; x <= 19; x++) {
      const i = y * GRID_W + x;
      hs += cell(x, y); hn++;
      hr += cellRgb[i * 3]; hg += cellRgb[i * 3 + 1]; hb += cellRgb[i * 3 + 2];
    }
  const lh = hs / hn;
  hr /= hn; hg /= hn; hb /= hn;
  // 피부색 계열(R > G > B)이어야 얼굴로 본다. 그늘진 피부도 색 비율은 유지된다.
  // 검은 머리·옷(무채색), 휴대폰 화면(파랑) 같은 오탐을 거른다.
  const skinLike = hr > hg * 1.03 && hg >= hb * 0.98 && hr - hb > 6;
  result.faceColor = [hr, hg, hb].map(Math.round);
  result.subjectLuma = lh;
  result.backgroundLuma = lo;
  if (skinLike && lo >= 130 && lh <= 90 && lo - lh >= 50 && lc <= 110) {
    const darkThr = lc + (lo - lc) * 0.4;
    let x0 = GRID_W, y0 = GRID_H, x1 = -1, y1 = -1, n = 0;
    for (let y = 2; y < GRID_H; y++)
      for (let x = 6; x < GRID_W - 6; x++)
        if (cell(x, y) < darkThr) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); n++;
        }
    const area = x1 >= 0 ? ((x1 - x0 + 1) * (y1 - y0 + 1)) / (GRID_W * GRID_H) : 1;
    if (n >= 12 && (x1 - x0 + 1) / GRID_W <= 0.6 && area <= 0.6) {
      x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1);
      x1 = Math.min(GRID_W - 1, x1 + 1); y1 = Math.min(GRID_H - 1, y1 + 1);
      result.subjectRect = {
        x: x0 / GRID_W, y: y0 / GRID_H, w: (x1 - x0 + 1) / GRID_W, h: (y1 - y0 + 1) / GRID_H,
      };
      // HDR식 구역 노출: 얼굴(Shadow 구역)만 스톱 단위로 올리고 배경(밝은 구역)은 유지 (lib/hdr.mjs)
      result.hdr = zoneParams(lh, lo);
      result.exposureNeeded = result.hdr.exposureStops >= 0.3;
    }
  }
  return result;
}

// 두 모노 파일 앞 20초의 파형 상관(같은 마이크 복제인지 판별)
async function correlation(fileA, fileB) {
  const read = async (f) => {
    const { stdout } = await run(['-t', '20', '-i', f, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { binary: true, timeoutMs: 30000 });
    return new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  };
  const [x, y] = await Promise.all([read(fileA), read(fileB)]);
  const n = Math.min(x.length, y.length);
  if (n < 8000) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i];
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2;
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

// lib: Library, shot: 공통 샷 구조 (lib/library.mjs)
// P2: ch1·ch3 = 무선/외부 마이크 음성 후보, ch2·ch4 = 프런트 마이크 현장음
// 일반 카메라: 내장 마이크 하나(mixed) = 현장음 겸 음성 후보
export async function analyzeShot(lib, shot) {
  const firstSec = shot.video[0].frames / FPS;
  const roles = shot.channels.map((c) => c.role);
  const perChannel = {};
  await Promise.all(
    roles.map(async (role, ch) => {
      if (role === 'ambient') return;
      const f = shot.channels[ch].inputs[0];
      if (f && fs.existsSync(f)) perChannel[ch] = await analyzeSpeech(f, firstSec);
    }),
  );
  let voiceChannels = Object.entries(perChannel).filter(([, v]) => v.isSync).map(([ch]) => Number(ch));
  let voiceDuplicate = false;
  if (voiceChannels.length === 2) {
    const [c1, c2] = voiceChannels;
    const r = await correlation(shot.channels[c1].inputs[0], shot.channels[c2].inputs[0]);
    if (Math.abs(r) > 0.7) {
      // 같은 마이크 복제 → 더 깨끗한(신호 대 잡음비가 높은) 채널 하나만
      voiceDuplicate = true;
      const snr = (ch) => perChannel[ch].ch1RmsDb - perChannel[ch].noiseFloorDb;
      voiceChannels = [snr(c1) >= snr(c2) ? c1 : c2];
    }
  }
  const ambientIdx = roles.map((r, i) => (r === 'ambient' ? i : -1)).filter((i) => i >= 0);
  let ambientDuplicate = true;
  if (ambientIdx.length > 1) {
    const r = await correlation(shot.channels[ambientIdx[0]].inputs[0], shot.channels[ambientIdx[1]].inputs[0]);
    ambientDuplicate = Math.abs(r) > 0.9;
  }
  // 대표값(목록 표시용): 음성 채널 중 가장 좋은 것, 없으면 첫 후보
  const repCh = voiceChannels[0] ?? Number(Object.keys(perChannel)[0] ?? -1);
  const rep = perChannel[repCh] || { voicedSeconds: 0, voicedRatio: 0, ch1RmsDb: -100, noiseFloorDb: -100 };

  let trim = { trimHead: 0, trimTail: 0 };
  const proxy = shot.proxy;
  if (shot.frames >= RULES.shakeMinFrames && proxy && fs.existsSync(proxy)) {
    // P2 연결 클립은 첫 조각/마지막 조각의 프록시, 일반 파일은 프록시(없으면 원본)
    const headProxy = shot.source === 'p2' ? shot.partProxies[0] : proxy;
    const tailProxy = shot.source === 'p2' ? shot.partProxies.at(-1) : proxy;
    const [head, tail] = await Promise.all([motionWindow(headProxy, false), motionWindow(tailProxy, true)]);
    trim = computeTrim(head, tail, shot.frames);
  }
  const color = proxy && fs.existsSync(proxy) ? await analyzeColor(proxy, firstSec) : {};
  return {
    done: true,
    isSync: voiceChannels.length > 0,
    voiceChannels,
    voiceDuplicate,
    ambientDuplicate,
    perChannel,
    voicedSeconds: rep.voicedSeconds,
    voicedRatio: rep.voicedRatio,
    ch1RmsDb: rep.ch1RmsDb,
    voiceChannelLabel: voiceChannels.map((c) => (shot.source === 'p2' ? `ch${c + 1}` : '내장 마이크')).join('+'),
    ...trim,
    ...color,
  };
}
