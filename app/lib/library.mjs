// 소스 라이브러리: P2 카드와 일반 카메라 파일(스마트폰·고프로·오스모·드론 등)을 같은 '샷' 구조로 다룬다.
//
// 샷 공통 구조
//   id, label, source('p2'|'file'), device, codec, width, height, fps, vfr
//   frames(프로젝트 29.97 기준), seconds, startTc, shootStart
//   video: [{ file, frames }]              — 이어 붙일 영상 조각(P2 연결 클립, 고프로 분할 파일)
//   channels: [{ role, inputs: [file] }]   — 채널별 모노 오디오 입력(조각 순서대로)
//      role: 'voice'(무선·외부 마이크 후보) | 'ambient'(현장음) | 'mixed'(일반 카메라 내장 마이크: 현장음 겸 음성 후보)
//   proxy: 분석·미리보기용 저해상도 파일(P2 PROXY, 고프로 LRV, DJI LRF), icon: 썸네일
//
// 채널 운용(사용자 확인, 2026-10-16): P2 ch1·ch3 = 무선/외부 마이크 음성(선택 사용), ch2·ch4 = ENG 프런트 마이크 현장음(항상)
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FPS, P2Card } from './p2.mjs';
import { FFPROBE } from './paths.mjs';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mxf', '.mts', '.m2ts', '.avi', '.mkv', '.m4v', '.3gp']);
const UNSUPPORTED_EXT = { '.insv': 'Insta360 360° 원본입니다. Insta360 Studio에서 MP4로 내보낸 파일을 넣으세요.', '.360': 'GoPro MAX 360° 원본입니다. GoPro Player에서 MP4로 내보낸 파일을 넣으세요.' };
const PROXY_EXT = new Set(['.lrv', '.lrf', '.thm']);

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// P2 CONTENTS 폴더 찾기: 선택한 폴더가 CONTENTS거나, 그 아래 CONTENTS가 있으면
export function findP2Contents(dir) {
  const d = path.resolve(dir);
  if (fs.existsSync(path.join(d, 'CLIP')) && fs.existsSync(path.join(d, 'VIDEO'))) return d;
  const c = path.join(d, 'CONTENTS');
  if (fs.existsSync(path.join(c, 'CLIP'))) return c;
  return null;
}

function probe(file) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
      maxBuffer: 1 << 24,
      windowsHide: true,
    });
    return JSON.parse(out.toString());
  } catch {
    return null;
  }
}
const ratio = (s) => {
  const [a, b] = String(s || '0/1').split('/').map(Number);
  return b ? a / b : 0;
};

function deviceName(file, info) {
  const tags = { ...(info?.format?.tags || {}) };
  for (const st of info?.streams || []) Object.assign(tags, st.tags || {});
  const t = (k) => Object.entries(tags).find(([key]) => key.toLowerCase() === k)?.[1];
  const base = path.basename(file).toUpperCase();
  const handler = String(t('handler_name') || '');
  const model = t('com.apple.quicktime.model') || t('model') || t('com.android.model');
  const make = t('com.apple.quicktime.make') || t('make') || t('com.android.manufacturer');
  if (/gopro/i.test(handler) || /^G[HXL]\d{6}\.MP4$|^GOPR\d{4}\.MP4$|^GP\d{6}\.MP4$/.test(base)) return 'GoPro';
  if (/^DJI_|dji/i.test(base) || /dji/i.test(handler) || /dji/i.test(String(t('encoder') || ''))) return 'DJI';
  if (/insta360/i.test(String(t('encoder') || '') + handler)) return 'Insta360';
  if (model || make) return [make, model].filter(Boolean).join(' ').trim();
  return '카메라';
}

// 고프로 분할 파일 묶기: GX01NNNN, GX02NNNN … (GH/GX/GL) 와 구형 GOPRNNNN + GPccNNNN
function chapterKey(file) {
  const b = path.basename(file).toUpperCase();
  let m = b.match(/^G([HX])(\d{2})(\d{4})\.MP4$/);
  if (m) return { key: `G${m[1]}${m[3]}`, order: Number(m[2]) };
  m = b.match(/^GOPR(\d{4})\.MP4$/);
  if (m) return { key: `GOPR${m[1]}`, order: 0 };
  m = b.match(/^GP(\d{2})(\d{4})\.MP4$/);
  if (m) return { key: `GOPR${m[2]}`, order: Number(m[1]) };
  return null;
}

// 저해상도 프록시: 고프로 GX01NNNN.MP4 ↔ GL01NNNN.LRV, DJI xxx.MP4 ↔ xxx.LRF
function findProxy(file) {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  const names = [`${stem}.LRV`, `${stem}.lrv`, `${stem}.LRF`, `${stem}.lrf`];
  const gp = stem.match(/^G([HX])(\d{6})$/i);
  if (gp) names.push(`GL${gp[2]}.LRV`, `GL${gp[2]}.lrv`);
  for (const n of names) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  return null;
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(\$RECYCLE\.BIN|System Volume Information|MISC)$/i.test(e.name)) continue;
      if (findP2Contents(p)) continue; // P2 구조는 별도로 처리
      walk(p, out, depth + 1);
    } else out.push(p);
  }
  return out;
}

