// Free pages (reusable now) and pending pages (freed by a commit, reusable once no reader
// can still see them). Stored on disk as one list: after a crash nobody is reading.
import { FLAGS, HEADER_SIZE, readHeader, writeHeader } from './page.js';

const BIG_COUNT = 0xffff; // page.count is 16 bits; at this value the real count is in the first slot

export class Freelist {
  #free = []; // sorted page ids
  #pending = new Map(); // txid -> page ids freed by that commit
  #all = new Set(); // free + pending, for double-free checks

  /** @param {Buffer} buf a freelist page (with overflow) */
  static decode(buf) {
    const { flags, count } = readHeader(buf);
    if (flags !== FLAGS.freelist) throw new Error(`pager: page is not a freelist (flags 0x${flags.toString(16)})`);
    let off = HEADER_SIZE;
    let n = count;
    if (count === BIG_COUNT) {
      n = Number(buf.readBigUInt64LE(off));
      off += 8;
    }
    if (off + n * 8 > buf.length) throw new Error('pager: freelist runs past its page');
    const f = new Freelist();
    for (let i = 0; i < n; i++) f.addFree(Number(buf.readBigUInt64LE(off + i * 8)), 1);
    return f;
  }

  /** Make pages reusable at once (pages nobody else can see). */
  addFree(id, count) {
    for (let p = id; p < id + count; p++) {
      if (this.#all.has(p)) throw new Error(`pager: page ${p} already free`);
      this.#all.add(p);
      this.#free.splice(sortedIndex(this.#free, p), 0, p); // ponytail: O(n) insert, sorted array; span map if freelists get big
    }
  }

  /** Commit `txid` stopped using page `id` and its `overflow` pages. */
  free(txid, id, overflow) {
    if (id <= 1) throw new Error(`pager: cannot free meta page ${id}`);
    const ids = [];
    for (let p = id; p <= id + overflow; p++) {
      if (this.#all.has(p)) throw new Error(`pager: page ${p} already free`);
      ids.push(p);
    }
    for (const p of ids) this.#all.add(p);
    if (!this.#pending.has(txid)) this.#pending.set(txid, []);
    this.#pending.get(txid).push(...ids);
  }

  /** Move pages freed by commits t < belowTxid to the free list. */
  release(belowTxid) {
    for (const [t, ids] of this.#pending) {
      if (t >= belowTxid) continue;
      this.#pending.delete(t);
      for (const p of ids) {
        this.#all.delete(p);
        this.addFree(p, 1);
      }
    }
  }

  /** First fit: start id of `n` contiguous free pages, removed from the list, or 0 if none. */
  allocate(n) {
    let start = 0;
    for (let i = 0; i < this.#free.length; i++) {
      if (i === 0 || this.#free[i] !== this.#free[i - 1] + 1) start = i;
      if (i - start + 1 === n) {
        const ids = this.#free.splice(start, n);
        for (const p of ids) this.#all.delete(p);
        return ids[0];
      }
    }
    return 0;
  }

  has(id) { return this.#all.has(id); }
  freeIds() { return [...this.#free]; }

  /** Bytes encode() needs, header included. */
  encodedSize() {
    const n = this.#all.size;
    return HEADER_SIZE + (n >= BIG_COUNT ? 8 : 0) + n * 8;
  }

  /** Writes flags, count and the sorted free + pending ids. Keeps the header's id and overflow. */
  encode(buf) {
    const ids = [...this.#all].sort((a, b) => a - b);
    const h = readHeader(buf);
    let off = HEADER_SIZE;
    if (ids.length >= BIG_COUNT) {
      buf.writeBigUInt64LE(BigInt(ids.length), off);
      off += 8;
    }
    writeHeader(buf, { ...h, flags: FLAGS.freelist, count: Math.min(ids.length, BIG_COUNT) });
    for (const p of ids) {
      buf.writeBigUInt64LE(BigInt(p), off);
      off += 8;
    }
  }

  clone() {
    const c = new Freelist();
    c.#free = [...this.#free];
    c.#pending = new Map([...this.#pending].map(([t, ids]) => [t, [...ids]]));
    c.#all = new Set(this.#all);
    return c;
  }
}

function sortedIndex(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
