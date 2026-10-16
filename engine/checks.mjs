// 자동 점검 항목 (DEVELOPMENT_SPEC §7.1 T-01~T-14). self-test와 node:test가 같은 코드를 쓴다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureLagSamples, processAudio } from './audio.mjs';
import { makeFixtures, SR } from './fixtures.mjs';
import { sha256File } from './hash.mjs';
import { inspect } from './media_io.mjs';
import { decodePcm } from './pcm.mjs';
import { addSource, createProject, loadProject, saveProject, validateProject } from './project_store.mjs';
import { renderProject } from './render.mjs';
import { auditRepository } from './safety.mjs';
import { EngineError, findTool } from './tools.mjs';

export async function makeContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrs-test-'));
  const fx = await makeFixtures(path.join(dir, 'fixtures'));
  return { dir, ...fx };
}
export const cleanupContext = (ctx) => fs.rmSync(ctx.dir, { recursive: true, force: true });

async function projectFor(ctx, file, mutate) {
  const p = createProject('test');
  await addSource(p, file);
  mutate?.(p);
  const pf = path.join(ctx.dir, `p_${Math.random().toString(36).slice(2)}.json`);
  saveProject(p, pf);
  return { p: loadProject(pf), pf };
}
const rms = (x, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};
const db = (v) => 20 * Math.log10(v + 1e-12);
const seg = (sec) => Math.round(sec * SR);
function enableAudio(p, params) {
  const f = p.clips[0].filters.find((x) => x.id === 'audio_restore');
  f.enabled = true;
  Object.assign(f.params, params);
}

