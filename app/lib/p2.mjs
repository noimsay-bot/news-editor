// P2 카드(CONTENTS 폴더) 읽기와 샷별 MLT XML 생성.
// 설계와 실측 근거: ../../분석_및_개발계획.md 6장, ../../인수인계서.md 6장
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const tag = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1];
const block = (xml, name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');

export const FPS = 30000 / 1001;

// 대소문자가 다른 복사본도 찾는다.
function findFile(dir, name) {
  const exact = path.join(dir, name);
  if (fs.existsSync(exact)) return exact;
  try {
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase());
    if (hit) return path.join(dir, hit);
  } catch {}
  return exact;
}

export class P2Card {
  constructor(contentsDir) {
    this.dir = path.resolve(contentsDir);
    this.shots = [];
  }

  load() {
    const clipDir = path.join(this.dir, 'CLIP');
    if (!fs.existsSync(clipDir)) throw new Error('CLIP 폴더가 없습니다. P2 카드의 CONTENTS 폴더를 선택하세요.');
    const clips = new Map();
    for (const f of fs.readdirSync(clipDir)) {
      if (!/\.xml$/i.test(f)) continue;
      const xml = fs.readFileSync(path.join(clipDir, f), 'utf8');
      const name = tag(xml, 'ClipName');
      const frames = Number(tag(xml, 'Duration'));
      if (!name || !(frames > 0)) continue;
      const conn = block(xml, 'Connection');
      clips.set(name, {
        name,
        frames,
        audioCount: (xml.match(/<Audio>/g) || []).length,
        codec: tag(xml, 'Codec') || '',
        startTc: tag(xml, 'StartTimecode') || '',
        shootStart: tag(block(xml, 'Shoot') || '', 'StartDate') || '',
        model: tag(xml, 'ModelName') || '',
        top: conn ? tag(block(conn, 'Top') || '', 'ClipName') : name,
        next: conn && block(conn, 'Next') ? tag(block(conn, 'Next'), 'ClipName') : null,
      });
    }
    // 연결 클립: 첫 조각(Top)에서 Next를 따라가며 묶는다.
    const shots = [];
    for (const c of clips.values()) {
      if (c.top !== c.name) continue;
      const parts = [c];
      let cur = c;
      while (cur.next && clips.has(cur.next)) {
        cur = clips.get(cur.next);
        parts.push(cur);
      }
      const frames = parts.reduce((s, p) => s + p.frames, 0);
      shots.push({
        name: c.name,
        label: parts.map((p) => p.name).join('+'),
        parts: parts.map((p) => ({ name: p.name, frames: p.frames })),
        frames,
        seconds: frames / FPS,
        channels: Math.min(...parts.map((p) => p.audioCount)),
        codec: c.codec,
        startTc: c.startTc,
        shootStart: c.shootStart,
        model: c.model,
        continuesOnOtherCard: !!cur.next,
      });
    }
    shots.sort((a, b) => a.shootStart.localeCompare(b.shootStart) || a.name.localeCompare(b.name));
    if (!shots.length) throw new Error('클립을 찾지 못했습니다.');
    this.shots = shots;
    // 카드 고유값: 같은 드라이브에 다른 카드를 꽂아도 분석·복구 결과가 섞이지 않게 한다.
    this.id = crypto.createHash('sha1').update([...clips.values()].map((c) => `${c.name}:${c.frames}:${c.shootStart}`).sort().join('|')).digest('hex').slice(0, 10);
    return this;
  }

  shot(name) {
    return this.shots.find((s) => s.name === name);
  }
  videoPath(clip) {
    return findFile(path.join(this.dir, 'VIDEO'), `${clip}.MXF`);
  }
  audioPath(clip, ch) {
    return findFile(path.join(this.dir, 'AUDIO'), `${clip}${String(ch).padStart(2, '0')}.MXF`);
  }
  proxyPath(clip) {
    return findFile(path.join(this.dir, 'PROXY'), `${clip}.MOV`);
  }
  iconPath(clip) {
    return findFile(path.join(this.dir, 'ICON'), `${clip}.BMP`);
  }