export class Library {
  constructor() {
    this.sources = []; // { dir, type, label, count }
    this.shots = [];
    this.unsupported = []; // { file, reason }
    this.byId = new Map();
    this.p2 = new Map(); // shot id → { card, clipNames }
  }

  get id() {
    return sha(this.shots.map((s) => s.key).sort().join('|')).slice(0, 10);
  }
  get label() {
    return this.sources.map((s) => s.label).join(' + ');
  }

  shot(id) {
    return this.byId.get(id);
  }

  uniqueId(base) {
    let id = base.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'clip';
    let n = 2;
    const orig = id;
    while (this.byId.has(id)) id = `${orig}${n++}`;
    return id;
  }

  // 폴더를 추가한다. P2 카드면 P2로, 아니면 일반 카메라 파일로 읽는다.
  add(dir) {
    const resolved = path.resolve(dir);
    if (this.sources.some((s) => s.dir === resolved)) return;
    const contents = findP2Contents(resolved);
    const before = this.shots.length;
    if (contents) this.addP2(contents);
    // P2가 아닌 파일(같은 메모리카드 안의 다른 폴더)도 함께 찾는다. CONTENTS 자체를 고른 경우는 제외(P2 내부 파일 중복 방지)
    if (resolved !== contents) this.addFiles(resolved, !!contents);
    if (this.shots.length === before && !this.unsupported.length)
      throw new Error('영상 파일을 찾지 못했습니다. P2 카드의 CONTENTS 폴더나 카메라 폴더를 선택하세요.');
    this.shots.sort((a, b) => (a.shootStart || '').localeCompare(b.shootStart || '') || a.id.localeCompare(b.id));
  }

  addP2(contents) {
    const card = new P2Card(contents).load();
    for (const s of card.shots) {
      const id = this.uniqueId(s.name);
      const shot = {
        id,
        key: `p2:${card.id}:${s.name}`,
        label: s.label,
        source: 'p2',
        device: s.model || 'P2',
        codec: s.codec,
        width: 1920,
        height: 1080,
        fps: FPS,
        vfr: false,
        frames: s.frames,
        seconds: s.seconds,
        startTc: s.startTc,
        shootStart: s.shootStart,
        parts: s.parts,
        continuesOnOtherCard: s.continuesOnOtherCard,
        video: s.parts.map((p) => ({ file: card.videoPath(p.name), frames: p.frames, audioIndex: -1 })),
        channels: Array.from({ length: s.channels }, (_, ch) => ({
          // ch1·ch3 = 무선/외부 마이크(음성 후보), ch2·ch4 = 프런트 마이크(현장음)
          role: ch % 2 === 0 ? 'voice' : 'ambient',
          inputs: s.parts.map((p) => card.audioPath(p.name, ch)),
        })),
        proxy: card.proxyPath(s.name),
        partProxies: s.parts.map((p) => card.proxyPath(p.name)),
        icon: card.iconPath(s.name),
      };
      this.shots.push(shot);
      this.byId.set(id, shot);
    }
    this.sources.push({ dir: contents, type: 'p2', label: `P2 ${card.shots[0]?.model || ''} (${card.shots.length}샷)`.trim(), count: card.shots.length });
  }

