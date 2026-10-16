// 샷 하나를 MLT XML로 만든다(영상 조각 + 오디오 배치 계획).
//
// 출력 오디오 규칙(JTBC 2채널 인제스트):
//   음성이 있으면  CH1(왼쪽) = 음성(복구 음성 또는 사용 중인 ch1/ch3),  CH2(오른쪽) = 현장음(ch2/ch4)
//   음성이 없으면  CH1·CH2 모두 현장음
//
// plan = {
//   voiceFile: 복구된 음성 WAV(샷 전체 길이) | null,
//   voiceChannels: [채널 번호] — voiceFile이 없을 때 원본으로 쓸 음성 채널,
//   ambientChannels: [채널 번호],
// }
//
// MLT 주의(실측): tractor 필터는 mix 이후 적용 → 채널 필터는 producer 안에.
// panner split은 길이 없이 무시 → start 사용. mix 트랜지션은 입력마다 -3dB → volume +3.0103dB 보정.
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_XML } from './p2.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fwd = (p) => path.resolve(p).replace(/\\/g, '/');
const MIX_COMP_DB = 3.0103;

export function shotXml(shot, plan) {
  const out = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  out.push('<mlt LC_NUMERIC="C" version="7.0.0">');
  out.push(PROFILE_XML);
  const tracks = []; // { id, hideAudio }

  const producer = (pid, file, frames, { video = false, pan = null, gainDb = MIX_COMP_DB, note = '' } = {}) => {
    out.push(`  <producer id="${pid}" in="0" out="${frames - 1}">`);
    out.push(`    <property name="length">${frames}</property>`);
    out.push(`    <property name="resource">${esc(fwd(file))}</property>`);
    out.push('    <property name="mlt_service">avformat</property>');
    if (video) out.push('    <property name="audio_index">-1</property>');
    else out.push('    <property name="video_index">-1</property>');
    if (note) out.push(`    <property name="news:audio">${note}</property>`);
    if (!video) {
      if (pan != null) {
        out.push('    <filter mlt_service="panner">');
        out.push('      <property name="channel">-1</property>');
        out.push(`      <property name="start">${pan}</property>`);
        out.push('    </filter>');
      }
      out.push('    <filter mlt_service="volume">');
      out.push(`      <property name="level">${gainDb.toFixed(4)}</property>`);
      out.push('    </filter>');
    }
    out.push('  </producer>');
  };
  const playlist = (id, entries, hideAudio = false) => {
    out.push(`  <playlist id="${id}">`, ...entries, '  </playlist>');
    tracks.push({ id, hideAudio });
  };

  // 영상
  playlist(
    'video',
    shot.video.map((p, i) => {
      producer(`video_${i}`, p.file, p.frames, { video: true });
      return `    <entry producer="video_${i}" in="0" out="${p.frames - 1}"/>`;
    }),
    true,
  );

  // 원본 채널 트랙 (입력이 영상 조각과 같은 수면 조각별, 아니면 샷 전체 하나)
  const channelTrack = (ch, opts) => {
    const inputs = shot.channels[ch]?.inputs || [];
    if (!inputs.length) return;
    const perPart = inputs.length === shot.video.length;
    playlist(
      `a${ch + 1}`,
      inputs.map((file, i) => {
        const frames = perPart ? shot.video[i].frames : shot.frames;
        const pid = `a${ch + 1}_${i}`;
        producer(pid, file, frames, { ...opts, note: `ch${ch + 1}` });
        return `    <entry producer="${pid}" in="0" out="${frames - 1}"/>`;
      }),
    );
  };

  const hasVoice = !!plan.voiceFile || (plan.voiceChannels || []).length > 0;
  // 음성 → CH1
  if (plan.voiceFile) {
    producer('voice', plan.voiceFile, shot.frames, { pan: 0, note: 'restored-voice' });
    playlist('voice_bus', [`    <entry producer="voice" in="0" out="${shot.frames - 1}"/>`]);
  } else {
    for (const ch of plan.voiceChannels || []) channelTrack(ch, { pan: 0 });
  }
  // 현장음 → CH2 (음성이 없으면 양쪽). 채널이 여럿이면 평균(각 -6dB).
  const amb = plan.ambientChannels || [];
  const ambGain = MIX_COMP_DB - (amb.length > 1 ? 20 * Math.log10(amb.length) : 0);
  for (const ch of amb) channelTrack(ch, { pan: hasVoice ? 1 : null, gainDb: ambGain });

  out.push(`  <tractor id="tractor0" in="0" out="${shot.frames - 1}">`);
  out.push(`    <property name="news:shot">${esc(shot.label)}</property>`);
  for (const t of tracks) out.push(`    <track producer="${t.id}"${t.hideAudio ? ' hide="audio"' : ''}/>`);
  for (let i = 1; i < tracks.length; i++) {
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

export function writeShotMlt(shot, plan, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tag = plan.voiceFile ? '_vi' : '';
  const file = path.join(dir, `${shot.id}${tag}.mlt`);
  fs.writeFileSync(file, shotXml(shot, plan));
  return file;
}

// 분석 결과로 기본 배치 계획을 만든다(복구 음성 없이).
export function basePlan(shot, analysis) {
  const roles = shot.channels.map((c) => c.role);
  if (shot.source === 'file') {
    // 일반 카메라: 내장 마이크 = 현장음. 음성(싱크)이면 같은 소리를 복구해 CH1에 쓴다(복구 음성이 없으면 양쪽 현장음).
    return { voiceFile: null, voiceChannels: [], ambientChannels: roles.length ? [0] : [] };
  }
  const voiceCh = (analysis?.voiceChannels || []).filter((c) => roles[c] === 'voice');
  let ambient = roles.map((r, i) => (r === 'ambient' ? i : -1)).filter((i) => i >= 0);
  // ch2와 ch4가 같은 프런트 마이크 복제면 하나만 쓴다
  if (ambient.length > 1 && analysis?.ambientDuplicate !== false) ambient = [ambient[0]];
  return { voiceFile: null, voiceChannels: voiceCh, ambientChannels: ambient };
}