  // 영상 + 채널별 음성 + 연결 클립을 하나로 묶은 MLT XML.
  // ch1 → 왼쪽, ch2 → 오른쪽, ch3·4는 기본 음소거.
  // restored: { [채널번호]: 복구 WAV 경로 } — 있으면 그 채널은 원본 MXF 대신 복구 음성을 쓴다.
  shotXml(shot, restored = {}) {
    const out = [];
    out.push('<?xml version="1.0" encoding="utf-8"?>');
    out.push('<mlt LC_NUMERIC="C" version="7.0.0">');
    // AVC-I 1080/59.94i (AVC-I 50은 1440x1080 SAR 4:3 → 1920 표시)
    out.push(PROFILE_XML);
    const playlists = [];
    const addTrack = (id, ch) => {
      const entries = [];
      if (ch >= 0 && restored[ch]) {
        // 복구 음성: 샷 전체가 하나의 WAV (연결 클립도 이어 붙여 처리됨)
        const pid = `${id}_restored`;
        out.push(`  <producer id="${pid}" in="0" out="${shot.frames - 1}">`);
        out.push(`    <property name="length">${shot.frames}</property>`);
        out.push(`    <property name="resource">${esc(fwd(restored[ch]))}</property>`);
        out.push('    <property name="mlt_service">avformat</property>');
        out.push('    <property name="video_index">-1</property>');
        out.push('    <property name="news:voice">restored</property>');
        if (ch <= 1) pushPanVolume(out, ch);
        out.push('  </producer>');
        entries.push(`    <entry producer="${pid}" in="0" out="${shot.frames - 1}"/>`);
        out.push(`  <playlist id="${id}">`, ...entries, '  </playlist>');
        playlists.push(id);
        return;
      }
      shot.parts.forEach((p, i) => {
        const pid = `${id}_${i}`;
        const file = ch < 0 ? this.videoPath(p.name) : this.audioPath(p.name, ch);
        out.push(`  <producer id="${pid}" in="0" out="${p.frames - 1}">`);
        out.push(`    <property name="length">${p.frames}</property>`);
        out.push(`    <property name="resource">${esc(fwd(file))}</property>`);
        out.push('    <property name="mlt_service">avformat</property>');
        if (ch < 0) {
          out.push('    <property name="audio_index">-1</property>');
        } else {
          out.push('    <property name="video_index">-1</property>');
          if (ch <= 1) pushPanVolume(out, ch);
        }
        out.push('  </producer>');
        entries.push(`    <entry producer="${pid}" in="0" out="${p.frames - 1}"/>`);
      });
      out.push(`  <playlist id="${id}">`, ...entries, '  </playlist>');
      playlists.push(id);
    };
    addTrack('video', -1);
    for (let ch = 0; ch < shot.channels; ch++) addTrack(`ch${ch + 1}`, ch);
    out.push(`  <tractor id="tractor0" in="0" out="${shot.frames - 1}">`);
    out.push(`    <property name="news:p2clip">${shot.label}</property>`);
    out.push(`    <property name="news:startTimecode">${shot.startTc}</property>`);
    playlists.forEach((id, i) => {
      const hide = i === 0 || i >= 3 ? ' hide="audio"' : '';
      out.push(`    <track producer="${id}"${hide}/>`);
    });
    for (let i = 1; i < playlists.length; i++) {
      out.push('    <transition mlt_service="mix">');
      out.push('      <property name="a_track">0</property>');
      out.push(`      <property name="b_track">${i}</property>`);
      out.push('      <property name="sum">1</property>');
      out.push('      <property name="always_active">1</property>');
      out.push('    </transition>');
    }
    out.push('  </tractor>', '</mlt>', '');
    return out.join('\n');
  }

  writeShotMlt(shot, dir, restored = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const tag = Object.keys(restored).length ? '_vi' : '';
    const file = path.join(dir, `${shot.name}${tag}.mlt`);
    fs.writeFileSync(file, this.shotXml(shot, restored));
    return file;
  }
}

// ch1 → 왼쪽, ch2 → 오른쪽. tractor에 건 필터는 mix 이후 적용되므로 producer 안에 둔다.
// panner의 split은 애니메이션 속성이라 길이 없이 쓰면 무시 → start 사용.
// mix 트랜지션이 입력마다 -3dB → volume +3.0103dB로 원본 레벨 보정 (실측 오차 0.05dB 이내)
function pushPanVolume(out, ch) {
  out.push('    <filter mlt_service="panner">');
  out.push('      <property name="channel">-1</property>');
  out.push(`      <property name="start">${ch}</property>`);
  out.push('    </filter>');
  out.push('    <filter mlt_service="volume">');
  out.push('      <property name="level">3.0103</property>');
  out.push('    </filter>');
}

export const PROFILE_XML =
  '  <profile description="HD 1080i 29.97 fps" width="1920" height="1080" progressive="0" ' +
  'sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" ' +
  'frame_rate_num="30000" frame_rate_den="1001" colorspace="709"/>';

// 이동식 디스크 중 CONTENTS/CLIP이 있는 첫 드라이브
export function defaultContentsDir() {
  for (const d of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const dir = `${d}:/CONTENTS`;
    try {
      if (fs.existsSync(`${dir}/CLIP`)) return dir;
    } catch {}
  }
  return 'E:/CONTENTS';
}
