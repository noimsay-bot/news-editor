// 외부 도구 탐지와 안전한 실행 (shell 문자열 결합 없이 인수 배열로만 실행 — DEVELOPMENT_SPEC §10)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

function candidates(name) {
  const list = [];
  const envKey = `NRS_${name.toUpperCase()}`; // 사용자가 직접 지정: NRS_FFMPEG, NRS_FFPROBE
  if (process.env[envKey]) list.push(process.env[envKey]);
  if (process.platform === 'win32') {
    list.push(path.join('C:/Program Files/Shotcut', exe(name)));
    list.push(path.join(os.homedir(), 'AppData/Local/Programs/Shotcut', exe(name)));
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) list.push(path.join(dir, exe(name)));
  return list;
}

export function findTool(name) {
  for (const c of candidates(name)) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

export class EngineError extends Error {
  // code: 기계용 코드, exitCode: CLI 종료 코드(§5.3)
  constructor(code, message, exitCode = 2, detail = undefined) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export function requireTool(name) {
  const p = findTool(name);
  if (!p) throw new EngineError('TOOL_MISSING', `${name}를 찾지 못했습니다. Shotcut을 설치하거나 NRS_${name.toUpperCase()} 환경 변수로 경로를 지정하세요.`, 3);
  return p;
}

// 인수 배열로 실행. stdout은 Buffer 또는 문자열, stderr는 문자열(최근 64KB)
export function run(file, args, { timeoutMs = 0, binary = false, signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-65536);
      onStderr?.(String(d));
    });
    const timer = timeoutMs ? setTimeout(() => p.kill(), timeoutMs) : null;
    p.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      const buf = Buffer.concat(out);
      resolve({ code, signal: sig, stdout: binary ? buf : buf.toString('utf8'), stderr: err });
    });
  });
}