  addFiles(dir, insideP2) {
    const files = walk(dir);
    const groups = new Map();
    let count = 0;
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (PROXY_EXT.has(ext)) continue;
      if (UNSUPPORTED_EXT[ext]) {
        this.unsupported.push({ file: f, reason: UNSUPPORTED_EXT[ext] });
        continue;
      }
      if (!VIDEO_EXT.has(ext)) continue;
      const ch = chapterKey(f);
      const key = ch ? path.join(path.dirname(f), ch.key) : f;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ file: f, order: ch ? ch.order : 0 });
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.order - b.order);
      const shot = this.makeFileShot(list.map((x) => x.file));
      if (shot) {
        this.shots.push(shot);
        this.byId.set(shot.id, shot);
        count++;
      }
    }
    if (count) this.sources.push({ dir, type: 'file', label: `${insideP2 ? '기타 ' : ''}카메라 파일 ${path.basename(dir) || dir} (${count}샷)`, count });
  }

  makeFileShot(files) {
    const infos = files.map((f) => ({ file: f, info: probe(f) }));
    const first = infos[0];
    const v = first.info?.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    if (!v) {
      this.unsupported.push({ file: first.file, reason: '영상 스트림을 읽지 못했습니다.' });
      return null;
    }
    const audio = first.info.streams.filter((s) => s.codec_type === 'audio');
    const durOf = (x) => Number(x.info?.format?.duration) || 0;
    const video = infos.map((x) => ({ file: x.file, frames: Math.max(1, Math.round(durOf(x) * FPS)), audioIndex: -1 }));
    const frames = video.reduce((s, p) => s + p.frames, 0);
    const rFps = ratio(v.r_frame_rate);
    const aFps = ratio(v.avg_frame_rate);
    const rotation = Number(v.tags?.rotate || v.side_data_list?.find((d) => d.rotation != null)?.rotation || 0);
    const vertical = Math.abs(rotation) % 180 === 90 ? v.width > v.height : v.height > v.width;
    const tags = first.info.format.tags || {};
    // 촬영 시각: 파일 태그 → 안 되면 파일 수정 시각
    let created = new Date(tags.creation_time || tags['com.apple.quicktime.creationdate'] || NaN);
    if (isNaN(created) || created.getFullYear() < 2000) created = fs.statSync(first.file).mtime;
    const stem = path.basename(first.file, path.extname(first.file));
    const id = this.uniqueId(stem);
    return {
      id,
      key: `file:${files.map((f) => `${path.resolve(f)}:${fs.statSync(f).size}`).join(',')}`,
      label: files.length > 1 ? `${path.basename(files[0])} 외 ${files.length - 1}` : path.basename(first.file),
      source: 'file',
      device: deviceName(first.file, first.info),
      codec: `${(v.codec_name || '').toUpperCase()} ${v.width}x${v.height} ${aFps ? aFps.toFixed(2) : '?'}fps`,
      width: v.width,
      height: v.height,
      fps: aFps || rFps,
      vfr: rFps > 0 && aFps > 0 && Math.abs(rFps - aFps) / rFps > 0.01,
      vertical,
      frames,
      seconds: frames / FPS,
      startTc: tags.timecode || v.tags?.timecode || [created.getHours(), created.getMinutes(), created.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'),
      shootStart: created.toISOString(),
      parts: video.map((p) => ({ name: path.basename(p.file), frames: p.frames })),
      video,
      hasAudio: audio.length > 0,
      audioDesc: audio.map((a) => `${a.codec_name} ${a.channels}ch`).join(', '),
      files,
      // 일반 카메라: 내장/연결 마이크 소리를 모노로 모아 한 채널로 다룬다(현장음 겸 음성 후보).
      // 실제 WAV는 분석 시 prepareFileAudio()가 만든다.
      channels: audio.length ? [{ role: 'mixed', inputs: [] }] : [],
      proxy: findProxy(first.file) || first.file,
      icon: null,
    };
  }

  summary(analysis = {}) {
    return {
      id: this.id,
      label: this.label,
      sources: this.sources,
      unsupported: this.unsupported,
      totalSeconds: this.shots.reduce((s, x) => s + x.seconds, 0),
      shots: this.shots.map((s) => ({
        id: s.id,
        name: s.id,
        label: s.label,
        source: s.source,
        device: s.device,
        codec: s.codec,
        vfr: s.vfr,
        vertical: !!s.vertical,
        frames: s.frames,
        seconds: s.seconds,
        startTc: s.startTc,
        shootStart: s.shootStart,
        parts: s.parts,
        channels: s.channels.map((c) => c.role),
        hasAudio: s.source === 'p2' ? true : s.hasAudio,
        audioDesc: s.audioDesc,
        analysis: analysis[s.id] || null,
      })),
    };
  }
}

// 일반 카메라 파일의 오디오를 48kHz 모노 WAV 하나로 모은다(분할 파일 이어 붙임). 캐시. (비동기: 서버를 멈추지 않음)
export function fileAudioPath(shot, dir) {
  return path.join(dir, 'audio', `${shot.id}_mix.wav`);
}
export function attachCachedFileAudio(shot, dir) {
  if (shot.source !== 'file' || !shot.hasAudio) return;
  const out = fileAudioPath(shot, dir);
  if (fs.existsSync(out)) shot.channels[0].inputs = [out];
}
export function prepareFileAudio(shot, dir, ffmpeg) {
  if (shot.source !== 'file' || !shot.hasAudio) return Promise.resolve(null);
  const out = fileAudioPath(shot, dir);
  if (fs.existsSync(out)) {
    shot.channels[0].inputs = [out];
    return Promise.resolve(out);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const inputs = shot.video.flatMap((p) => ['-i', p.file]);
  const n = shot.video.length;
  // 분할 파일 이어 붙이고(concat), 길이를 영상에 맞춰 무음으로 채운다(apad). 한 필터그래프 안에서 처리.
  const chain = n > 1 ? `${shot.video.map((_, i) => `[${i}:a:0]`).join('')}concat=n=${n}:v=0:a=1,apad[a]` : '[0:a:0]apad[a]';
  const filter = ['-filter_complex', chain, '-map', '[a]'];
  const tmp = out + '.part.wav';
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-y', ...inputs, ...filter, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-t', (shot.frames / FPS).toFixed(6), tmp], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('오디오 추출 실패: ' + err.slice(-500)));
      fs.renameSync(tmp, out);
      shot.channels[0].inputs = [out];
      resolve(out);
    });
  });
}
