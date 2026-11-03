import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBootstrap } from '../public/session.js';
test('main UI and volume controls share one first-visit cookie/CSRF bootstrap', async () => {
  let count = 0,
    resolve;
  const bootstrap = createSessionBootstrap(() => {
    count++;
    return new Promise((r) => (resolve = r));
  });
  const main = bootstrap(),
    volume = bootstrap();
  assert.equal(main, volume);
  assert.equal(count, 1);
  resolve({ ok: true, json: async () => ({ csrf: 'same-session' }) });
  assert.deepEqual(await Promise.all([main, volume]), [
    { csrf: 'same-session' },
    { csrf: 'same-session' },
  ]);
});
test('a failed bootstrap can be retried without reusing the rejected promise', async () => {
  let count = 0;
  const bootstrap = createSessionBootstrap(async () => ({
    ok: ++count > 1,
    json: async () => ({ csrf: 'recovered' }),
  }));
  await assert.rejects(bootstrap());
  assert.deepEqual(await bootstrap(), { csrf: 'recovered' });
  assert.equal(count, 2);
});
