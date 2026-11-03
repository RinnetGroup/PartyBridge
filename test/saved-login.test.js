import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LoginStore } from '../electron/login-store.mjs';
import { savedLogin, exportLogin, restoreLogin } from '../server/saved-login.js';
import { PsnClient } from '../server/psn.js';
import { createMobileDeviceId } from '../server/device.js';
import { startDesktopHelper } from '../electron/helper-process.mjs';
const sample = () => ({
  version: 1,
  accountId: '88',
  onlineId: 'FixturePlayer',
  deviceId: createMobileDeviceId(),
  refreshToken: 'fixture-refresh',
});
const encryption = () => {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv),
        data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptStringAsync: async (data) => {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return {
        result: Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'),
        shouldReEncrypt: false,
      };
    },
  };
};
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'partybridge-login-test-'));
  try {
    await fn(directory);
  } finally {
    const path = relative(resolve(tmpdir()), resolve(directory));
    if (!isAbsolute(path) && !path.startsWith('..') && path.startsWith('partybridge-login-test-'))
      await rm(directory, { recursive: true, force: true });
  }
}

test('saved login exports only a refresh credential and stable device/profile identity', () => {
  const input = sample(),
    client = {
      tokens: { refresh: input.refreshToken, access: 'must-not-be-saved' },
      deviceId: input.deviceId,
      accountId: input.accountId,
      profile: { onlineId: input.onlineId, email: 'private' },
    };
  assert.deepEqual(exportLogin(client), input);
  assert.equal(JSON.stringify(exportLogin(client)).includes('must-not-be-saved'), false);
  for (const invalid of [
    { ...input, refreshToken: '' },
    { ...input, deviceId: 'bad' },
    { ...input, accountId: 'bad' },
    { ...input, version: 2 },
  ])
    assert.equal(savedLogin(invalid), null);
});

test('encrypted login survives a new store instance, rotates and is removed on sign-out', async () =>
  temporary(async (directory) => {
    const file = join(directory, 'session.dat'),
      crypto = encryption(),
      data = sample(),
      store = new LoginStore({ file, encryption: crypto });
    await store.save(data);
    const disk = await readFile(file);
    assert.equal(disk.includes(Buffer.from(data.refreshToken)), false);
    assert.deepEqual(await new LoginStore({ file, encryption: crypto }).load(), data);
    await Promise.all([store.save({ ...data, refreshToken: 'rotated-refresh' }), store.save(null)]);
    assert.equal(await store.load(), null);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }));

test('credential storage never falls back to plaintext; corrupt data and unavailable encryption stay unsigned-in', async () =>
  temporary(async (directory) => {
    const file = join(directory, 'session.dat'),
      store = new LoginStore({
        file,
        encryption: { isAsyncEncryptionAvailable: async () => false },
      });
    await assert.rejects(store.save(sample()), /encryption unavailable/);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    await writeFile(file, 'corrupt');
    assert.equal(await new LoginStore({ file, encryption: encryption() }).load(), null);
    assert.equal(await store.load(), null);
  }));

test('restored login refreshes once, persists rotation and never rejoins an old party', async () => {
  let refreshes = 0,
    saves = 0;
  const data = sample();
  const client = new PsnClient({
    fetchImpl: async () => {
      refreshes++;
      return new Response(
        JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated', expires_in: 3600 }),
      );
    },
    onSessionChanged: (c) => {
      saves++;
      assert.equal(exportLogin(c).refreshToken, 'rotated');
      return true;
    },
  });
  assert.equal(restoreLogin(client, data), true);
  assert.equal(client.active, null);
  assert.equal(client.deviceId, data.deviceId);
  await Promise.all([client.accessToken(), client.accessToken()]);
  assert.equal(refreshes, 1);
  assert.equal(saves, 1);
  assert.equal(client.loginSaved, true);
  client.clear();
});

test('network failures retain saved credentials; rejected refresh credentials clear them', async () => {
  for (const status of [502, 401, 400]) {
    let cleared = 0;
    const client = new PsnClient({
      fetchImpl: async () => new Response('{}', { status }),
      onSessionExpired: () => {
        cleared++;
      },
    });
    restoreLogin(client, sample());
    await assert.rejects(client.accessToken());
    assert.equal(cleared, status === 502 ? 0 : 1);
    assert.equal(!!client.tokens, status === 502);
    client.clear();
  }
});

test('desktop restores only its private session, forgets it on explicit logout, and keeps it when quitting', async () =>
  temporary(async (directory) => {
    const updates = [],
      data = sample(),
      root = fileURLToPath(new URL('../', import.meta.url));
    let helper;
    try {
      helper = await startDesktopHelper({
        nodePath: process.execPath,
        appRoot: root,
        logDirectory: directory,
        initialSession: data,
        onSessionChanged: (value) => {
          updates.push(value);
          return true;
        },
      });
      const headers = { Cookie: 'partybridge=' + helper.sessionCookie };
      const bootstrap = await (await fetch(helper.url + '/api/bootstrap', { headers })).json();
      assert.equal(bootstrap.connected, true);
      assert.equal(bootstrap.profile.onlineId, data.onlineId);
      const other = await (await fetch(helper.url + '/api/bootstrap')).json();
      assert.equal(other.connected, false);
      headers['X-PartyBridge-CSRF'] = bootstrap.csrf;
      headers['Content-Type'] = 'application/json';
      const signedOut = await fetch(helper.url + '/api/disconnect', {
        method: 'POST',
        headers,
        body: '{}',
      });
      assert.equal(signedOut.status, 200);
      assert.deepEqual(updates, [null]);
      await helper.stop();
      assert.equal(updates.length, 1);
      updates.length = 0;
      helper = await startDesktopHelper({
        nodePath: process.execPath,
        appRoot: root,
        logDirectory: directory,
        initialSession: data,
        onSessionChanged: (value) => {
          updates.push(value);
          return true;
        },
      });
      await helper.stop();
      assert.deepEqual(updates, []);
    } finally {
      await helper?.stop();
    }
  }));
