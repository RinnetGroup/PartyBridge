import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopHelper } from '../electron/helper-process.mjs';
import { isLocalPage, isSonyUrl, externalWebUrl } from '../electron/policy.mjs';
import { updateVoiceMeter } from '../public/ui-elements.js';

test('desktop only loads its exact local UI pages and validates external/Sony URLs', () => {
  const origin = 'http://127.0.0.1:12345';
  for (const path of ['/', '/screen-capture.html', '/volume.html'])
    assert.equal(isLocalPage(origin + path, origin), true);
  for (const value of [
    'http://127.0.0.1:12346/',
    'http://localhost:12345/',
    'file:///C:/secret',
    'javascript:alert(1)',
    origin + '/api/diagnostics',
    origin.replace('127.0.0.1', 'attacker.test'),
  ])
    assert.equal(isLocalPage(value, origin), false);
  assert.equal(isSonyUrl('https://ca.account.sony.com/api/v1/ssocookie'), true);
  for (const url of [
    'https://sony.com.attacker.test',
    'https://sony.com@attacker.test',
    'http://sony.com',
    'file:///x',
    'javascript:alert(1)',
  ])
    assert.equal(isSonyUrl(url), false);
  assert.equal(externalWebUrl('https://store.playstation.com/'), 'https://store.playstation.com/');
  for (const url of [
    'file:///x',
    'javascript:alert(1)',
    'http://localhost',
    'https://secret@sony.com',
  ])
    assert.equal(externalWebUrl(url), null);
});

test('the Pin UI waveform follows measured microphone RMS and returns to idle without simulated speech', () => {
  const bars = Array.from({ length: 15 }, () => ({ style: {} })),
    host = { querySelectorAll: () => bars };
  updateVoiceMeter(host, 0);
  assert.ok(bars.every((bar) => bar.style.height === '3.5px'));
  updateVoiceMeter(host, 0.08);
  assert.ok(parseFloat(bars[7].style.height) > parseFloat(bars[0].style.height));
  updateVoiceMeter(host, NaN);
  assert.ok(bars.every((bar) => bar.style.height === '3.5px'));
});

test('desktop starts a hidden private helper, serves the redesigned UI, and cleans up its listener on quit', async () => {
  const logDirectory = await mkdtemp(join(tmpdir(), 'partybridge-desktop-test-'));
  let helper;
  try {
    helper = await startDesktopHelper({
      nodePath: process.execPath,
      appRoot: fileURLToPath(new URL('../', import.meta.url)),
      logDirectory,
    });
    const health = await fetch(helper.url + '/api/health').then((r) => r.json());
    assert.equal(health.ok, true);
    assert.notEqual(new URL(helper.url).port, '4317');
    const html = await fetch(helper.url).then((r) => r.text());
    assert.match(html, /<h1>Parties<\/h1>/);
    assert.match(html, /pinui\/liquid-voice.css/);
    for (const path of [
      '/desktop-ui.css',
      '/desktop-ui.js',
      '/ui-elements.js',
      '/pinui/liquid-voice.css',
      '/pinui/selection-list.css',
    ])
      assert.equal((await fetch(helper.url + path)).status, 200);
    const result = await helper.stop();
    assert.equal(result.code, 0);
    await assert.rejects(fetch(helper.url + '/api/health', { signal: AbortSignal.timeout(2000) }));
    const notice = await readFile(new URL('../THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8');
    assert.match(notice, /Pin UI/);
  } finally {
    await helper?.stop();
    const remainder = relative(resolve(tmpdir()), resolve(logDirectory));
    if (
      !remainder.startsWith('..') &&
      !isAbsolute(remainder) &&
      remainder.startsWith('partybridge-desktop-test-')
    )
      await rm(logDirectory, { recursive: true, force: true });
  }
});
