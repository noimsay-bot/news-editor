// Shotcut 프로젝트(.mlt) 생성과 JTBC 규격 MPEG-2 출력.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MELT } from './paths.mjs';
import { PROFILE_XML } from './p2.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');

// 클립에 붙일 자동 보정 필터. Shotcut 필터 패널에서 일반 필터로 보이고 켜고 끌 수 있다.
export function clipFiltersXml(a, kind, opts, lutPath) {
  const x = [];
  if (!a?.done) return '';
  if (opts.wb && a.wbNeeded) {
    x.push('    <filter mlt_service="frei0r.colgate">');
    x.push(`      <property name="0">${a.wbNeutral}</property>`);
    x.push('      <property name="1">0.433333</property>'); // 6500K
    x.push('      <property name="threads">0</property>');
    x.push('      <property name="news:auto">wb</property>');
    x.push('    </filter>');
  }
  if (opts.exposure && a.exposureNeeded && lutPath) {
    // HDR식 구역 노출 3D LUT (lib/hdr.mjs). Shotcut 필터 패널에 '3D LUT'로 보인다.
    x.push('    <filter mlt_service="avfilter.lut3d">');
    x.push(`      <property name="av.file">${esc(fwd(lutPath))}</property>`);
    x.push('      <property name="av.interp">tetrahedral</property>');
    x.push('      <property name="news:auto">hdr</property>');
    x.push('    </filter>');
  }
  // 복구 음성(DeepFilterNet)이 연결된 클립은 RNNoise를 걸지 않는다. DFN이 없을 때만 대체 체인을 쓴다.
  if (opts.noise && kind === 'sync' && !opts.voiceRestored) {
    // 보이스 아이솔레이션 (Resolve 매뉴얼의 Voice Isolation 동작을 오픈소스로 구현):
    // 1) 80Hz 고역통과로 바람·차량·공조 저역 잡음 제거  2) RNNoise(음성 학습 신경망)로 배경음 분리
    // Amount = 원본과 분리된 음성을 섞는 비율 (매뉴얼 권장 70~80)
    const amount = Math.max(0, Math.min(100, opts.voiceAmount ?? 100)) / 100;
    x.push('    <filter mlt_service="ladspa.1890">');
    x.push('      <property name="0">80</property>');
    x.push('      <property name="1">1</property>');
    x.push('      <property name="wetness">1</property>');
    x.push('      <property name="news:auto">voice</property>');
    x.push('    </filter>');
    x.push('    <filter mlt_service="rnnoise">');
    x.push(`      <property name="mix">${amount.toFixed(2)}</property>`);
    x.push('      <property name="news:auto">noise</property>');
    x.push('    </filter>');
  }
  return x.length ? x.join('\n') + '\n' : '';
}

