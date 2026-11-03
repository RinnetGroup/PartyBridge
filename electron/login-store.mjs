import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { savedLogin } from '../server/saved-login.js';

export class LoginStore {
  constructor({ file, encryption }) {
    this.file = file;
    this.encryption = encryption;
    this.pending = Promise.resolve();
  }
  save(value) {
    const operation = this.pending.then(async () => {
      if (value === null) {
        await rm(this.file, { force: true });
        return true;
      }
      const data = savedLogin(value);
      if (!data) throw new Error('Invalid saved login');
      if (!(await this.encryption.isAsyncEncryptionAvailable()))
        throw new Error('Credential encryption unavailable');
      const encrypted = await this.encryption.encryptStringAsync(JSON.stringify(data));
      if (!Buffer.isBuffer(encrypted) || encrypted.length > 65536)
        throw new Error('Invalid encrypted login');
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      return true;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async load() {
    await this.pending;
    try {
      if (!(await this.encryption.isAsyncEncryptionAvailable())) return null;
      const encrypted = await readFile(this.file);
      if (encrypted.length > 65536) return null;
      const decrypted = await this.encryption.decryptStringAsync(encrypted);
      const data = savedLogin(JSON.parse(decrypted.result));
      if (data && decrypted.shouldReEncrypt) await this.save(data).catch(() => {});
      return data;
    } catch {
      return null;
    }
  }
  flush() {
    return this.pending;
  }
}
