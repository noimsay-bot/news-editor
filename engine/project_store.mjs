// 비파괴 프로젝트 저장소 (DEVELOPMENT_SPEC F-01, §5.4)
// - 원본은 참조만 한다(절대/상대 경로 + SHA-256 + 크기 + 수정시각).
// - 모든 효과는 기본 비활성(enabled:false, 강도 0) — P0 안전 기본값.
// - 저장은 임시 파일 → 원자적 이름 바꾸기. 실패하면 이전 파일이 그대로 남는다.
import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './hash.mjs';
import { inspect } from './media_io.mjs';
import { EngineError } from './tools.mjs';

export const SCHEMA_VERSION = 1;

// 효과 기본값: 모두 OFF / 강도 0 / 원음 혼합 변경 없음
export function defaultFilters() {
  return [
    {
      id: 'audio_restore',
      enabled: false,
      params: { strength: 0, highpass_hz: 0, notch_hz: 0, notch_harmonics: 0, eq: [], noise_profile: null, wet: 100, attack_ms: 50, release_ms: 300 },
    },
    { id: 'masked_exposure', enabled: false, params: { ev: 0.0, shadows: 0, midtones: 0, contrast: 0, saturation: 0, feather: 0 }, mask_id: null },
    { id: 'video_denoise', enabled: false, params: { strength: 0, chroma: 0, temporal_radius: 0, mix: 100 } },
    { id: 'white_balance', enabled: false, params: { temperature: 0, tint: 0 }, mask_id: null },
  ];
}

const nowIso = () => new Date().toISOString();
const sameFile = (a, b) => {
  const na = path.resolve(a), nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

export function createProject(name = 'untitled') {
  const t = nowIso();
  return { schema_version: SCHEMA_VERSION, project_name: name, created_at: t, updated_at: t, sources: [], clips: [], masks: [], export: { preset_id: null }, history: [{ at: t, action: 'create' }] };
}

function sourceMetadata(info) {
  const v = info.video[0], a = info.audio[0];
  return {
    container: info.container,
    duration: info.duration,
    timecode: info.timecode,
    has_video: !!v,
    has_audio: !!a,
    fps_num: v?.fps_num ?? null,
    fps_den: v?.fps_den ?? null,
    vfr: v?.vfr ?? null,
    field_order: v?.field_order ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    pix_fmt: v?.pix_fmt ?? null,
    color_transfer: v?.color_transfer ?? null,
    hdr: v?.hdr ?? false,
    sample_rate: a?.sample_rate ?? null,
    audio_channels: info.audio.map((x) => x.channels),
  };
}

// 원본 추가: 실제 SHA-256 계산값을 기록한다(자리표시자 금지 — §5.4)
export async function addSource(project, file) {
  const info = await inspect(file);
  const sha256 = await sha256File(info.path);
  const id = `src${project.sources.length + 1}`;
  const src = { id, path: info.path, sha256, size: info.size, mtime_ms: info.mtime_ms, metadata: sourceMetadata(info), warnings: info.warnings };
  project.sources.push(src);
  // 원본 전체를 하나의 클립으로 (in/out은 영상이면 프레임, 음성만 있으면 샘플)
  const m = src.metadata;
  const clip = { id: `clip${project.clips.length + 1}`, source_id: id, filters: defaultFilters() };
  if (m.has_video && m.fps_num && m.fps_den) {
    clip.in_frame = 0;
    clip.out_frame_exclusive = Math.round((m.duration || 0) * m.fps_num / m.fps_den);
  } else {
    clip.in_sample = 0;
    clip.out_sample_exclusive = Math.round((m.duration || 0) * (m.sample_rate || 48000));
  }
  project.clips.push(clip);
  project.history.push({ at: nowIso(), action: 'add_source', source_id: id, sha256 });
  return src;
}

function checkSchema(p) {
  if (!p || typeof p !== 'object') throw new EngineError('PROJECT_INVALID', '프로젝트 파일 형식이 올바르지 않습니다.', 2);
  if (p.schema_version !== SCHEMA_VERSION) throw new EngineError('PROJECT_SCHEMA', `지원하지 않는 프로젝트 스키마 버전입니다: ${p.schema_version}`, 2);
  for (const k of ['sources', 'clips', 'masks', 'history']) if (!Array.isArray(p[k])) throw new EngineError('PROJECT_INVALID', `프로젝트에 ${k} 항목이 없습니다.`, 2);
  const ids = new Set(p.sources.map((s) => s.id));
  for (const c of p.clips) if (!ids.has(c.source_id)) throw new EngineError('PROJECT_INVALID', `클립 ${c.id}의 원본(${c.source_id})이 없습니다.`, 2);
}

export function saveProject(project, file) {
  checkSchema(project);
  const out = path.resolve(file);
  for (const s of project.sources) if (sameFile(s.path, out)) throw new EngineError('OUTPUT_IS_SOURCE', '프로젝트 파일 경로가 원본 미디어와 같습니다.', 2);
  project.updated_at = nowIso();
  // 상대 경로도 함께 기록(프로젝트 폴더를 옮겼을 때 찾기 위해)
  for (const s of project.sources) s.rel_path = path.relative(path.dirname(out), s.path).split(path.sep).join('/');
  project.history.push({ at: project.updated_at, action: 'save' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2) + '\n');
  fs.renameSync(tmp, out);
  return out;
}

export function loadProject(file) {
  let p;
  try {
    p = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new EngineError('PROJECT_UNREADABLE', `프로젝트를 읽을 수 없습니다: ${e.message}`, 2);
  }
  checkSchema(p);
  // 절대 경로가 없으면 상대 경로로 찾는다
  for (const s of p.sources) {
    if (!fs.existsSync(s.path) && s.rel_path) {
      const alt = path.resolve(path.dirname(path.resolve(file)), s.rel_path);
      if (fs.existsSync(alt)) s.path = alt;
    }
  }
  return p;
}

// 원본 확인: 없어짐/크기·시각 변경/해시 변경
export async function validateProject(project, { deep = true } = {}) {
  checkSchema(project);
  const issues = [];
  for (const s of project.sources) {
    let st;
    try {
      st = fs.statSync(s.path);
    } catch {
      issues.push({ code: 'SOURCE_MISSING', source_id: s.id, message: `원본을 찾을 수 없습니다: ${s.path}` });
      continue;
    }
    if (st.size !== s.size) {
      issues.push({ code: 'SOURCE_CHANGED', source_id: s.id, message: `원본 크기가 바뀌었습니다: ${s.path}` });
      continue;
    }
    if (deep) {
      const h = await sha256File(s.path);
      if (h !== s.sha256) issues.push({ code: 'SOURCE_CHANGED', source_id: s.id, message: `원본 SHA-256이 다릅니다: ${s.path}` });
    }
  }
  return { ok: issues.length === 0, issues };
}
