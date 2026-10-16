// node --test tests/ — 엔진 자동 테스트 (DEVELOPMENT_SPEC §7.1)
import { after, before, test } from 'node:test';
import { CHECKS, cleanupContext, makeContext } from '../engine/checks.mjs';

let ctx;
before(async () => {
  ctx = await makeContext();
});
after(() => cleanupContext(ctx));

for (const c of CHECKS) {
  test(`${c.id} ${c.name}`, async (t) => {
    const detail = await c.run(ctx);
    t.diagnostic(JSON.stringify(detail));
  });
}
