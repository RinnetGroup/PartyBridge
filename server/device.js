import { randomBytes } from 'node:crypto';

// PS App 26.10.0: GenericDuidGenerator (Eb/c.java), ByteUtils (Ob/c.java).
// Reproduce the public mobile identifier layout with our own random ID and
// product labels. No Android device, hardware fingerprint, or captured ID is used.
export function createMobileDeviceId() {
  const instance = randomBytes(8).toString('hex').padStart(30, '0');
  const label = (value) => value.padStart(10, ' ').slice(0, 10);
  const description = Buffer.from(`:${label('PartyBrdg')}:${label('Local PC')}`, 'ascii');
  const suffix = Buffer.concat([description, Buffer.alloc(16)]).toString('hex');
  return `00000007000801a8${instance}${suffix}`;
}