export const CHECKS = [
  {
    id: 'M0-tools',
    name: 'ffmpeg/ffprobe 탐지',
    run: async () => {
      assert.ok(findTool('ffmpeg'), 'ffmpeg 없음');
      assert.ok(findTool('ffprobe'), 'ffprobe 없음');
      return { ffmpeg: findTool('ffmpeg') };
    },
  },
  {
    id: 'M0-inspect',
    name: '메타데이터 검사(분수 FPS·필드·색공간·오디오)',
    run: async (ctx) => {
      const v = await inspect(ctx.files.video);
      assert.equal(v.video[0].fps_num, 30000);
      assert.equal(v.video[0].fps_den, 1001);
      assert.equal(v.audio[0].sample_rate, 48000);
      const a = await inspect(ctx.files.stereo);
      assert.equal(a.audio[0].channels, 2);
      return { video_fps: `${v.video[0].fps_num}/${v.video[0].fps_den}`, field_order: v.video[0].field_order, warnings: v.warnings.map((w) => w.code) };
    },
  },
  {
    id: 'T-08',
    name: '프로젝트 저장·재열기 round-trip',
    run: async (ctx) => {
      const p = createProject('roundtrip');
      await addSource(p, ctx.files.noisy);
      enableAudio(p, { strength: 37, highpass_hz: 80, eq: [{ freq_hz: 3000, gain_db: 2, q: 1 }], bypass_ranges: [{ start_sec: 2, end_sec: 3 }] });
      p.masks.push({ id: 'm1', type: 'ellipse', keyframes: [{ frame: 0, cx: 0.5, cy: 0.4, rx: 0.1, ry: 0.15 }] });
      const pf = path.join(ctx.dir, 'rt.json');
      saveProject(p, pf);
      const q = loadProject(pf);
      assert.deepEqual(q.clips, p.clips);
      assert.deepEqual(q.masks, p.masks);
      assert.equal(q.sources[0].sha256, await sha256File(ctx.files.noisy));
      assert.notEqual(q.sources[0].sha256, '<actual hash at import>');
      return { sha256: q.sources[0].sha256.slice(0, 16) + '…' };
    },
  },
  {
    id: 'F-01-defaults',
    name: '모든 효과 기본 OFF',
    run: async (ctx) => {
      const p = createProject('d');
      await addSource(p, ctx.files.noisy);
      for (const f of p.clips[0].filters) assert.equal(f.enabled, false, `${f.id} 기본값이 켜져 있음`);
      assert.equal(p.clips[0].filters.find((f) => f.id === 'audio_restore').params.strength, 0);
      return { filters: p.clips[0].filters.map((f) => f.id) };
    },
  },
  {
    id: 'T-01',
    name: '효과 OFF 렌더 = 원본 신호 동일 + 원본 해시 불변',
    run: async (ctx) => {
      const { p, pf } = await projectFor(ctx, ctx.files.noisy);
      const before = await sha256File(ctx.files.noisy);
      const out = path.join(ctx.dir, 'bypass.wav');
      const rep = await renderProject(p, out);
      const a = await decodePcm(ctx.files.noisy), b = await decodePcm(out);
      assert.equal(a.channels[0].length, b.channels[0].length);
      let maxDiff = 0;
      for (let i = 0; i < a.channels[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.channels[0][i] - b.channels[0][i]));
      assert.equal(maxDiff, 0, `신호 차이 ${maxDiff}`);
      assert.equal(await sha256File(ctx.files.noisy), before);
      assert.ok(rep.sources[0].unchanged);
      // 효과를 켜도 강도 0·필터 없음이면 바이패스(0% = 원음과 동일)
      enableAudio(p, { strength: 0 });
      const out2 = path.join(ctx.dir, 'zero.wav');
      await renderProject(p, out2);
      const c = await decodePcm(out2);
      assert.deepEqual(Array.from(c.channels[0].subarray(0, 4800)), Array.from(a.channels[0].subarray(0, 4800)));
      return { max_sample_diff: maxDiff, pipeline: rep.pipeline, project: path.basename(pf) };
    },
  },
  {
    id: 'T-02',
    name: '무음 입력 → 새 신호 생성 없음',
    run: async (ctx) => {
      const { channels } = await decodePcm(ctx.files.silent);
      const r = processAudio(channels, SR, { strength: 100, highpass_hz: 80, notch_hz: 60, notch_harmonics: 3, wet: 100 });
      const peak = r.channels[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      assert.equal(peak, 0, `무음에서 신호 발생: ${peak}`);
      // 말 사이 쉼(원본 잡음만 있는 구간)에서도 출력이 입력보다 커지지 않는다
      const n = await decodePcm(ctx.files.noise);
      const rn = processAudio(n.channels, SR, { strength: 100 });
      assert.ok(rms(rn.channels[0]) <= rms(n.channels[0]) * 1.0001);
      return { silent_peak: peak, noise_only_out_db: db(rms(rn.channels[0])).toFixed(1), noise_only_in_db: db(rms(n.channels[0])).toFixed(1), max_gain: r.stats.max_gain ?? 'n/a' };
    },
  },
  {
    id: 'T-03',
    name: '지속 잡음 감소(설정값에 따라) + 음성 보존',
    run: async (ctx) => {
      const noisy = (await decodePcm(ctx.files.noisy)).channels[0];
      const clean = (await decodePcm(ctx.files.clean)).channels[0];
      const noise = (await decodePcm(ctx.files.noise)).channels[0];
      const sylls = ctx.syllables;
      const speechIdx = [], gapIdx = [];
      // 음절 안(음성)과 쉼(잡음만) 구간 표본
      for (const [a, b] of sylls) speechIdx.push([seg(a + 0.03), seg(b - 0.03)]);
      for (let i = 0; i < sylls.length - 1; i++) if (sylls[i + 1][0] - sylls[i][1] > 0.12) gapIdx.push([seg(sylls[i][1] + 0.03), seg(sylls[i + 1][0] - 0.03)]);
      const level = (x, ranges) => db(Math.sqrt(ranges.reduce((s, [a, b]) => s + rms(x, a, b) ** 2 * (b - a), 0) / ranges.reduce((s, [a, b]) => s + (b - a), 0)));
      const results = {};
      for (const strength of [30, 60, 100]) {
        for (const mode of ['profile', 'auto']) {
          const params = { strength, highpass_hz: 80, notch_hz: 60, notch_harmonics: 2, ...(mode === 'profile' ? { noise_profile: { start_sec: ctx.noiseOnly[0], end_sec: ctx.noiseOnly[1] } } : {}) };
          const y = processAudio([noisy], SR, params).channels[0];
          // 잔여 잡음 = 출력 − (같은 하이패스·노치를 거친) 깨끗한 음성. IIR 필터 자체의 음성 변화는 잡음으로 세지 않는다.
          const cref = processAudio([clean], SR, { ...params, strength: 0, noise_profile: null }).channels[0];
          const resid = Float32Array.from(y, (v, i) => v - cref[i]);
          results[`${mode}_${strength}`] = {
            gap_noise_db: level(y, gapIdx).toFixed(1),
            speech_level_db: level(y, speechIdx).toFixed(1),
            residual_vs_clean_db: db(rms(resid)).toFixed(1),
          };
        }
      }
      const inGap = level(noisy, gapIdx), inSpeech = level(noisy, speechIdx), cleanSpeech = level(clean, speechIdx);
      results.input = { gap_noise_db: inGap.toFixed(1), speech_level_db: inSpeech.toFixed(1), residual_vs_clean_db: db(rms(noise)).toFixed(1), clean_speech_db: cleanSpeech.toFixed(1) };
      // 강도가 높을수록 쉼 구간 잡음이 줄어야 한다
      const g = (k) => Number(results[k].gap_noise_db);
      assert.ok(g('profile_30') < inGap - 3, '강도 30에서 잡음 감소 부족');
      assert.ok(g('profile_60') < g('profile_30'), '강도 60이 30보다 더 줄여야 함');
      assert.ok(g('profile_100') < g('profile_60'), '강도 100이 60보다 더 줄여야 함');
      assert.ok(g('auto_100') < inGap - 6, '자동 추정 모드 잡음 감소 부족');
      // 음성 레벨은 크게 깎이지 않아야 한다(3dB 이내)
      assert.ok(Number(results.profile_100.speech_level_db) > cleanSpeech - 3, '음성이 과도하게 감쇠됨');
      // 깨끗한 음성에 더 가까워져야 한다
      assert.ok(Number(results.profile_60.residual_vs_clean_db) < db(rms(noise)) - 6, '원음 근접도 개선 부족(6dB 미만)');
      return results;
    },
  },
  {
    id: 'T-03b',
    name: '원음 혼합(wet/dry)·구간 바이패스·제거 성분',
    run: async (ctx) => {
      const x = (await decodePcm(ctx.files.noisy)).channels[0];
      const full = processAudio([x], SR, { strength: 80, wet: 100 }).channels[0];
      const half = processAudio([x], SR, { strength: 80, wet: 50 }).channels[0];
      for (let i = 10000; i < 10010; i++) assert.ok(Math.abs(half[i] - (0.5 * full[i] + 0.5 * x[i])) < 1e-5, 'wet 50% 혼합 불일치');
      const bp = processAudio([x], SR, { strength: 80, bypass_ranges: [{ start_sec: 4, end_sec: 5 }] }).channels[0];
      for (let i = seg(4.1); i < seg(4.9); i += 997) assert.equal(bp[i], x[i], '바이패스 구간이 원음과 다름');
      return { wet50_ok: true, bypass_ok: true };
    },
  },
  {
    id: 'T-04',
    name: '립싱크: 처리 결과 지연 0 샘플 + 영상 결합',
    run: async (ctx) => {
      const x = (await decodePcm(ctx.files.noisy)).channels[0];
      const y = processAudio([x], SR, { strength: 70, highpass_hz: 100, notch_hz: 60, notch_harmonics: 2, eq: [{ freq_hz: 2500, gain_db: 3, q: 1 }] }).channels[0];
      const lag = measureLagSamples(x, y, 960);
      assert.ok(Math.abs(lag) <= 48, `지연 ${lag} 샘플`); // 1ms 이내(1프레임 = 1601샘플)
      // 영상과 결합 렌더: 영상 스트림 복사, 프레임 수·길이 유지
      const { p } = await projectFor(ctx, ctx.files.video, (pp) => enableAudio(pp, { strength: 60, highpass_hz: 80 }));
      const out = path.join(ctx.dir, 'restored.mov');
      const rep = await renderProject(p, out);
      const vi = await inspect(ctx.files.video), vo = await inspect(out);
      assert.equal(vo.video[0].codec, vi.video[0].codec);
      assert.ok(Math.abs(vo.duration - vi.duration) < 0.05, `길이 차 ${vo.duration - vi.duration}`);
      const ya = (await decodePcm(out)).channels[0];
      const xa = (await decodePcm(ctx.files.video)).channels[0];
      const lag2 = measureLagSamples(xa, ya, 1601);
      assert.ok(Math.abs(lag2) <= 1601, `영상 결합 후 지연 ${lag2} 샘플`);
      return { dsp_lag_samples: lag, muxed_lag_samples: lag2, frame_samples: 1601, pipeline: rep.pipeline };
    },
  },
  {
    id: 'T-07',
    name: '영상 프레임 수·순서 유지',
    run: async (ctx) => {
      const { p } = await projectFor(ctx, ctx.files.video, (pp) => enableAudio(pp, { strength: 50 }));
      const out = path.join(ctx.dir, 'frames.mov');
      await renderProject(p, out);
      const count = async (f) => {
        const r = await import('./tools.mjs').then((m) => m.run(m.requireTool('ffprobe'), ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f]));
        return parseInt(r.stdout.trim(), 10);
      };
      const a = await count(ctx.files.video), b = await count(out);
      assert.ok(Number.isInteger(a) && a > 0, `프레임 수를 읽지 못함: ${a}`);
      assert.equal(b, a);
      // 영상 패킷이 바이트 단위로 같은지(스트림 복사)
      const h = async (f) => (await import('./tools.mjs').then((m) => m.run(m.requireTool('ffmpeg'), ['-v', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']))).stdout.trim();
      assert.equal(await h(out), await h(ctx.files.video));
      return { frames: a };
    },
  },
  {
    id: 'T-09',
    name: '렌더 취소 → 부분 파일 없음',
    run: async (ctx) => {
      const { p } = await projectFor(ctx, ctx.files.noisy, (pp) => enableAudio(pp, { strength: 50 }));
      const out = path.join(ctx.dir, 'cancel.wav');
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(renderProject(p, out, { signal: ac.signal }), (e) => e.code === 'CANCELLED' || e.name === 'AbortError');
      assert.ok(!fs.existsSync(out), '취소했는데 출력 파일이 있음');
      const leftovers = fs.readdirSync(ctx.dir).filter((f) => f.includes('.part'));
      assert.equal(leftovers.length, 0, `임시 파일 남음: ${leftovers}`);
      return { output_exists: false };
    },
  },
  {
    id: 'T-11',
    name: '출력=원본 거부, 원본 변경 감지',
    run: async (ctx) => {
      const copy = path.join(ctx.dir, 'mutable.wav');
      fs.copyFileSync(ctx.files.noisy, copy);
      const { p } = await projectFor(ctx, copy);
      await assert.rejects(renderProject(p, copy, { overwrite: true }), (e) => e.code === 'OUTPUT_IS_SOURCE');
      fs.appendFileSync(copy, Buffer.from([0]));
      const v = await validateProject(p);
      assert.equal(v.ok, false);
      await assert.rejects(renderProject(p, path.join(ctx.dir, 'x.wav')), (e) => e.code === 'MEDIA_MISMATCH' && e.exitCode === 4);
      return { refused_same_path: true, detected_change: v.issues.map((i) => i.code) };
    },
  },
  {
    id: 'T-14',
    name: '지원하지 않는 입력 → 명시적 오류(종료 코드 3)',
    run: async (ctx) => {
      await assert.rejects(inspect(ctx.files.garbage), (e) => e instanceof EngineError && e.exitCode === 3);
      const p = createProject('x');
      await assert.rejects(addSource(p, ctx.files.garbage), (e) => e.exitCode === 3);
      return { rejected: true };
    },
  },
  {
    id: 'T-12/T-13',
    name: '네트워크·생성형 코드 정적 감사',
    run: async () => {
      const r = auditRepository();
      assert.ok(r.ok, JSON.stringify(r.findings, null, 1));
      return { findings: r.findings.length };
    },
  },
];
