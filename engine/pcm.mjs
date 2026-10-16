// PCM 입출력: FFmpeg로 원본 채널·샘플레이트를 보존한 채 32비트 부동소수점으로 디코드/인코드
import fs from 'node:fs';
import { EngineError, requireTool, run } from './tools.mjs';

export async function decodePcm(file, { start = null, end = null, streamIndex = 0, signal } = {}) {
  const ffmpeg = requireTool('ffmpeg');
  const trim = start != null ? ['-ss', start.toFixed(6), '-to', end.toFixed(6)] : [];
  // 채널 수와 샘플레이트를 바꾸지 않는다(-ac/-ar 지정 없음)
  const probe = await run(requireTool('ffprobe'), ['-v', 'error', '-select_streams', `a:${streamIndex}`, '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', file]);
  const [sr, ch] = probe.stdout.trim().split(',').map(Number);
  if (!sr || !ch) throw new EngineError('NO_AUDIO', '음성 스트림을 찾을 수 없습니다.', 3);
  const r = await run(ffmpeg, ['-v', 'error', '-nostdin', ...trim, '-i', file, '-map', `0:a:${streamIndex}`, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { binary: true, signal });
  if (r.code !== 0) throw new EngineError('DECODE_FAILED', `음성 디코드 실패: ${r.stderr.slice(-300)}`, 5);
  const all = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length));
  const n = Math.floor(all.length / ch);
  const channels = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) channels[c][i] = all[i * ch + c];
  return { channels, sampleRate: sr };
}

export function writeRawF32(file, channels) {
  const ch = channels.length, n = channels[0].length;
  const inter = new Float32Array(n * ch);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) inter[i * ch + c] = channels[c][i];
  fs.writeFileSync(file, Buffer.from(inter.buffer));
}
