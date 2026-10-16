// 비파괴 렌더 (DEVELOPMENT_SPEC §5.5, F-07 일부)
// 원본 해시 검증 → 출력≠입력 확인 → 임시 파일 → ffprobe 검증 → 원자적 이동 → 감사 보고서.
// 미구현 효과가 켜져 있으면 결과를 흉내 내지 않고 실패한다(fail closed).
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_ALGORITHM, isAudioActive, processAudio, removedComponent } from './audio.mjs';
import { decodePcm, writeRawF32 } from './pcm.mjs';
import { sha256File } from './hash.mjs';
import { inspect } from './media_io.mjs';
import { validateProject } from './project_store.mjs';
import { EngineError, requireTool, run } from './tools.mjs';
import { ENGINE_VERSION, ffmpegVersion } from './version.mjs';

const sameFile = (a, b) => {
  const na = path.resolve(a), nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

// 원본 샘플 형식을 보존하는 PCM 코덱 (재양자화 없이 동일 신호)
export function pcmCodecFor(audioStream) {
  const fmt = String(audioStream?.sample_fmt || '');
  const bits = audioStream?.bit_depth || 0;
  if (fmt.startsWith('flt')) return 'pcm_f32le';
  if (fmt.startsWith('dbl')) return 'pcm_f64le';
  if (fmt.startsWith('s32')) return bits && bits <= 24 ? 'pcm_s24le' : 'pcm_s32le';
  if (fmt.startsWith('u8')) return 'pcm_u8';
  return 'pcm_s16le';
}

function clipRange(clip, src) {
  const m = src.metadata;
  if (clip.in_frame != null) {
    const fps = m.fps_num / m.fps_den;
    return { start: clip.in_frame / fps, end: clip.out_frame_exclusive / fps, full: clip.in_frame === 0 && Math.abs(clip.out_frame_exclusive / fps - (m.duration || 0)) < 1 / fps };
  }
  const sr = m.sample_rate || 48000;
  return { start: clip.in_sample / sr, end: clip.out_sample_exclusive / sr, full: clip.in_sample === 0 && Math.abs(clip.out_sample_exclusive / sr - (m.duration || 0)) < 0.001 };
}

const IMPLEMENTED = new Set(['audio_restore']);

export async function renderProject(project, output, { reportPath, overwrite = false, signal, onProgress, removedOutput } = {}) {
  const startedAt = new Date().toISOString();
  const out = path.resolve(output);
  for (const s of project.sources) if (sameFile(s.path, out)) throw new EngineError('OUTPUT_IS_SOURCE', '출력 경로가 원본과 같습니다. 원본은 덮어쓸 수 없습니다.', 2);
  if (fs.existsSync(out) && !overwrite) throw new EngineError('OUTPUT_EXISTS', `출력 파일이 이미 있습니다: ${out} (--overwrite로 교체)`, 2);
  if (project.clips.length !== 1) throw new EngineError('NOT_IMPLEMENTED', '여러 클립 렌더(컷편집)는 M4에서 지원합니다. 현재는 클립 1개만 렌더합니다.', 2);

  const v = await validateProject(project, { deep: true });
  if (!v.ok) throw new EngineError('MEDIA_MISMATCH', v.issues.map((i) => i.message).join('\n'), 4, v.issues);
  const before = Object.fromEntries(project.sources.map((s) => [s.id, s.sha256]));

  const clip = project.clips[0];
  const src = project.sources.find((s) => s.id === clip.source_id);
  const enabled = clip.filters.filter((f) => f.enabled);
  for (const f of enabled) if (!IMPLEMENTED.has(f.id)) throw new EngineError('NOT_IMPLEMENTED', `효과 '${f.id}'는 아직 구현되지 않았습니다. 끄고 다시 렌더하세요.`, 2);
  const audioFilter = clip.filters.find((f) => f.id === 'audio_restore');
  const audioActive = isAudioActive(audioFilter);

  const info = await inspect(src.path);
  const range = clipRange(clip, src);
  const ext = path.extname(out).toLowerCase();
  const ffmpeg = requireTool('ffmpeg');
  const args = ['-v', 'error', '-nostdin', '-y', '-progress', 'pipe:2'];
  const pipeline = [];
  const warnings = [...(src.warnings || [])];
  const trim = range.full ? [] : ['-ss', range.start.toFixed(6), '-to', range.end.toFixed(6)];

  const tmp = path.join(path.dirname(out), `.${path.basename(out, ext)}.part${process.pid}${ext}`);
  const tempFiles = [tmp];
  let audioStats = null;
  if (audioActive) {
    if (!info.audio.length) throw new EngineError('NO_AUDIO', '원본에 음성 스트림이 없습니다.', 3);
    if (ext !== '.wav' && !range.full) throw new EngineError('NOT_IMPLEMENTED', '부분 구간 영상 렌더는 M4(재인코딩 출력)에서 지원합니다. 음성만 .wav로 렌더하세요.', 2);
    if (ext !== '.wav' && !['.mov', '.mkv', '.mxf'].includes(ext)) throw new EngineError('UNSUPPORTED_OUTPUT', '음성 처리 결과를 영상과 결합하려면 출력 확장자를 .mov, .mkv, .mxf 중 하나로 지정하세요.', 3);
    onProgress?.(0.02);
    const pcm = await decodePcm(src.path, range.full ? { signal } : { start: range.start, end: range.end, signal });
    onProgress?.(0.2);
    const res = processAudio(pcm.channels, pcm.sampleRate, audioFilter.params, { clipStartSec: range.full ? 0 : range.start });
    onProgress?.(0.7);
    pipeline.push(...res.pipeline);
    warnings.push(...res.warnings);
    audioStats = res.stats;
    const raw = path.join(path.dirname(out), `.${path.basename(out, ext)}.audio${process.pid}.f32`);
    tempFiles.push(raw);
    writeRawF32(raw, res.channels);
    const rawIn = ['-f', 'f32le', '-ar', String(pcm.sampleRate), '-ac', String(pcm.channels.length), '-i', raw];
    if (ext === '.wav') {
      // 처리 결과는 32비트 부동소수점 WAV(클리핑을 숨기지 않음)
      args.push(...rawIn, '-c:a', 'pcm_f32le');
    } else {
      // 영상은 그대로 복사, 처리된 음성만 교체 → 립싱크 유지
      args.push('-i', src.path, ...rawIn, '-map', '0:v?', '-map', '1:a', '-c:v', 'copy', '-c:a', ext === '.mxf' ? 'pcm_s24le' : 'pcm_f32le', '-map_metadata', '0');
      pipeline.unshift('video:stream-copy');
    }
    if (removedOutput) {
      // 제거된 성분(원본 − 결과) 따로 듣기
      const rem = removedComponent(pcm.channels, res.channels);
      const remRaw = raw + '.removed';
      tempFiles.push(remRaw);
      writeRawF32(remRaw, rem);
      const rr = await run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'f32le', '-ar', String(pcm.sampleRate), '-ac', String(rem.length), '-i', remRaw, '-c:a', 'pcm_f32le', path.resolve(removedOutput)]);
      if (rr.code !== 0) warnings.push({ code: 'REMOVED_RENDER_FAILED', message: '제거된 성분 파일을 만들지 못했습니다.' });
    }
  } else if (ext === '.wav') {
    if (!info.audio.length) throw new EngineError('NO_AUDIO', '원본에 음성 스트림이 없습니다.', 3);
    args.push(...trim, '-i', src.path, '-map', '0:a:0', '-vn', '-c:a', pcmCodecFor(info.audio[0]));
    pipeline.push('bypass:pcm-copy');
  } else {
    if (!range.full) throw new EngineError('NOT_IMPLEMENTED', '부분 구간의 원본 복사는 프레임 정확도를 보장할 수 없어 M4(재인코딩 출력)에서 지원합니다.', 2);
    args.push('-i', src.path, '-map', '0', '-c', 'copy', '-map_metadata', '0');
    pipeline.push('bypass:stream-copy');
  }

  args.push(tmp);
  const total = range.end - range.start;
  const r = await run(ffmpeg, args, {
    signal,
    onStderr: (s) => {
      const m = s.match(/out_time_us=(\d+)/g);
      if (m && onProgress && total > 0) onProgress(Math.min(1, Number(m.at(-1).split('=')[1]) / 1e6 / total));
    },
  }).catch((e) => ({ code: -1, stderr: String(e), aborted: e.name === 'AbortError' }));
  const cleanup = () => tempFiles.forEach((f) => fs.rmSync(f, { force: true }));
  if (signal?.aborted || r.aborted) {
    cleanup();
    throw new EngineError('CANCELLED', '렌더를 취소했습니다. 부분 파일은 삭제했습니다.', 130);
  }
  if (r.code !== 0) {
    cleanup();
    throw new EngineError('RENDER_FAILED', `렌더 실패: ${r.stderr.trim().slice(-600)}`, 5);
  }
  // 결과 검증 후 원자적 이동
  let outInfo;
  try {
    outInfo = await inspect(tmp);
  } catch (e) {
    cleanup();
    throw new EngineError('RENDER_INVALID', `출력 검증 실패: ${e.message}`, 5);
  }
  if (Math.abs((outInfo.duration || 0) - total) > Math.max(0.05, 2 / (info.video[0]?.fps || 25))) warnings.push({ code: 'DURATION_MISMATCH', message: `출력 길이(${outInfo.duration}s)가 기대값(${total.toFixed(3)}s)과 다릅니다.` });
  if (overwrite && fs.existsSync(out)) fs.rmSync(out);
  fs.renameSync(tmp, out);
  tempFiles.slice(1).forEach((f) => fs.rmSync(f, { force: true }));

  // 원본 무결성 사후 확인 (T-11)
  const after = {};
  for (const s of project.sources) after[s.id] = await sha256File(s.path);
  const report = {
    tool: 'News Restoration Studio engine',
    engine_version: ENGINE_VERSION,
    ffmpeg_version: await ffmpegVersion(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    project_name: project.project_name,
    no_generation: true,
    sources: project.sources.map((s) => ({ id: s.id, path: s.path, sha256_before: before[s.id], sha256_after: after[s.id], unchanged: before[s.id] === after[s.id] })),
    range_seconds: { start: range.start, end: range.end },
    filters: clip.filters.map((f) => ({ id: f.id, enabled: f.enabled, params: f.params })),
    pipeline,
    audio_algorithm: audioActive ? AUDIO_ALGORITHM : null,
    audio_stats: audioStats,
    output: { path: out, sha256: await sha256File(out), container: outInfo.container, duration: outInfo.duration, video: outInfo.video, audio: outInfo.audio },
    warnings,
  };
  if (!report.sources.every((s) => s.unchanged)) throw new EngineError('SOURCE_MODIFIED', '렌더 중 원본이 변경되었습니다!', 4, report);
  if (reportPath) {
    const rp = path.resolve(reportPath);
    fs.writeFileSync(`${rp}.tmp`, JSON.stringify(report, null, 2) + '\n');
    fs.renameSync(`${rp}.tmp`, rp);
  }
  return report;
}
