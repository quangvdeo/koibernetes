import realFs from 'node:fs';
import path from 'node:path';
import { BROKEN_NAME, LOG_NAME } from './record.js';
import { replay } from './replay.js';
import { fsyncPath } from './fsutil.js';

function backupPath(fs, dir) {
  let p = path.join(dir, BROKEN_NAME);
  for (let n = 1; fs.existsSync(p); n++) p = path.join(dir, `${BROKEN_NAME}.${n}`);
  return p;
}

/**
 * If the log has a torn tail, copy it to wal.log.broken (or .broken.N, never overwriting) and
 * truncate to the last good record. CorruptError from replay propagates: mid-file corruption
 * is never repaired silently.
 * @param {string} dir
 * @param {{ fs?: typeof import('node:fs') }} [opts]
 * @returns {number} bytes dropped from the log (0 when it was clean)
 */
export function repair(dir, { fs = realFs } = {}) {
  const { goodOffset, tornTail } = replay(dir, () => {}, { fs });
  if (!tornTail) return 0;
  const log = path.join(dir, LOG_NAME);
  const size = fs.statSync(log).size;
  const backup = backupPath(fs, dir);
  fs.copyFileSync(log, backup);
  // The backup and its directory entry must be durable before the cut: otherwise a power loss
  // could keep the truncate and lose the only copy of the dropped bytes.
  fsyncPath(fs, backup);
  fsyncPath(fs, dir);
  fs.truncateSync(log, goodOffset);
  fsyncPath(fs, log);
  return size - goodOffset;
}
