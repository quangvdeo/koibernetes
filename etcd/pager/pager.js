// bbolt-compatible page file: two meta pages, a freelist, copy-on-write commits.
// Layout and commit order: docs/key-knowledge/pager.md. Design: docs/superpowers/specs/2026-11-21-pager-design.md.
import realFs from 'node:fs';
import path from 'node:path';
import { FLAGS, readHeader, writeHeader } from './page.js';
import { decodeMeta, encodeMeta, InvalidFileError, META_END } from './meta.js';
import { Freelist } from './freelist.js';
import { fsyncPath } from '../wal/fsutil.js';

export class PoisonedError extends Error {}

const PROBE_READ = 0x1000; // bbolt reads this much to find a meta before it knows the page size
const MIN_PAGE = 1024;
const MAX_PAGE = 1024 << 14; // bbolt probes page sizes up to 16 MiB

function writeAll(fs, fd, buf, pos) {
  for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off, pos + off); // may be partial
}

function readAt(fs, fd, len, pos) {
  const buf = Buffer.alloc(len);
  let n = 0;
  while (n < len) {
    const got = fs.readSync(fd, buf, n, len - n, pos + n);
    if (got === 0) break;
    n += got;
  }
  return n === len ? buf : buf.subarray(0, n);
}

function tryMeta(buf) {
  try {
    return { meta: decodeMeta(buf) };
  } catch (error) {
    return { error };
  }
}

function checkPageSize(n) {
  if (!Number.isInteger(n) || n < MIN_PAGE || n > MAX_PAGE || (n & (n - 1)) !== 0) {
    throw new InvalidFileError(`pager: page size ${n} is not a power of two in ${MIN_PAGE}..${MAX_PAGE}`);
  }
}

class Pager {
  #fs;
  #fd;
  #meta;
  #pageSize;
  #freelist;
  #freelistPage; // { id, count } of the live freelist page run
  #cache = new Map(); // pgid -> Buffer, insertion order = LRU order
  #cachePages;
  #readers = new Map(); // txid -> open reader count
  #writer = null;
  #poisoned = false;
  #closed = false;

  constructor(fs, fd, cachePages) {
    this.#fs = fs;
    this.#fd = fd;
    this.#cachePages = cachePages;
    this.#load();
  }

