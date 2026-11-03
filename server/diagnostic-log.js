import { mkdirSync, appendFileSync } from 'node:fs';
import { appendFile, readdir, unlink } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRECTORY =
  process.env.PARTYBRIDGE_LOG_DIR || fileURLToPath(new URL('../logs/', import.meta.url));
const SHARED = Symbol.for('partybridge.diagnostic-log');

export class DiagnosticLog {
  constructor({ directory = DEFAULT_DIRECTORY, maxBytes = 10 * 1024 * 1024, maxFiles = 10 } = {}) {
    Object.assign(this, { directory, maxBytes, maxFiles });
    this.key = randomBytes(32);
    this.run = `${new Date().toISOString().replace(/[^0-9TZ]/g, '')}-${process.pid}-${randomBytes(3).toString('hex')}`;
    this.origin = performance.now();
    this.sequence = 0;
    this.part = 0;
    this.size = 0;
    this.queue = [];
    this.dropped = 0;
    this.error = null;
    try {
      mkdirSync(directory, { recursive: true });
    } catch {
      this.error = 'LOG_DIRECTORY_UNAVAILABLE';
    }
  }
  get file() {
    return join(
      this.directory,
      `partybridge-${this.run}-${String(this.part).padStart(5, '0')}.jsonl`,
    );
  }
  tag(value) {
    return `[id:${createHmac('sha256', this.key).update(String(value)).digest('hex').slice(0, 12)}]`;
  }
  sanitize(value, key = '', depth = 0) {
    if (
      /token|authorization|cookie|csrf|secret|npsso|password|icepwd|fingerprint|sdp|candidate|credential|payload|pcm|email/i.test(
        key,
      )
    )
      return '[redacted]';
    if (depth > 8) return '[depth limit]';
    if (
      typeof value === 'string' &&
      /(?:^|\n)(?:v=0|a=ice-pwd:|a=candidate:|a=fingerprint:)/.test(value)
    )
      return '[redacted SDP]';
    if (typeof value === 'string')
      return value
        .replace(/Bearer\s+\S+/gi, '[redacted]')
        .replace(
          /\b(?:access[_-]?token|refresh[_-]?token|npsso|csrf|password|ice-pwd)\b["']?\s*[:=]\s*["']?[^"'\s,}]+/gi,
          '[redacted]',
        )
        .replace(/(?:https?|wss?):\/\/[^\s"']+/gi, '[url]')
        .replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]+)?\b/g, '[redacted]')
        .replace(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/gi, (match) => this.tag(match))
        .replace(/\b(?:\d{16,}|[A-Za-z0-9_+\/-]{64,})\b/g, (match) => this.tag(match))
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (match) => this.tag(match))
        .slice(0, 1200);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value))
      return value.slice(0, 64).map((item) => this.sanitize(item, key, depth + 1));
    if (
      value &&
      typeof value === 'object' &&
      !Buffer.isBuffer(value) &&
      !ArrayBuffer.isView(value) &&
      !(value instanceof ArrayBuffer)
    ) {
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 64)
          .map(([field, item]) => [field.slice(0, 80), this.sanitize(item, field, depth + 1)]),
      );
    }
    return undefined;
  }
  line(event, detail) {
    return (
      JSON.stringify({
        time: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - this.origin),
        seq: ++this.sequence,
        run: this.run,
        event,
        detail: this.sanitize(detail),
      }) + '\n'
    );
  }
  write(event, detail = {}) {
    if (this.error) return;
    if (this.queue.length >= 2048) {
      this.dropped++;
      return;
    }
    this.queue.push(this.line(event, detail));
    this.kick();
  }
  kick() {
    if (this.draining || this.error) return;
    this.draining = this.drain()
      .catch(() => {
        this.error = 'LOG_WRITE_FAILED';
        this.queue.length = 0;
        console.warn(
          '[diagnostics] Log writing failed; check the logs folder and free disk space.',
        );
      })
      .finally(() => {
        this.draining = null;
        if (this.queue.length && !this.error) this.kick();
      });
  }
  async drain() {
    while (this.queue.length) {
      const data = this.queue.splice(0, 64).join('');
      if (this.size && this.size + Buffer.byteLength(data) > this.maxBytes) {
        this.part++;
        this.size = 0;
      }
      const fresh = this.size === 0;
      await appendFile(this.file, data, 'utf8');
      this.size += Buffer.byteLength(data);
      if (fresh) {
        const files = (await readdir(this.directory))
          .filter((name) => /^partybridge-[0-9TZ]+-\d+-[a-f0-9]+-\d+\.jsonl$/.test(name))
          .sort();
        await Promise.all(
          files
            .slice(0, Math.max(0, files.length - this.maxFiles))
            .map((name) => unlink(join(this.directory, name))),
        );
      }
    }
  }
  writeSync(event, detail = {}) {
    try {
      appendFileSync(this.file, this.line(event, detail), 'utf8');
    } catch {}
  }
  async flush() {
    while (this.draining || this.queue.length) {
      if (this.error) break;
      this.kick();
      await this.draining;
    }
  }
  status() {
    return {
      enabled: !this.error,
      directory: this.directory,
      currentFile: this.file,
      queued: this.queue.length,
      dropped: this.dropped,
      error: this.error,
    };
  }
}

export function getDiagnosticLog() {
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return null;
  if (!globalThis[SHARED]) {
    const log = (globalThis[SHARED] = new DiagnosticLog());
    log.write('process.logging-enabled', {
      pid: process.pid,
      node: process.version,
      uptime: process.uptime(),
    });
    process.on('uncaughtExceptionMonitor', (error, origin) =>
      log.writeSync('process.uncaught', {
        origin,
        name: error.name,
        code: error.code,
        message: error.message,
        stack: error.stack?.split('\n').slice(1, 10),
      }),
    );
    process.on('warning', (warning) =>
      log.write('process.warning', {
        name: warning.name,
        code: warning.code,
        message: warning.message,
      }),
    );
    process.on('exit', (code) => log.writeSync('process.exit', { code }));
  }
  return globalThis[SHARED];
}
