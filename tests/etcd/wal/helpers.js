// Test helpers shared by *.test.js files. Not production code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replay } from '../../../etcd/wal/replay.js';

export function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
}

export function replayAll(dir) {
  const recs = [];
  const result = replay(dir, (type, payload) => recs.push({ type, payload: Buffer.from(payload) }));
  return { recs, result };
}