  get meta() { return { ...this.#meta }; }
  get pageSize() { return this.#pageSize; }

  #load() {
    const fs = this.#fs;
    const size = fs.fstatSync(this.#fd).size;
    this.#pageSize = this.#findPageSize(size);
    let best = null;
    let firstError = null;
    for (const slot of [0, 1]) {
      const { meta, error } = tryMeta(readAt(fs, this.#fd, META_END, slot * this.#pageSize));
      if (error) { firstError ??= error; continue; }
      if (meta.pageSize !== this.#pageSize) { firstError ??= new InvalidFileError(`pager: meta ${slot} page size mismatch`); continue; }
      if (!best || meta.txid > best.txid) best = meta;
    }
    if (!best) throw firstError;
    if (best.hwm * this.#pageSize > size) {
      throw new InvalidFileError(`pager: high-water mark ${best.hwm} is past the end of the file (${size} bytes)`);
    }
    for (const [name, id] of [['root', best.root], ['freelist', best.freelist]]) {
      if (id < 2 || id >= best.hwm) throw new InvalidFileError(`pager: meta ${name} page ${id} out of range`);
    }
    this.#meta = best;
    const flBuf = this.read(best.freelist);
    this.#freelist = Freelist.decode(flBuf);
    for (const id of this.#freelist.freeIds()) {
      if (id < 2 || id >= best.hwm) throw new InvalidFileError(`pager: freelist names page ${id}, outside 2..${best.hwm - 1}`);
    }
    this.#freelistPage = { id: best.freelist, count: readHeader(flBuf).overflow + 1 };
  }

  // bbolt: page 0's meta says the page size; if page 0 is damaged, probe 1 KiB, 2 KiB, ... for meta 1.
  #findPageSize(size) {
    const first = tryMeta(readAt(this.#fs, this.#fd, PROBE_READ, 0));
    if (first.meta) {
      checkPageSize(first.meta.pageSize);
      return first.meta.pageSize;
    }
    for (let pos = MIN_PAGE; pos <= MAX_PAGE && pos < size - MIN_PAGE; pos *= 2) {
      const { meta } = tryMeta(readAt(this.#fs, this.#fd, PROBE_READ, pos));
      if (meta && meta.pageSize === pos) return pos;
    }
    throw first.error;
  }

  #check() {
    if (this.#closed) throw new Error('pager: closed');
    if (this.#poisoned) throw new PoisonedError('pager: a commit failed earlier, reopen the file');
  }

  /**
   * A committed page (with its overflow pages). The buffer is shared with the cache: never modify it.
   * @param {number} pgid
   * @returns {Buffer}
   */
  read(pgid) {
    this.#check();
    if (!Number.isInteger(pgid) || pgid < 0 || pgid >= this.#meta.hwm) {
      throw new RangeError(`pager: page ${pgid} outside 0..${this.#meta.hwm - 1}`);
    }
    const hit = this.#cache.get(pgid);
    if (hit) {
      this.#cache.delete(pgid);
      this.#cache.set(pgid, hit);
      return hit;
    }
    const pos = pgid * this.#pageSize;
    let buf = readAt(this.#fs, this.#fd, this.#pageSize, pos);
    if (buf.length < this.#pageSize) throw new InvalidFileError(`pager: short read of page ${pgid}`);
    const h = readHeader(buf);
    if (h.id !== pgid) throw new InvalidFileError(`pager: page ${pgid} says it is page ${h.id}`);
    if (h.overflow > 0) {
      const full = (h.overflow + 1) * this.#pageSize;
      if (pgid + h.overflow >= this.#meta.hwm) throw new InvalidFileError(`pager: page ${pgid} overflows past the high-water mark`);
      buf = readAt(this.#fs, this.#fd, full, pos);
      if (buf.length < full) throw new InvalidFileError(`pager: short read of page ${pgid}`);
    }
    this.#cachePut(pgid, buf);
    return buf;
  }

  #cachePut(pgid, buf) {
    this.#cache.delete(pgid);
    this.#cache.set(pgid, buf);
    while (this.#cache.size > this.#cachePages) this.#cache.delete(this.#cache.keys().next().value);
  }

  /** Pin the live state. Pages it can see are not reused until release(). */
  beginRead() {
    this.#check();
    const meta = this.meta;
    this.#readers.set(meta.txid, (this.#readers.get(meta.txid) ?? 0) + 1);
    let open = true;
    return {
      meta,
      release: () => {
        if (!open) return;
        open = false;
        const n = this.#readers.get(meta.txid) - 1;
        if (n === 0) this.#readers.delete(meta.txid);
        else this.#readers.set(meta.txid, n);
      },
    };
  }

  /**
   * Start the single write transaction. Pending pages no open reader can see are released first
   * (bbolt's rule: freed by commit t, released when t < every open reader's txid).
   */
  beginWrite() {
    this.#check();
    if (this.#writer) throw new Error('pager: a writer is already open');
    this.#freelist.release(Math.min(Infinity, ...this.#readers.keys()));
    const writer = new Writer(this, {
      txid: this.#meta.txid + 1,
      hwm: this.#meta.hwm,
      snapshot: this.#freelist.clone(),
    });
    this.#writer = writer;
    return writer;
  }

  // The methods below are the Writer's access to pager internals; not for other callers.

  _freelist() { return this.#freelist; }
  _restoreFreelist(f) { this.#freelist = f; }
  _endWrite() { this.#writer = null; }
  _check() { this.#check(); }
  _liveFreelistPage() { return this.#freelistPage; }

  /** Writes pages, fsync, meta, fsync. Throws (and poisons) on any I/O error. */
  _commit({ pages, meta, freelistPage }) {
    const fs = this.#fs;
    try {
      for (const id of [...pages.keys()].sort((a, b) => a - b)) writeAll(fs, this.#fd, pages.get(id), id * this.#pageSize);
      fs.fsyncSync(this.#fd); // every new page durable before anything points at it
      writeAll(fs, this.#fd, encodeMeta(meta, this.#pageSize), (meta.txid % 2) * this.#pageSize);
      fs.fsyncSync(this.#fd); // the commit point
    } catch (e) {
      this.#poisoned = true; // on-disk state unknown until reopen; a retried fsync can falsely succeed
      throw e;
    }
    this.#meta = meta;
    this.#freelistPage = freelistPage;
    for (const [id, buf] of pages) this.#cachePut(id, buf);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#fs.closeSync(this.#fd);
  }
}

class Writer {
  #pager;
  #txid;
  #hwm;
  #snapshot; // freelist at beginWrite, for rollback
  #allocated = new Map(); // first pgid -> page count, pages handed out by this writer
  #done = false;

  constructor(pager, { txid, hwm, snapshot }) {
    this.#pager = pager;
    this.#txid = txid;
    this.#hwm = hwm;
    this.#snapshot = snapshot;
  }

  get txid() { return this.#txid; }

  #check() {
    if (this.#done) throw new Error('pager: writer is closed');
    this.#pager._check();
  }

  /** @param {number} [count] contiguous pages @returns {number} first page id */
  allocate(count = 1) {
    this.#check();
    if (!Number.isInteger(count) || count < 1) throw new RangeError(`pager: bad page count ${count}`);
    let id = this.#pager._freelist().allocate(count);
    if (id === 0) {
      id = this.#hwm;
      this.#hwm += count;
    }
    this.#allocated.set(id, count);
    return id;
  }

  /** Stop using page `pgid` (and its overflow). Reused once no reader can see it. */
  free(pgid) {
    this.#check();
    const freelist = this.#pager._freelist();
    const own = this.#allocated.get(pgid);
    if (own) { // never committed, nobody else can see it
      this.#allocated.delete(pgid);
      freelist.addFree(pgid, own);
      return;
    }
    for (const [start, count] of this.#allocated) {
      if (pgid > start && pgid < start + count) throw new Error(`pager: page ${pgid} is inside run ${start}+${count}, free ${start}`);
    }
    if (!Number.isInteger(pgid) || pgid < 2 || pgid >= this.#pager.meta.hwm) throw new RangeError(`pager: cannot free page ${pgid}`);
    if (pgid === this.#pager._liveFreelistPage().id) throw new Error('pager: the freelist page is freed by commit itself');
    if (freelist.has(pgid)) throw new Error(`pager: page ${pgid} already free`);
    freelist.free(this.#txid, pgid, readHeader(this.#pager.read(pgid)).overflow);
  }

  /**
   * @param {{ pages: Map<number, Buffer>, root: number, sequence?: number }} c
   *   pages: one image per allocation of this writer, nothing else (copy-on-write).
   */
  commit({ pages, root, sequence }) {
    this.#check();
    const pager = this.#pager;
    const ps = pager.pageSize;
    this.#validate(pages, root, ps);

    // Validated: from here on, state changes. Old freelist page out, new one in (bbolt order).
    const freelist = pager._freelist();
    const old = pager._liveFreelistPage();
    freelist.free(this.#txid, old.id, old.count - 1);
    const count = Math.floor(freelist.encodedSize() / ps) + 1; // over-estimates, never under
    const flId = this.allocate(count);
    const flBuf = Buffer.alloc(count * ps);
    writeHeader(flBuf, { id: flId, flags: FLAGS.freelist, count: 0, overflow: count - 1 });
    freelist.encode(flBuf);
    const all = new Map(pages);
    all.set(flId, flBuf);

    const meta = { ...pager.meta, root, sequence: sequence ?? pager.meta.sequence, freelist: flId, hwm: this.#hwm, txid: this.#txid };
    this.#done = true;
    try {
      pager._commit({ pages: all, meta, freelistPage: { id: flId, count } });
    } finally {
      pager._endWrite();
    }
  }

  #validate(pages, root, ps) {
    if (!(pages instanceof Map)) throw new TypeError('pager: pages must be a Map<pgid, Buffer>');
    for (const [id, buf] of pages) {
      const count = this.#allocated.get(id);
      if (!count) throw new Error(`pager: page ${id} was not allocated by this writer (copy-on-write)`);
      if (!Buffer.isBuffer(buf) || buf.length !== count * ps) throw new Error(`pager: page ${id} must be ${count * ps} bytes`);
      const h = readHeader(buf);
      if (h.id !== id || h.overflow !== count - 1) throw new Error(`pager: page ${id} header says id ${h.id}, overflow ${h.overflow}`);
    }
    for (const id of this.#allocated.keys()) if (!pages.has(id)) throw new Error(`pager: allocated page ${id} not written`);
    const freelist = this.#pager._freelist();
    if (!Number.isInteger(root) || root < 2 || root >= this.#hwm || freelist.has(root) || root === this.#pager._liveFreelistPage().id) {
      throw new Error(`pager: bad root page ${root}`);
    }
  }

  /** Discard everything this writer did. */
  rollback() {
    if (this.#done) return;
    this.#done = true;
    this.#pager._restoreFreelist(this.#snapshot);
    this.#pager._endWrite();
  }
}

// bbolt's initial layout: metas (txid 0 and 1), empty freelist, empty root leaf.
function initFile(fs, fd, file, pageSize) {
  checkPageSize(pageSize);
  const buf = Buffer.alloc(pageSize * 4);
  const meta = { pageSize, flags: 0, root: 3, sequence: 0, freelist: 2, hwm: 4, txid: 0 };
  encodeMeta(meta, pageSize).copy(buf, 0);
  encodeMeta({ ...meta, txid: 1 }, pageSize).copy(buf, pageSize);
  writeHeader(buf.subarray(2 * pageSize), { id: 2, flags: FLAGS.freelist, count: 0, overflow: 0 });
  writeHeader(buf.subarray(3 * pageSize), { id: 3, flags: FLAGS.leaf, count: 0, overflow: 0 });
  writeAll(fs, fd, buf, 0);
  fs.fsyncSync(fd);
  fsyncPath(fs, path.dirname(file)); // the new directory entry must survive a power cut too
}

/**
 * Open a bbolt-format file, creating it (bbolt's 4-page initial layout) if it does not exist.
 * @param {string} file
 * @param {{ pageSize?: number, fs?: typeof import('node:fs'), cachePages?: number }} [opts]
 *   pageSize applies only when creating; an existing file's page size wins.
 */
export function open(file, { pageSize = 4096, fs = realFs, cachePages = 1024 } = {}) {
  const abs = path.resolve(file);
  const exists = fs.existsSync(abs);
  const fd = fs.openSync(abs, exists ? 'r+' : 'w+');
  try {
    // A crash during create can leave an empty file behind; bbolt initialises those too.
    if (!exists || fs.fstatSync(fd).size === 0) initFile(fs, fd, abs, pageSize);
    return new Pager(fs, fd, cachePages);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

