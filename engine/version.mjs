import { findTool, run } from './tools.mjs';

export const ENGINE_VERSION = '0.1.0';

let cached;
export async function ffmpegVersion() {
  if (cached !== undefined) return cached;
  const f = findTool('ffmpeg');
  if (!f) return (cached = null);
  const r = await run(f, ['-hide_banner', '-version'], { timeoutMs: 20000 });
  return (cached = r.stdout.split('\n')[0].trim());
}
