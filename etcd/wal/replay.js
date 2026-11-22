import realFs from 'node:fs';
import path from 'node:path';
import { CorruptError, LOG_NAME, OVERHEAD, recordCrc } from './record.js';

const torn = (goodOffset) => ({ goodOffset, tornTail: true });

function validRecordAt(buf, p) {
  const remaining = buf.length - p;
  if (remaining < OVERHEAD) return false;
  const len = buf.readUInt32LE(p);
  if (len > remaining - OVERHEAD) return false;
  const type = buf[p + 4];
  return buf.readUInt32LE(p + 5 + len) === recordCrc(type, buf.subarray(p + 5, p + 5 + len));
}

/** True if any complete, CRC-valid record starts at or after `from`. */
function validRecordAhead(buf, from) {
  for (let p = from; p + OVERHEAD <= buf.length; p++) if (validRecordAt(buf, p)) return true;
  return false;
}

/**
 * Read-only scan. Calls fn(type, payload) for every good record in order.
 *
 * Torn tail (expected after a crash, never acknowledged): from goodOffset on there is a bad
 * record (too short, impossible length, or failing its CRC: zero fill and junk included) and no
 * valid record anywhere after it. Corruption (throws CorruptError): a bad record that a valid
 * record follows.
 *
 * ponytail: a valid record embedded inside a torn record's payload reads as corruption
 * (refuses, never drops data); a record whose payload holds another WAL is the only trigger.
 *
 * @param {string} dir
 * @param {(type: number, payload: Buffer) => void} fn
 * @param {{ fs?: typeof import('node:fs') }} [opts]
 * @returns {{ goodOffset: number, tornTail: boolean }}
 */
export function replay(dir, fn, { fs = realFs } = {}) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, LOG_NAME));
  } catch (e) {
    if (e.code === 'ENOENT') return { goodOffset: 0, tornTail: false };
    throw e;
  }
  let o = 0;
  while (o < buf.length) {
    const remaining = buf.length - o;
    if (remaining < OVERHEAD) return torn(o);
    const len = buf.readUInt32LE(o);
    // Compare against what is left before touching the payload: never trust len.
    if (len > remaining - OVERHEAD) {
      if (validRecordAhead(buf, o + 1)) throw new CorruptError(`wal: bad length at offset ${o}`);
      return torn(o);
    }
    const end = o + OVERHEAD + len;
    const type = buf[o + 4];
    const payload = buf.subarray(o + 5, o + 5 + len);
    if (buf.readUInt32LE(o + 5 + len) !== recordCrc(type, payload)) {
      if (validRecordAhead(buf, o + 1)) throw new CorruptError(`wal: bad crc at offset ${o}`);
      return torn(o);
    }
    fn(type, payload);
    o = end;
  }
  return { goodOffset: o, tornTail: false };
}
