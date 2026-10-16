// 뉴스 원본 편집기 — 로컬 서버.
// 화면(public/index.html)은 브라우저로 열고, 편집 엔진은 설치된 Shotcut/melt/ffmpeg를 그대로 쓴다.
// 소스: P2 카드 + 일반 카메라 파일(스마트폰·고프로·오스모·드론 등)을 함께 불러올 수 있다.
// 사용: node server.mjs [--port 4310] [--no-open]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeShot, RULES } from './lib/analyzer.mjs';
import { writeZoneCube, zoneParams } from './lib/hdr.mjs';
import { attachCachedFileAudio, Library, prepareFileAudio } from './lib/library.mjs';
import { defaultContentsDir } from './lib/p2.mjs';
import { DATA_DIR, FFMPEG, MELT, SETTINGS_FILE, SHOTCUT, SHOTCUT_DIR } from './lib/paths.mjs';
import { buildProject, exportXdcam } from './lib/project.mjs';
import { basePlan, writeShotMlt } from './lib/shotxml.mjs';
import * as voice from './lib/voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 4310;
const ANALYSIS_THREADS = 3;
const VOICE_THREADS = 3;
const ANALYSIS_VERSION = 3; // 분석 규칙이 바뀌면 올린다(캐시 무효화)

// ------------------------------------------------------------------ 설정
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
const settings = {
  phrases: ['[정제본_영상취재]'],
  phrase: '[정제본_영상취재]',
  dateOn: true,
  outDir: path.join(process.env.USERPROFILE || '', 'Desktop'),
  contentsDir: defaultContentsDir(),
  hdrStrength: 100,
  voiceAmount: 100, // 음성 복구 강도: 100 = 최대(감쇠 한계 없음)
  // DEVELOPMENT_SPEC: DeepFilterNet은 검증 전 기본 비활성. true일 때만 분석 후 미리 복구 렌더링
  voicePrecompute: false,
  ...loadSettings(),
};

// ------------------------------------------------------------------ 상태
const state = {
  lib: null, // Library
  analysis: {}, // shot.id → 분석 결과
  job: null,
  project: null,
  exportJob: null,
  voice: { tasks: new Map(), total: 0, done: 0, failed: 0, running: 0 },
};
const voiceQueue = [];

// 샷별 작업 폴더: 카드·폴더가 바뀌어도 섞이지 않고, 한 번 처리한 결과는 다시 쓰인다.
const shotDir = (shot) => path.join(DATA_DIR, 'shots', crypto.createHash('sha1').update(shot.key).digest('hex').slice(0, 16));
const analysisFile = (shot) => path.join(shotDir(shot), 'analysis.json');

