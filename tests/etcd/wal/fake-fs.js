// In-memory fake of the sync fs methods the WAL uses, with a power-loss model.
// Writes are volatile until fsynced. File data becomes durable on fsync(file); a file's or
// directory's existence becomes durable on fsync(parent directory). crash() throws away
// everything that is not durable, like pulling the plug. Deliberately conservative: after
// crash() a file holds exactly what was last fsynced.
// Reordering mode for the pager: crash(pick) lets any chosen subset of the writes made since the
// last fsync survive (each possibly cut short), modelling a disk that reorders or tears writes.
// crashAtOp / skipFileFsync inject a power cut at an exact operation, or a missing fsync.
// Not production code. Test support for durability.test.js.
import path from 'node:path';

const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });

/** Thrown by an operation chosen with crashAtOp: the power went out before it ran. */
export class CrashSignal extends Error {}

export class FakeFs {
  /** @param {{ ignoreFileFsync?: boolean, ignoreDirFsync?: boolean }} [opts] simulate a missing fsync */
  constructor({ ignoreFileFsync = false, ignoreDirFsync = false } = {}) {
    this.ignoreFileFsync = ignoreFileFsync;
    this.ignoreDirFsync = ignoreDirFsync;
    this.files = new Map(); // path -> { data, durable, durableLinked }
    this.dirs = new Map([['/', { durableExists: true }]]);
    this.fds = new Map(); // fd -> { path, kind }
    this.nextFd = 3;
    this.ops = []; // e.g. 'fsync:/wal/wal.log', in call order
    this.opCount = 0; // writeSync + fsyncSync calls since crashAtOp was last set
    this.fileFsyncCount = 0;
    this.skipFileFsync = () => false; // (n-th file fsync) => true to ignore it
    this.#crashAtOp = null;
  }

  #crashAtOp;
  get crashAtOp() { return this.#crashAtOp; }
  /** The n-th (0-based) writeSync/fsyncSync from now throws CrashSignal instead of running. */
  set crashAtOp(n) { this.#crashAtOp = n; this.opCount = 0; }

  #tick() {
    if (this.#crashAtOp !== null && this.opCount === this.#crashAtOp) throw new CrashSignal(`crash at op ${this.opCount}`);
    this.opCount++;
  }

  pendingWrites(p) { return this.files.get(p)?.pending ?? []; }

  seed(p, data) { // pre-existing durable file
    this.#mkdirs(path.dirname(p), true);
    this.files.set(p, { data: Buffer.from(data), durable: Buffer.from(data), durableLinked: true, pending: [] });
  }

  #mkdirs(dir, durable = false) {
    let first;
    const todo = [];
    for (let d = dir; !this.dirs.has(d); d = path.dirname(d)) todo.unshift(d);
    for (const d of todo) {
      this.dirs.set(d, { durableExists: durable });
      first ??= d;
    }
    return first;
  }

  mkdirSync(p) {
    this.ops.push(`mkdir:${p}`);
    return this.#mkdirs(p);
  }

  existsSync(p) { return this.files.has(p) || this.dirs.has(p); }

  statSync(p) {
    if (this.files.has(p)) return { size: this.files.get(p).data.length };
    if (this.dirs.has(p)) return { size: 0 };
    throw enoent(p);
  }

  fstatSync(fd) { return this.statSync(this.fds.get(fd).path); }

  readFileSync(p) {
    if (!this.files.has(p)) throw enoent(p);
    return Buffer.from(this.files.get(p).data);
  }

  openSync(p, flags) {
    let kind = 'file';
    if (this.dirs.has(p)) kind = 'dir';
    else if (!this.files.has(p) || flags === 'w+') {
      if (flags !== 'a' && flags !== 'w+') throw enoent(p);
      if (!this.dirs.has(path.dirname(p))) throw enoent(path.dirname(p));
      const old = this.files.get(p);
      if (old) old.data = Buffer.alloc(0);
      else this.files.set(p, { data: Buffer.alloc(0), durable: Buffer.alloc(0), durableLinked: false, pending: [] });
    }
    const fd = this.nextFd++;
    this.fds.set(fd, { path: p, kind });
    return fd;
  }

  closeSync(fd) { this.fds.delete(fd); }

  writeSync(fd, buf, off = 0, len = buf.length - off, position = null) {
    this.#tick();
    const f = this.files.get(this.fds.get(fd).path);
    const pos = typeof position === 'number' ? position : f.data.length;
    const bytes = Buffer.from(buf.subarray(off, off + len));
    f.data = place(f.data, pos, bytes);
    f.pending.push({ pos, data: bytes });
    return len;
  }

  readSync(fd, buf, off, len, position) {
    const f = this.files.get(this.fds.get(fd).path);
    const n = Math.max(0, Math.min(len, f.data.length - position));
    f.data.copy(buf, off, position, position + n);
    return n;
  }

  ftruncateSync(fd, len) { this.truncateSync(this.fds.get(fd).path, len); }

  truncateSync(p, len) {
    this.ops.push(`truncate:${p}`);
    const f = this.files.get(p);
    f.data = f.data.subarray(0, len);
  }

  copyFileSync(src, dst) {
    this.ops.push(`copy:${dst}`);
    this.files.set(dst, { data: Buffer.from(this.files.get(src).data), durable: Buffer.alloc(0), durableLinked: false, pending: [] });
  }

  fsyncSync(fd) {
    this.#tick();
    const { path: p, kind } = this.fds.get(fd);
    this.ops.push(`fsync:${p}`);
    if (kind === 'file') {
      if (this.skipFileFsync(this.fileFsyncCount++) || this.ignoreFileFsync) return;
      const f = this.files.get(p);
      f.durable = Buffer.from(f.data);
      f.pending = [];
    } else {
      if (this.ignoreDirFsync) return;
      for (const [fp, f] of this.files) if (path.dirname(fp) === p) f.durableLinked = true;
      for (const [dp, d] of this.dirs) if (dp !== '/' && path.dirname(dp) === p) d.durableExists = true;
    }
  }

  /**
   * Power cut: keep only what is durable, plus the writes pick(path, pendingWrites) returns
   * (each { pos, data }, data possibly a prefix), applied in order on top of the durable bytes.
   */
  crash(pick = () => []) {
    for (const [dp, d] of [...this.dirs]) {
      if (d.durableExists) continue;
      this.dirs.delete(dp);
      for (const fp of [...this.files.keys()]) if (fp.startsWith(dp + '/')) this.files.delete(fp);
    }
    for (const [fp, f] of [...this.files]) {
      if (!f.durableLinked) this.files.delete(fp);
      else {
        let data = Buffer.from(f.durable);
        for (const w of pick(fp, f.pending)) data = place(data, w.pos, w.data);
        f.data = data;
        f.durable = Buffer.from(data);
        f.pending = [];
      }
    }
    this.fds.clear();
  }
}

function place(data, pos, bytes) {
  const out = Buffer.alloc(Math.max(data.length, pos + bytes.length));
  data.copy(out);
  bytes.copy(out, pos);
  return out;
}