// items: [{ shot, kind: 'sync'|'sketch', analysis, mltPath }]
// V1 싱크는 0부터, V2 스케치는 싱크가 끝난 뒤부터 → 재생하면 싱크 → 스케치 순서로 다 보인다.
export function buildProject(items, opts) {
  const range = (it) => {
    let inP = 0;
    let outP = it.shot.frames - 1;
    if (opts.shake && it.kind === 'sketch' && it.analysis?.done) {
      inP = it.analysis.trimHead || 0;
      outP = it.shot.frames - 1 - (it.analysis.trimTail || 0);
    }
    return [inP, outP];
  };
  const sync = items.filter((i) => i.kind === 'sync');
  const sketch = items.filter((i) => i.kind === 'sketch');
  const len = (list) => list.reduce((s, it) => {
    const [a, b] = range(it);
    return s + b - a + 1;
  }, 0);
  const syncLen = len(sync);
  const total = Math.max(1, syncLen + len(sketch));

  const x = [];
  x.push('<?xml version="1.0" encoding="utf-8"?>');
  x.push('<mlt LC_NUMERIC="C" version="7.40.0" title="뉴스 원본 편집기" producer="main_bin">');
  x.push(PROFILE_XML);
  x.push('  <playlist id="main_bin">', '    <property name="xml_retain">1</property>', '  </playlist>');
  x.push(`  <producer id="black" in="0" out="${total - 1}">`);
  x.push(`    <property name="length">${total}</property>`);
  x.push('    <property name="eof">pause</property>');
  x.push('    <property name="resource">0</property>');
  x.push('    <property name="aspect_ratio">1</property>');
  x.push('    <property name="mlt_service">color</property>');
  x.push('    <property name="mlt_image_format">rgba</property>');
  x.push('    <property name="set.test_audio">0</property>');
  x.push('  </producer>');
  x.push('  <playlist id="background">', `    <entry producer="black" in="0" out="${total - 1}"/>`, '  </playlist>');

  const track = (id, name, list, blank) => {
    const entries = [];
    if (blank > 0) entries.push(`    <blank length="${blank}"/>`);
    for (const it of list) {
      const pid = `clip_${it.shot.name}`;
      const [a, b] = range(it);
      x.push(`  <producer id="${pid}" in="0" out="${it.shot.frames - 1}">`);
      x.push(`    <property name="length">${it.shot.frames}</property>`);
      x.push(`    <property name="resource">${esc(fwd(it.mltPath))}</property>`);
      x.push('    <property name="mlt_service">xml</property>');
      x.push(`    <property name="shotcut:caption">${it.kind === 'sync' ? '싱크' : '스케치'} ${esc(it.shot.label)}</property>`);
      const filters = clipFiltersXml(it.analysis, it.kind, { ...opts, voiceRestored: it.voiceRestored }, it.lutPath);
      if (filters) x.push(filters.trimEnd());
      x.push('  </producer>');
      entries.push(`    <entry producer="${pid}" in="${a}" out="${b}"/>`);
    }
    x.push(`  <playlist id="${id}">`);
    x.push('    <property name="shotcut:video">1</property>');
    x.push(`    <property name="shotcut:name">${name}</property>`);
    x.push(...entries, '  </playlist>');
  };
  track('playlist0', 'V1 싱크', sync, 0);
  track('playlist1', 'V2 스케치', sketch, syncLen);

  x.push(`  <tractor id="tractor0" title="뉴스 원본 편집기" in="0" out="${total - 1}">`);
  x.push('    <property name="shotcut">1</property>');
  x.push('    <property name="shotcut:projectAudioChannels">2</property>');
  x.push('    <track producer="background"/>', '    <track producer="playlist0"/>', '    <track producer="playlist1"/>');
  for (const b of [1, 2]) {
    x.push('    <transition mlt_service="mix">');
    x.push('      <property name="a_track">0</property>');
    x.push(`      <property name="b_track">${b}</property>`);
    x.push('      <property name="always_active">1</property>');
    x.push('      <property name="sum">1</property>');
    x.push('    </transition>');
  }
  x.push('    <transition mlt_service="qtblend">');
  x.push('      <property name="a_track">1</property>');
  x.push('      <property name="b_track">2</property>');
  x.push('      <property name="compositing">0</property>');
  x.push('      <property name="distort">0</property>');
  x.push('      <property name="threads">0</property>');
  x.push('    </transition>');
  x.push('  </tractor>', '</mlt>', '');
  return { xml: x.join('\n'), total, syncCount: sync.length, sketchCount: sketch.length };
}

// EDIUS JTBC 프리셋(EDIUS9_JTBC_XDCAM_MPEG2 MXF_50M.tpd)과 같은 규격.
// Shotcut 내장 consumer/avformat/XDCAM-HD422 + 1080i TFF + PCM 16bit 2ch.
export const XDCAM_ARGS = [
  'f=mxf', 'vcodec=mpeg2video', 'top_field_first=1', 'progressive=0', 'pix_fmt=yuv422p',
  'minrate=50M', 'maxrate=50M', 'vb=50M', 'dc=10', 'intra_vlc=1', 'non_linear_quant=1',
  'lmin=1*QP2LAMBDA', 'rc_max_vbv_use=1', 'rc_min_vbv_use=1', 'qmin=1', 'qmax=12',
  'bufsize=36408333', 'g=12', 'bf=2', 'vtag=xd5e',
  'acodec=pcm_s16le', 'channels=2', 'ar=48000',
  // width/height를 지정하면 melt가 끝에서 멈춘다(실측). 해상도는 프로젝트 프로파일(1920x1080)을 따른다.
];

// melt로 출력. onProgress(percent) 호출, 완료 시 { ok, log } 반환.
export function exportXdcam(projectPath, target, onProgress, opts = {}) {
  return new Promise((resolve) => {
    const args = [
      projectPath,
      ...(opts.in != null ? [`in=${opts.in}`] : []),
      ...(opts.out != null ? [`out=${opts.out}`] : []),
      '-progress',
      // terminate_on_pause: 타임라인 끝(일시정지)에서 melt가 끝나도록 (없으면 마지막에 멈춤)
      '-consumer', `avformat:${target}`, ...XDCAM_ARGS, 'real_time=-3', 'threads=0', 'terminate_on_pause=1',
    ];
    // stdin을 닫아야 한다: melt는 stdin에서 조작 키를 읽어서, 열려 있으면 끝에서 멈춘다.
    const p = spawn(MELT, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const onData = (d) => {
      const s = d.toString();
      log = (log + s).slice(-20000);
      const m = [...s.matchAll(/percentage:\s*(\d+)/g)].at(-1);
      if (m) onProgress?.(Number(m[1]));
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => resolve({ ok: code === 0 && fs.existsSync(target), code, log }));
    p.on('error', (e) => resolve({ ok: false, code: -1, log: String(e) }));
    opts.onSpawn?.(p);
  });
}