function loadCachedAnalysis(shot) {
  try {
    const j = JSON.parse(fs.readFileSync(analysisFile(shot), 'utf8'));
    return j.version === ANALYSIS_VERSION ? j.analysis : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 음성 복구 대기열
function queueVoice(shot, ch, strength, front = false) {
  const key = `${shot.key}|${ch}|${voice.attenDb(strength)}`;
  const v = state.voice;
  if (v.tasks.has(key)) {
    const t = v.tasks.get(key);
    if (front && t.queued) {
      const i = voiceQueue.indexOf(t);
      if (i > 0) voiceQueue.unshift(...voiceQueue.splice(i, 1));
    }
    return t.promise;
  }
  const t = { key, shot, ch, strength, dir: shotDir(shot), queued: true };
  t.promise = new Promise((resolve) => (t.resolve = resolve));
  v.tasks.set(key, t);
  v.total++;
  front ? voiceQueue.unshift(t) : voiceQueue.push(t);
  pumpVoice();
  return t.promise;
}
function pumpVoice() {
  const v = state.voice;
  while (v.running < VOICE_THREADS && voiceQueue.length) {
    const t = voiceQueue.shift();
    t.queued = false;
    v.running++;
    voice
      .restoreChannel(t.shot, t.ch, t.strength, t.dir)
      .then((file) => t.resolve(file))
      .catch((e) => {
        v.failed++;
        console.error('음성 복구 실패', t.key, e.message);
        t.resolve(null);
      })
      .finally(() => {
        v.running--;
        v.done++;
        pumpVoice();
      });
  }
}

// 이 샷에서 복구할 음성 채널
//  P2: ch1·ch3 중 음성이 감지된 채널(같은 마이크 복제면 하나). 사용자가 싱크로 바꿨는데 감지된 채널이 없으면 레벨이 가장 큰 음성 채널.
//  일반 카메라: 내장 마이크(채널 0)
function voiceChannelsFor(shot, analysis) {
  if (!shot.channels.length) return [];
  if (shot.source === 'file') return shot.channels[0].inputs.length ? [0] : [];
  if (analysis?.voiceChannels?.length) return analysis.voiceChannels;
  const cands = shot.channels.map((c, i) => (c.role === 'voice' ? i : -1)).filter((i) => i >= 0);
  const lvl = (ch) => analysis?.perChannel?.[ch]?.ch1RmsDb ?? -100;
  const best = cands.sort((a, b) => lvl(b) - lvl(a))[0];
  return best != null && lvl(best) > -55 ? [best] : [];
}
function voiceBus(shot, analysis, strength, front = false) {
  const chs = voiceChannelsFor(shot, analysis);
  if (!chs.length || !voice.available()) return Promise.resolve(null);
  return voice.restoreVoiceBus(shot, chs, strength, shotDir(shot), (ch) => queueVoice(shot, ch, strength, front));
}
function queueSyncVoices() {
  if (!settings.voicePrecompute || !voice.available() || !state.lib) return;
  for (const s of state.lib.shots) {
    const a = state.analysis[s.id];
    if (a?.isSync) for (const ch of voiceChannelsFor(s, a)) queueVoice(s, ch, settings.voiceAmount);
  }
}
function voiceStatus() {
  const v = state.voice;
  return { available: voice.available(), total: v.total, done: v.done, failed: v.failed, running: v.running, queued: voiceQueue.length };
}

// ------------------------------------------------------------------ 소스 불러오기
function loadSources(dirs, append) {
  const lib = append && state.lib ? state.lib : new Library();
  if (!append) {
    voiceQueue.length = 0;
    state.analysis = {};
  }
  for (const d of dirs) lib.add(d);
  state.lib = lib;
  for (const s of lib.shots) {
    attachCachedFileAudio(s, shotDir(s));
    if (!state.analysis[s.id]) {
      const cached = loadCachedAnalysis(s);
      if (cached) state.analysis[s.id] = cached;
    }
  }
  settings.sources = lib.sources.map((s) => s.dir);
  settings.contentsDir = dirs[dirs.length - 1];
  saveSettings(settings);
  queueSyncVoices(); // 이전 분석이 있으면 바로 복구 시작(캐시된 것은 즉시 끝남)
  return summary();
}
const summary = () => (state.lib ? state.lib.summary(state.analysis) : null);

async function runAnalysis(ids) {
  const lib = state.lib;
  const queue = ids.map((id) => lib.shot(id)).filter(Boolean);
  state.job = { type: 'analyze', total: queue.length, done: 0, message: '분석 중' };
  const worker = async () => {
    while (queue.length) {
      const shot = queue.shift();
      try {
        await prepareFileAudio(shot, shotDir(shot), FFMPEG);
        const a = await analyzeShot(lib, shot);
        state.analysis[shot.id] = a;
        fs.mkdirSync(shotDir(shot), { recursive: true });
        fs.writeFileSync(analysisFile(shot), JSON.stringify({ version: ANALYSIS_VERSION, rules: RULES, analysis: a }));
        // 싱크로 판정되면 바로 음성 복구 예약
        if (settings.voicePrecompute && a.isSync && voice.available()) for (const ch of voiceChannelsFor(shot, a)) queueVoice(shot, ch, settings.voiceAmount);
      } catch (e) {
        state.analysis[shot.id] = { done: false, error: String(e.message || e) };
      }
      state.job.done++;
    }
  };
  await Promise.all(Array.from({ length: ANALYSIS_THREADS }, worker));
  state.job.finished = true;
  state.job.message = '분석 완료';
}

function launchShotcut(file) {
  spawn(SHOTCUT, [file], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

// 샷 하나의 배치 계획과 MLT 파일
async function shotForTimeline(shot, kind, opts, front = true) {
  const analysis = state.analysis[shot.id];
  const plan = basePlan(shot, analysis);
  if (kind !== 'sync') plan.voiceChannels = []; // 스케치: 양쪽 모두 현장음
  if (kind === 'sync') {
    if (opts.noise === true) { // 사용자가 켰을 때만 (기본 OFF)
      const file = await voiceBus(shot, analysis, opts.voiceAmount ?? settings.voiceAmount, front);
      if (file) {
        plan.voiceFile = file;
        plan.voiceChannels = [];
      }
    }
    if (!plan.voiceFile && shot.source === 'p2' && !plan.voiceChannels.length) plan.voiceChannels = voiceChannelsFor(shot, analysis);
  }
  return { plan, mltPath: writeShotMlt(shot, plan, shotDir(shot)) };
}

async function arrange(body) {
  const lib = state.lib;
  if (!lib) throw new Error('먼저 소스를 불러오세요.');
  const opts = body.opts || {};
  const items = [];
  for (const sel of body.items || []) {
    if (!sel.include) continue;
    const shot = lib.shot(sel.name);
    if (!shot) continue;
    const analysis = state.analysis[shot.id];
    let lutPath = null;
    // 역광 보정은 인터뷰(싱크) 클립에만 적용
    if (analysis?.exposureNeeded && opts.exposure && sel.kind === 'sync') {
      const strength = Math.max(0, Math.min(100, opts.hdrStrength ?? 100)) / 100;
      lutPath = writeZoneCube(path.join(shotDir(shot), 'luts', `${shot.id}.cube`), zoneParams(analysis.subjectLuma, analysis.backgroundLuma, strength));
    }
    const { plan, mltPath } = await shotForTimeline(shot, sel.kind, opts);
    items.push({ shot: { ...shot, name: shot.id }, kind: sel.kind, analysis, lutPath, voiceRestored: !!plan.voiceFile, mltPath });
  }
  if (!items.length) throw new Error('배치할 클립이 없습니다.');
  const result = buildProject(items, opts);
  // melt/MLT에는 영문 경로만 넘긴다 (Windows에서 한글 경로 인코딩 문제 방지)
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dir = path.join(DATA_DIR, 'timelines');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `timeline_${stamp}.mlt`);
  fs.writeFileSync(file, result.xml);
  state.project = { path: file, createdAt: Date.now(), ...result, xml: undefined };
  if (body.launch !== false) launchShotcut(file);
  return state.project;
}

// 원본 미리듣기용 WAV (조각 이어 붙임, 캐시)
const pending = new Map();
function ffmpegToFile(out, args) {
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (pending.has(out)) return pending.get(out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.part' + path.extname(out);
  const pr = new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...args, tmp], { windowsHide: true, stdio: 'ignore' });
    proc.on('close', (code) => {
      pending.delete(out);
      if (code === 0) {
        fs.renameSync(tmp, out);
        resolve(out);
      } else resolve(null);
    });
  });
  pending.set(out, pr);
  return pr;
}
function originalPreview(shot, ch) {
  const inputs = shot.channels[ch]?.inputs || [];
  if (!inputs.length) return Promise.resolve(null);
  const concat = inputs.length > 1 ? ['-filter_complex', `${inputs.map((_, i) => `[${i}:a]`).join('')}concat=n=${inputs.length}:v=0:a=1[a]`, '-map', '[a]'] : [];
  return ffmpegToFile(path.join(shotDir(shot), 'voice', `${shot.id}_ch${ch + 1}_orig.wav`), [...inputs.flatMap((f) => ['-i', f]), ...concat, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le']);
}
function thumbnail(shot) {
  if (shot.icon && fs.existsSync(shot.icon)) return Promise.resolve(shot.icon);
  const src = shot.proxy || shot.video[0].file;
  const at = Math.min(1, shot.seconds / 2).toFixed(2);
  return ffmpegToFile(path.join(shotDir(shot), 'thumb.jpg'), ['-ss', at, '-i', src, '-frames:v', '1', '-vf', 'scale=160:-2', '-q:v', '4']);
}

function sanitizeName(s) {
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

async function startExport(body) {
  if (!state.project) throw new Error('먼저 타임라인을 구성하세요.');
  if (state.exportJob && !state.exportJob.finished) throw new Error('이미 출력 중입니다.');
  const outDir = body.outDir || settings.outDir;
  fs.mkdirSync(outDir, { recursive: true });
  const base = sanitizeName(body.filename || '') || '출력';
  const target = path.join(outDir, `${base}.mxf`);
  if (fs.existsSync(target) && !body.overwrite) {
    const e = new Error('같은 이름의 파일이 있습니다.');
    e.code = 'EXISTS';
    e.target = target;
    throw e;
  }
  const saved = fs.statSync(state.project.path).mtimeMs > state.project.createdAt + 1000;
  const job = { target, percent: 0, finished: false, ok: false, savedInShotcut: saved, startedAt: Date.now() };
  state.exportJob = job;
  // 영문 임시 파일로 출력한 뒤 한글 파일명으로 옮긴다.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = path.join(DATA_DIR, `export_${Date.now()}.mxf`);
  exportXdcam(state.project.path, temp, (p) => (job.percent = p), { onSpawn: (p) => (job.proc = p) }).then((r) => {
    let ok = r.ok;
    if (ok) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        try {
          fs.renameSync(temp, target);
        } catch {
          fs.copyFileSync(temp, target); // 다른 드라이브면 복사
          fs.unlinkSync(temp);
        }
      } catch (e) {
        ok = false;
        r.log += `\n파일 이동 실패: ${e.message}`;
      }
    } else {
      fs.rmSync(temp, { force: true });
    }
    job.finished = true;
    job.ok = ok;
    job.percent = ok ? 100 : job.percent;
    job.seconds = (Date.now() - job.startedAt) / 1000;
    if (!ok) job.log = r.log.slice(-3000);
    job.proc = undefined;
  });
  return { target, savedInShotcut: saved };
}

// ------------------------------------------------------------------ HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}
function sendFileRange(req, res, file, type) {
  if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size;
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
}
const exportView = () => state.exportJob && { ...state.exportJob, proc: undefined };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p.startsWith('/static/'))) {
      const file = path.join(HERE, 'public', p === '/' ? 'index.html' : p.slice('/static/'.length));
      if (!file.startsWith(path.join(HERE, 'public'))) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
    if (p === '/api/state') {
      return send(res, 200, {
        settings,
        card: summary(),
        job: state.job,
        project: state.project,
        exportJob: exportView(),
        engine: { shotcutDir: SHOTCUT_DIR, ok: fs.existsSync(MELT) },
        rules: RULES,
        voice: voiceStatus(),
      });
    }
    if (p === '/api/progress') {
      return send(res, 200, {
        job: state.job,
        exportJob: exportView(),
        analysis: state.job && !state.job.finished ? state.analysis : undefined,
        voice: voiceStatus(),
      });
    }
    // 소스 불러오기: { dir, append } — append=true면 기존 목록에 추가
    if ((p === '/api/sources' || p === '/api/card') && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, loadSources([body.dir || settings.contentsDir], !!body.append));
    }
    if (p === '/api/analyze' && req.method === 'POST') {
      if (!state.lib) throw new Error('먼저 소스를 불러오세요.');
      if (state.job && !state.job.finished) throw new Error('이미 분석 중입니다.');
      const body = await readBody(req);
      // 기본: 아직 분석하지 않은 샷만 (force=true면 전체 다시)
      const ids = body.names?.length ? body.names : state.lib.shots.filter((s) => body.force || !state.analysis[s.id]?.done).map((s) => s.id);
      runAnalysis(ids);
      return send(res, 200, { started: ids.length });
    }
    if (p === '/api/arrange' && req.method === 'POST') return send(res, 200, await arrange(await readBody(req)));
    if (p === '/api/open-project' && req.method === 'POST') {
      if (!state.project) throw new Error('타임라인이 없습니다.');
      launchShotcut(state.project.path);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const shot = state.lib?.shot(body.name);
      if (!shot) throw new Error('샷이 없습니다.');
      const kind = state.analysis[shot.id]?.isSync ? 'sync' : 'sketch';
      const { mltPath } = await shotForTimeline(shot, kind, { noise: false });
      launchShotcut(mltPath);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/export' && req.method === 'POST') return send(res, 200, await startExport(await readBody(req)));
    if (p === '/api/export/cancel' && req.method === 'POST') {
      state.exportJob?.proc?.kill();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      for (const k of ['phrases', 'phrase', 'dateOn', 'outDir', 'hdrStrength', 'voiceAmount']) if (k in body) settings[k] = body[k];
      saveSettings(settings);
      return send(res, 200, settings);
    }
    if (p === '/api/reveal' && req.method === 'POST') {
      const body = await readBody(req);
      const target = body.path && fs.existsSync(body.path) ? body.path : settings.outDir;
      spawn('explorer.exe', [fs.statSync(target).isDirectory() ? target : `/select,${target}`], { detached: true }).unref();
      return send(res, 200, { ok: true });
    }
    // 음성 비교 듣기: /api/audio/<샷>?kind=orig|restored  (restored = CH1에 들어갈 복구 음성)
    const audio = p.match(/^\/api\/audio\/([A-Za-z0-9]+)$/);
    if (audio && state.lib) {
      const shot = state.lib.shot(audio[1]);
      if (!shot) return send(res, 404, { error: 'not found' });
      await prepareFileAudio(shot, shotDir(shot), FFMPEG);
      const a = state.analysis[shot.id];
      const chs = voiceChannelsFor(shot, a);
      let file;
      if (url.searchParams.get('kind') === 'restored') {
        if (!voice.available()) return send(res, 404, { error: 'DeepFilterNet 없음' });
        file = await voiceBus(shot, a, settings.voiceAmount, true);
      } else {
        file = await originalPreview(shot, chs[0] ?? 0);
      }
      if (!file) return send(res, 500, { error: '음성 준비 실패' });
      return sendFileRange(req, res, file, 'audio/wav');
    }
    const icon = p.match(/^\/api\/icon\/([A-Za-z0-9]+)$/);
    if (icon && state.lib) {
      const shot = state.lib.shot(icon[1]);
      const f = shot && (await thumbnail(shot));
      return sendFileRange(req, res, f, f?.toLowerCase().endsWith('.bmp') ? 'image/bmp' : 'image/jpeg');
    }
    const proxy = p.match(/^\/api\/proxy\/([A-Za-z0-9]+)$/);
    if (proxy && state.lib) return sendFileRange(req, res, state.lib.shot(proxy[1])?.proxy, 'video/mp4');
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.code === 'EXISTS' ? 409 : 400, { error: e.message, code: e.code, target: e.target });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`뉴스 원본 편집기: ${url}`);
  console.log(`엔진: ${SHOTCUT_DIR}`);
  if (!argv.includes('--no-open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (!argv.includes('--no-open')) spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}/`], { detached: true, stdio: 'ignore' }).unref();
    console.log('이미 실행 중입니다.');
    process.exit(0);
  }
  throw e;
});
