#!/usr/bin/env node
// News Restoration Studio — CLI (DEVELOPMENT_SPEC §5.3). GUI와 같은 engine을 호출한다. 네트워크를 쓰지 않는다.
//
//   node cli/restoration-cli.mjs inspect INPUT
//   node cli/restoration-cli.mjs new INPUT --project PROJECT.json [--name NAME]
//   node cli/restoration-cli.mjs validate PROJECT.json
//   node cli/restoration-cli.mjs render PROJECT.json --output OUTPUT [--report REPORT.json] [--overwrite] [--removed REMOVED.wav]
//   node cli/restoration-cli.mjs self-test
//
// 종료 코드: 0 성공, 2 입력/파라미터 오류, 3 코덱/색공간 미지원, 4 미디어 불일치, 5 렌더 실패, 130 취소
import { inspect } from '../engine/media_io.mjs';
import { addSource, createProject, loadProject, saveProject, validateProject } from '../engine/project_store.mjs';
import { renderProject } from '../engine/render.mjs';
import { selfTest } from '../engine/selftest.mjs';
import { EngineError } from '../engine/tools.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name) => {
  const i = argv.indexOf(name);
  return i > 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(name);
const out = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

async function main() {
  switch (cmd) {
    case 'inspect': {
      if (!argv[1]) throw new EngineError('USAGE', '사용법: inspect INPUT', 2);
      out(await inspect(argv[1]));
      return 0;
    }
    case 'new': {
      const project = opt('--project');
      if (!argv[1] || !project) throw new EngineError('USAGE', '사용법: new INPUT --project PROJECT.json', 2);
      const p = createProject(opt('--name') || 'project');
      const src = await addSource(p, argv[1]);
      out({ project: saveProject(p, project), source: { id: src.id, path: src.path, sha256: src.sha256 }, warnings: src.warnings });
      return 0;
    }
    case 'validate': {
      if (!argv[1]) throw new EngineError('USAGE', '사용법: validate PROJECT.json', 2);
      const r = await validateProject(loadProject(argv[1]), { deep: true });
      out(r);
      return r.ok ? 0 : 4;
    }
    case 'render': {
      const output = opt('--output');
      if (!argv[1] || !output) throw new EngineError('USAGE', '사용법: render PROJECT.json --output OUTPUT [--report REPORT.json]', 2);
      const ac = new AbortController();
      process.on('SIGINT', () => ac.abort());
      const report = await renderProject(loadProject(argv[1]), output, {
        reportPath: opt('--report'),
        overwrite: flag('--overwrite'),
        removedOutput: opt('--removed'),
        signal: ac.signal,
        onProgress: (f) => process.stderr.write(`\r진행 ${(f * 100).toFixed(0)}%`),
      });
      process.stderr.write('\n');
      out({ ok: true, output: report.output.path, sha256: report.output.sha256, sources_unchanged: report.sources.every((s) => s.unchanged), pipeline: report.pipeline, warnings: report.warnings });
      return 0;
    }
    case 'self-test': {
      const r = await selfTest();
      out(r);
      return r.ok ? 0 : 5;
    }
    default:
      process.stderr.write('명령: inspect | new | validate | render | self-test\n');
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const code = e instanceof EngineError ? e.exitCode : 5;
    process.stderr.write(`\n오류[${e.code || 'INTERNAL'}]: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code || 'INTERNAL', message: e.message } }) + '\n');
    process.exit(code);
  });
