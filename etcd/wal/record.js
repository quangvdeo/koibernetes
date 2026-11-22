import { crc32c } from './crc32c.js';

export const LOG_NAME = 'wal.log';
export const BROKEN_NAME = 'wal.log.broken';
// [length uint32 LE][type uint8][payload][crc uint32 LE]
export const OVERHEAD = 9;

export class CorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptError';
  }
}

export class TornTailError extends Error {
  constructor(message = 'wal: torn tail, run repair') {
    super(message);
    this.name = 'TornTailError';
  }
}

/** CRC covers the type byte then the payload. */
export function recordCrc(type, payload) {
  return crc32c(payload, crc32c(Buffer.from([type])));
}

/**
 * @param {number} type 0..255
 * @param {Uint8Array} payload
 * @returns {Buffer}
 */
export function encode(type, payload) {
  const b = Buffer.alloc(OVERHEAD + payload.length);
  b.writeUInt32LE(payload.length, 0);
  b[4] = type;
  b.set(payload, 5);
  b.writeUInt32LE(recordCrc(type, payload), 5 + payload.length);
  return b;
}
