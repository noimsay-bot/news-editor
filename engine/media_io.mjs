// 미디어 검사(ffprobe) — 규격을 하드코딩하지 않고 실제 파일에서 읽는다 (DEVELOPMENT_SPEC §2, F-01)
import fs from 'node:fs';
import path from 'node:path';
import { EngineError, requireTool, run } from './tools.mjs';

const ratio = (s) => {
  const [a, b] = String(s || '0/0').split('/').map(Number);
  return { num: a || 0, den: b || 0, value: b ? a / b : 0 };
};
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']); // PQ, HLG
const bitDepthOf = (st) => {
  if (st.bits_per_raw_sample && Number(st.bits_per_raw_sample) > 0) return Number(st.bits_per_raw_sample);
  const m = String(st.pix_fmt || '').match(/p(9|10|12|14|16)/);
  return m ? Number(m[1]) : st.pix_fmt ? 8 : null;
};

export async function inspect(input) {
  const file = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new EngineError('INPUT_NOT_FOUND', `파일을 찾을 수 없습니다: ${file}`, 2);
  }
  if (!stat.isFile()) throw new EngineError('INPUT_NOT_FILE', `파일이 아닙니다: ${file}`, 2);
  const ffprobe = requireTool('ffprobe');
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 120000 });
  if (r.code !== 0) throw new EngineError('PROBE_FAILED', `미디어를 읽을 수 없습니다(지원하지 않는 형식일 수 있음): ${r.stderr.trim().slice(0, 300)}`, 3);
  const j = JSON.parse(r.stdout);
  const fmt = j.format || {};
  const warnings = [];
  const video = [];
  const audio = [];
  for (const st of j.streams || []) {
    if (st.codec_type === 'video' && st.disposition?.attached_pic !== 1) {
      const rFps = ratio(st.r_frame_rate);
      const aFps = ratio(st.avg_frame_rate);
      const vfr = rFps.value > 0 && aFps.value > 0 && Math.abs(rFps.value - aFps.value) / rFps.value > 0.001;
      const transfer = st.color_transfer || null;
      const v = {
        index: st.index,
        codec: st.codec_name,
        profile: st.profile || null,
        width: st.width,
        height: st.height,
        sample_aspect_ratio: st.sample_aspect_ratio || null,
        display_aspect_ratio: st.display_aspect_ratio || null,
        fps_num: (aFps.value ? aFps : rFps).num,
        fps_den: (aFps.value ? aFps : rFps).den,
        fps: Number(((aFps.value || rFps.value) || 0).toFixed(6)),
        vfr,
        field_order: st.field_order || 'unknown',
        pix_fmt: st.pix_fmt || null,
        bit_depth: bitDepthOf(st),
        color_space: st.color_space || null,
        color_transfer: transfer,
        color_primaries: st.color_primaries || null,
        color_range: st.color_range || null,
        hdr: HDR_TRANSFERS.has(transfer),
        nb_frames: st.nb_frames ? Number(st.nb_frames) : null,
        duration: st.duration ? Number(st.duration) : null,
        start_time: st.start_time ? Number(st.start_time) : null,
        timecode: st.tags?.timecode || null,
        rotation: Number(st.tags?.rotate || st.side_data_list?.find((d) => d.rotation != null)?.rotation || 0),
      };
      if (v.vfr) warnings.push({ code: 'VFR', message: '가변 프레임레이트(VFR) 영상입니다. 컷·싱크 처리 시 확인이 필요합니다.' });
      if (v.hdr) warnings.push({ code: 'HDR_UNSUPPORTED', message: `HDR 전송 특성(${transfer})입니다. 색 변환은 지원하지 않으며 임의 SDR 변환을 하지 않습니다.` });
      if (!v.color_transfer || !v.color_primaries) warnings.push({ code: 'COLOR_METADATA_MISSING', message: '색공간 메타데이터가 없습니다. 임의로 Rec.709로 가정하지 않습니다.' });
      video.push(v);
    } else if (st.codec_type === 'audio') {
      audio.push({
        index: st.index,
        codec: st.codec_name,
        sample_rate: Number(st.sample_rate) || null,
        channels: st.channels || null,
        channel_layout: st.channel_layout || null,
        sample_fmt: st.sample_fmt || null,
        bit_depth: Number(st.bits_per_raw_sample || st.bits_per_sample) || null,
        duration: st.duration ? Number(st.duration) : null,
        start_time: st.start_time ? Number(st.start_time) : null,
      });
    }
  }
  if (!video.length && !audio.length) throw new EngineError('NO_MEDIA_STREAMS', '영상·음성 스트림이 없습니다.', 3);
  return {
    path: file,
    size: stat.size,
    mtime_ms: Math.round(stat.mtimeMs),
    container: fmt.format_name || null,
    duration: fmt.duration ? Number(fmt.duration) : null,
    start_time: fmt.start_time ? Number(fmt.start_time) : null,
    bit_rate: fmt.bit_rate ? Number(fmt.bit_rate) : null,
    timecode: fmt.tags?.timecode || video[0]?.timecode || null,
    creation_time: fmt.tags?.creation_time || null,
    video,
    audio,
    warnings,
  };
}
