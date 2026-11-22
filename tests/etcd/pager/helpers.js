// Test helpers for the pager tests. Not production code.
import realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpFile(name = 'db') {
  return path.join(realFs.mkdtempSync(path.join(os.tmpdir(), 'pager-')), name);
}

/** node:fs with readSync calls counted in .reads */
export function countingFs() {
  const fs = { ...realFs, reads: 0 };
  fs.readSync = (...a) => { fs.reads++; return realFs.readSync(...a); };
  return fs;
}

/** Make a FakeFs directory durable (it and its parent fsynced). */
export function durableDir(fs, dir) {
  fs.mkdirSync(dir);
  for (const d of ['/', dir]) {
    const fd = fs.openSync(d, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }
}

export const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

/** A leaf page image of `count` pages with `marker` written after the header. */
export function leaf(pageSize, id, marker = '', count = 1) {
  const buf = Buffer.alloc(pageSize * count);
  buf.writeBigUInt64LE(BigInt(id), 0);
  buf.writeUInt16LE(0x02, 8);
  buf.writeUInt32LE(count - 1, 12);
  buf.write(marker, 16);
  return buf;
}

export const markerOf = (buf) => buf.toString('utf8', 16, buf.indexOf(0, 16));

/** Collect allocations until the writer starts handing out never-used pages (>= hwm). */
export function drainFree(w, hwm) {
  const got = [];
  for (let id = w.allocate(); id < hwm; id = w.allocate()) got.push(id);
  return got;
}
