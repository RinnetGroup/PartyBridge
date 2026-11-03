import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticLog } from '../server/diagnostic-log.js';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'partybridge-log-test-'));
  t.after(async () => {
    for (const name of await readdir(root)) await unlink(join(root, name));
    await rmdir(root);
  });
  return root;
}

test('diagnostic files are durable JSON lines and redact credentials, SDP, addresses and audio buffers', async (t) => {
  const root = await directory(t),
    log = new DiagnosticLog({ directory: root });
  const peer = '12345678-1234-1234-1234-123456789abc',
    secret = 'S'.repeat(64);
  log.write('test.health', {
    peer,
    accountId: '9223372036854775806',
    accessToken: 'secret-access',
    nested: { npsso: secret, password: 'secret-password' },
    sdp: 'v=0\na=ice-pwd:secret-ice',
    description: 'v=0\na=ice-pwd:secret-ice',
    address: '10.0.0.1',
    text: `Bearer secret-bearer access_token=secret-assignment ${secret} https://example.test?token=secret-url`,
    pcm: Buffer.alloc(640),
    arbitrary: Buffer.alloc(640),
  });
  log.write('test.health', { peer });
  await log.flush();
  const text = await readFile(log.file, 'utf8'),
    events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  for (const value of [
    peer,
    '9223372036854775806',
    secret,
    'secret-access',
    'secret-password',
    'secret-ice',
    'secret-bearer',
    'secret-assignment',
    'secret-url',
    '10.0.0.1',
  ])
    assert.ok(!text.includes(value), value);
  assert.equal(events.length, 2);
  assert.equal(events[0].detail.peer, events[1].detail.peer);
  assert.ok(events[1].seq > events[0].seq);
  assert.equal(events[0].detail.pcm, '[redacted]');
  assert.equal(events[0].detail.arbitrary, undefined);
  assert.equal(log.status().enabled, true);
});

test('file rotation retains recent events across logger instances without unbounded disk growth', async (t) => {
  const root = await directory(t),
    log = new DiagnosticLog({ directory: root, maxBytes: 380, maxFiles: 3 });
  for (let n = 0; n < 15; n++) {
    log.write('test.rotate', { n, state: 'connected' });
    await log.flush();
  }
  assert.ok((await readdir(root)).length <= 3);
  const next = new DiagnosticLog({ directory: root, maxBytes: 380, maxFiles: 3 });
  next.write('test.restart', { retained: true });
  await next.flush();
  const files = await readdir(root),
    contents = await Promise.all(files.map((name) => readFile(join(root, name), 'utf8')));
  assert.ok(files.length <= 3);
  assert.ok(contents.join('').includes('test.restart'));
  assert.ok(contents.join('').includes('"n":14'));
  assert.ok(!contents.join('').includes('"n":0,'));
});

test('cyclic or excessive diagnostics cannot block logging later events', async (t) => {
  const root = await directory(t),
    log = new DiagnosticLog({ directory: root });
  const cycle = {};
  cycle.self = cycle;
  log.write('test.cycle', cycle);
  log.write('test.follow-up', { okay: true });
  await log.flush();
  const contents = await readFile(log.file, 'utf8');
  assert.ok(contents.includes('depth limit'));
  assert.ok(contents.includes('test.follow-up'));
});
