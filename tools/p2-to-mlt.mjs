// P2 카드 CONTENTS 폴더를 읽어 클립(연결 클립은 하나로 합침)마다 MLT XML을 만든다.
// 사용: node p2-to-mlt.mjs <CONTENTS 경로> <출력 폴더> [클립이름...]
// 영상 MXF + 채널별 음성 MXF를 하나의 클립처럼 열 수 있게 tractor로 묶는다.
// 채널1 → 왼쪽, 채널2 → 오른쪽 (채널3·4는 트랙으로 넣되 기본 음소거).
import fs from 'node:fs';
import path from 'node:path';

const [, , contentsDir, outDir, ...only] = process.argv;
if (!contentsDir || !outDir) {
  console.error('사용: node p2-to-mlt.mjs <CONTENTS 경로> <출력 폴더> [클립이름...]');
  process.exit(1);
}

const tag = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1];
const block = (xml, name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

function readClip(name) {
  const xml = fs.readFileSync(path.join(contentsDir, 'CLIP', `${name}.XML`), 'utf8');
  const conn = block(xml, 'Connection');
  return {
    name,
    frames: Number(tag(xml, 'Duration')),
    codec: tag(xml, 'Codec'),
    startTc: tag(xml, 'StartTimecode'),
    audioCount: (xml.match(/<Audio>/g) || []).length,
    shootStart: tag(block(xml, 'Shoot') || '', 'StartDate'),
    model: tag(xml, 'ModelName'),
    top: conn ? tag(block(conn, 'Top'), 'ClipName') : name,
    next: conn && block(conn, 'Next') ? tag(block(conn, 'Next'), 'ClipName') : null,
  };
}

const names = fs.readdirSync(path.join(contentsDir, 'CLIP'))
  .filter((f) => /\.XML$/i.test(f))
  .map((f) => f.replace(/\.XML$/i, ''));
const clips = new Map(names.map((n) => [n, readClip(n)]));

// 연결 클립의 첫 조각(Top)만 시작점으로 삼고 Next를 따라가며 묶는다.
const shots = [];
for (const c of clips.values()) {
  if (c.top !== c.name) continue;
  const parts = [c];
  let cur = c;
  while (cur.next && clips.has(cur.next)) {
    cur = clips.get(cur.next);
    parts.push(cur);
  }
  if (cur.next) console.warn(`경고: ${c.name} 다음 조각 ${cur.next}이 카드에 없음 (다른 카드에 이어짐)`);
  shots.push(parts);
}
shots.sort((a, b) => (a[0].shootStart || '').localeCompare(b[0].shootStart || ''));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');

function buildXml(parts) {
  const total = parts.reduce((s, p) => s + p.frames, 0);
  const channels = Math.min(...parts.map((p) => p.audioCount));
  const out = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  out.push('<mlt LC_NUMERIC="C" version="7.0.0">');
  // AVC-I 1080/59.94i: 29.97 프레임, 인터레이스(TFF), 16:9
  out.push('  <profile description="HD 1080i 29.97 fps" width="1920" height="1080" progressive="0" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30000" frame_rate_den="1001" colorspace="709"/>');

  const playlists = [];
  const addTrack = (id, kind, suffix) => {
    const entries = [];
    parts.forEach((p, i) => {
      const pid = `${id}_${i}`;
      const file = kind === 'video'
        ? path.join(contentsDir, 'VIDEO', `${p.name}.MXF`)
        : path.join(contentsDir, 'AUDIO', `${p.name}${suffix}.MXF`);
      out.push(`  <producer id="${pid}" in="0" out="${p.frames - 1}">`);
      out.push(`    <property name="length">${p.frames}</property>`);
      out.push(`    <property name="resource">${esc(fwd(file))}</property>`);
      out.push('    <property name="mlt_service">avformat</property>');
      if (kind === 'video') out.push('    <property name="audio_index">-1</property>');
      else out.push('    <property name="video_index">-1</property>');
      // 채널1 → 왼쪽, 채널2 → 오른쪽. 모노 원본이 스테레오로 복제되므로 밸런스로 한쪽만 남긴다.
      // tractor 필터로 걸면 mix 이후 합쳐진 소리에 적용되므로 반드시 producer 안에 둔다.
      // split은 애니메이션 속성이라 길이 없이 쓰면 무시됨 → start 사용.
      if (suffix === '00' || suffix === '01') {
        out.push('    <filter mlt_service="panner">');
        out.push('      <property name="channel">-1</property>');
        out.push(`      <property name="start">${suffix === '00' ? 0 : 1}</property>`);
        out.push('    </filter>');
        // mix 트랜지션이 입력마다 -3dB를 걸어서 원본 레벨로 되돌린다 (실측 기준).
        out.push('    <filter mlt_service="volume">');
        out.push('      <property name="level">3.0103</property>');
        out.push('    </filter>');
      }
      out.push('  </producer>');
      entries.push(`    <entry producer="${pid}" in="0" out="${p.frames - 1}"/>`);
    });
    out.push(`  <playlist id="${id}">`, ...entries, '  </playlist>');
    playlists.push(id);
  };

  addTrack('video', 'video');
  for (let ch = 0; ch < channels; ch++) addTrack(`ch${ch + 1}`, 'audio', String(ch).padStart(2, '0'));

  out.push(`  <tractor id="tractor0" in="0" out="${total - 1}">`);
  out.push(`    <property name="shotcut:p2clip">${parts.map((p) => p.name).join('+')}</property>`);
  out.push(`    <property name="shotcut:p2startTc">${parts[0].startTc}</property>`);
  playlists.forEach((id, i) => {
    // 채널3·4는 기본 음소거(hide=audio). 필요하면 편집기에서 켠다.
    const hide = i === 0 ? ' hide="audio"' : i >= 3 ? ' hide="audio"' : '';
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
  out.push('  </tractor>');
  out.push('</mlt>');
  return out.join('\n');
}

fs.mkdirSync(outDir, { recursive: true });
const pad = (n) => String(n).padStart(2, '0');
const fmtDur = (f) => { const s = Math.round((f * 1001) / 30000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
for (const parts of shots) {
  const label = parts.map((p) => p.name).join('+');
  if (only.length && !only.some((n) => parts.some((p) => p.name === n))) continue;
  const file = path.join(outDir, `${parts[0].name}.mlt`);
  fs.writeFileSync(file, buildXml(parts));
  const frames = parts.reduce((s, p) => s + p.frames, 0);
  console.log(`${label}\t${fmtDur(frames)}\t${parts[0].codec}\t${parts[0].startTc}\t${parts[0].shootStart}`);
}
console.log(`샷 ${shots.length}개 (클립 ${clips.size}개)`);
