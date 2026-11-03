import { spawn } from 'node:child_process';
import { join } from 'node:path';

export async function startDesktopHelper({
  nodePath,
  appRoot,
  logDirectory,
  onExit = () => {},
  initialSession = null,
  onSessionChanged,
} = {}) {
  const environment = { ...process.env, PARTYBRIDGE_LOG_DIR: logDirectory };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_ENV;
  delete environment.NODE_TEST_CONTEXT;
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(nodePath, [join(appRoot, 'electron', 'helper.mjs')], {
    cwd: appRoot,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let stopping = false,
    settled = false;
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
      if (settled && !stopping) onExit({ code, signal });
    }),
  );
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('The background helper did not start in time.'));
    }, 25000);
    const fail = () => {
      clearTimeout(timeout);
      reject(new Error('The background helper could not start.'));
    };
    child.once('error', fail);
    child.once('exit', () => {
      if (!settled) fail();
    });
    child.on('message', (message) => {
      if (message?.type === 'initialize') {
        if (child.connected) child.send({ type: 'initialize', session: initialSession }, () => {});
        return;
      }
      if (message?.type === 'session-changed') {
        void (async () => {
          let ok = false;
          try {
            ok = (await onSessionChanged?.(message.session)) === true;
          } catch {}
          if (child.connected) child.send({ type: 'session-result', id: message.id, ok }, () => {});
        })();
        return;
      }
      if (settled) return;
      if (message?.type === 'ready') {
        let parsed;
        try {
          parsed = new URL(message.url);
        } catch {
          fail();
          child.kill();
          return;
        }
        if (
          parsed.protocol !== 'http:' ||
          parsed.hostname !== '127.0.0.1' ||
          !parsed.port ||
          parsed.pathname !== '/' ||
          parsed.username ||
          parsed.password
        ) {
          fail();
          child.kill();
          return;
        }
        if (!/^[a-f\d]{64}$/.test(message.sessionCookie ?? '')) {
          fail();
          child.kill();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({ url: parsed.origin, sessionCookie: message.sessionCookie });
      } else if (message?.type === 'failed') fail();
    });
  });
  return {
    ...ready,
    pid: child.pid,
    async stop() {
      if (stopping) return exited;
      stopping = true;
      if (child.connected) child.send({ type: 'shutdown' }, () => {});
      const deadline = setTimeout(() => child.kill(), 7000).unref();
      try {
        return await exited;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
