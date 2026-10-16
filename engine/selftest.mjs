// restoration-cli self-test: 합성 fixture로 모든 자동 점검을 실행하고 결과를 JSON으로 돌려준다.
import { CHECKS, cleanupContext, makeContext } from './checks.mjs';
import { ENGINE_VERSION, ffmpegVersion } from './version.mjs';

export async function selfTest({ only } = {}) {
  const started = Date.now();
  const ctx = await makeContext();
  const results = [];
  try {
    for (const c of CHECKS) {
      if (only && !only.includes(c.id)) continue;
      const t = Date.now();
      try {
        const detail = await c.run(ctx);
        results.push({ id: c.id, name: c.name, ok: true, ms: Date.now() - t, detail });
      } catch (e) {
        results.push({ id: c.id, name: c.name, ok: false, ms: Date.now() - t, error: e.message });
      }
    }
  } finally {
    cleanupContext(ctx);
  }
  return {
    ok: results.every((r) => r.ok),
    engine_version: ENGINE_VERSION,
    ffmpeg: await ffmpegVersion(),
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    seconds: (Date.now() - started) / 1000,
    results,
  };
}
