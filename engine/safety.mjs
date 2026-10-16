// 안전 감사 (DEVELOPMENT_SPEC T-12 네트워크 금지, T-13 생성형 금지, §6 금지 리스트 검사)
// 저장소 소스를 정적으로 검사한다. 검사 대상 문자열은 이 파일 안에서 조합해 자기 자신이 걸리지 않게 한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const j = (...p) => p.join('');

// 엔진(engine/, cli/)은 어떤 네트워크 모듈도 쓰면 안 된다.
const NETWORK_PATTERNS = [
  new RegExp(j("from ['\"]node:(", 'http|https|net|dgram|tls', ")['\"]")),
  new RegExp(j("require\\(['\"](node:)?(", 'http|https|net|dgram|tls', ")['\"]\\)")),
  new RegExp(j('\\bfe', 'tch\\s*\\(')),
  new RegExp(j('\\bWeb', 'Socket\\b')),
  new RegExp(j('XMLHttp', 'Request')),
];

// 생성형 모델·서비스·모드 (전체 저장소의 실행 코드)
const GENERATIVE_PATTERNS = [
  ['text-to-speech', new RegExp(j('text[-_ ]?to[-_ ]?spee', 'ch'), 'i')],
  ['TTS', new RegExp(j('\\b(tts|pyt', 'tsx|coqui)\\b'), 'i')],
  ['voice clone', new RegExp(j('voice[-_ ]?clon', 'e'), 'i')],
  ['diffusion', new RegExp(j('(stable[-_ ]?)?diff', 'usion'), 'i')],
  ['inpainting', new RegExp(j('(in|out)pain', 'ting'), 'i')],
  ['face restoration', new RegExp(j('(gfp', 'gan|code', 'former)'), 'i')],
  ['generative upscale', new RegExp(j('real[-_ ]?es', 'rgan'), 'i')],
  ['frame interpolation', new RegExp(j('\\b(ri', 'fe|fi', 'lm)\\b|frame[-_ ]?interpol'), 'i')],
  ['cloud AI API', new RegExp(j('(api\\.open', 'ai\\.com|eleven', 'labs|replic', 'ate\\.com|generativelanguage)'), 'i')],
];

const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.py', '.html', '.cpp', '.h', '.ps1']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'shotcut', 'p2-render', 'p2-test', 'test-media', 'research', 'docs']);

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* files(path.join(dir, e.name));
    } else if (CODE_EXT.has(path.extname(e.name))) yield path.join(dir, e.name);
  }
}

export function auditRepository(root = ROOT) {
  const findings = [];
  const self = fileURLToPath(import.meta.url);
  for (const f of files(root)) {
    if (path.resolve(f) === path.resolve(self)) continue;
    const rel = path.relative(root, f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split(/\r?\n/);
    const isEngine = rel.startsWith('engine/') || rel.startsWith('cli/');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|#|\*)/.test(line)) return; // 주석(금지 사실을 설명하는 문장)은 제외
      if (isEngine) for (const re of NETWORK_PATTERNS) if (re.test(line)) findings.push({ rule: 'T-12 network', file: rel, line: i + 1, text: line.trim().slice(0, 120) });
      for (const [name, re] of GENERATIVE_PATTERNS) if (re.test(line)) findings.push({ rule: `T-13 generative: ${name}`, file: rel, line: i + 1, text: line.trim().slice(0, 120) });
    });
  }
  return { ok: findings.length === 0, findings };
}
