import realFs from 'node:fs';
import path from 'node:path';
import { encode, LOG_NAME, OVERHEAD, TornTailError } from './record.js';
import { replay } from './replay.js';
import { fsyncPath } from './fsutil.js';

// replay reads the whole log into one Buffer; fs.readFileSync stops at 2 GiB - 1. Never acknowledge
// a record that would make the log unreadable. ponytail: hard ceiling, segments lift it (MVCC step).
export const MAX_LOG_BYTES = 2 ** 31 - 1;

class Wal {
  #fs;
  #fd;
  #size; // bytes of good records in the file
  #failed = false;
  #closed = false;

  constructor(fs, fd, size) {
    this.#fs = fs;
    this.#fd = fd;
    this.#size = size;
  }

  /**
   * Writes one record and fsyncs. Returns only after the record is on disk.
   * On any write or fsync error the partial record is cut off and the Wal refuses further
   * appends, so a retry can never bury acknowledged records behind garbage.
   * @param {number} type integer 0..255
   * @param {Uint8Array} payload
   */
  append(type, payload) {
    if (this.#closed) throw new Error('wal: closed');
    if (this.#failed) throw new Error('wal: failed earlier, reopen after repair');
    if (!Number.isInteger(type) || type < 0 || type > 255) {
      throw new RangeError(`wal: type must be an integer 0..255, got ${type}`);
    }
    if (!(payload instanceof Uint8Array)) throw new TypeError('wal: payload must be a Buffer or Uint8Array');
    if (this.#size + OVERHEAD + payload.length > MAX_LOG_BYTES) {
      throw new RangeError(`wal: log would exceed ${MAX_LOG_BYTES} bytes, which replay cannot read`);
    }
    const buf = encode(type, payload);
    try {
      let off = 0;
      while (off < buf.length) off += this.#fs.writeSync(this.#fd, buf, off, buf.length - off); // writeSync may be partial
      this.#fs.fsyncSync(this.#fd);
    } catch (e) {
      this.#failed = true;
      try {
        this.#fs.ftruncateSync(this.#fd, this.#size);
      } catch {
        // best effort: the next open reports a torn tail if this did not work
      }
      throw e;
    }
    this.#size += buf.length;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#fs.closeSync(this.#fd);
  }
}

/**
 * @param {string} dir
 * @param {{ fs?: typeof import('node:fs') }} [opts] fs is injectable so tests can simulate power loss
 */
export function open(dir, { fs = realFs } = {}) {
  const abs = path.resolve(dir);
  const created = fs.mkdirSync(abs, { recursive: true }); // first directory it had to create, or undefined
  // Appending after a torn tail would bury later records behind garbage.
  if (replay(abs, () => {}, { fs }).tornTail) throw new TornTailError();
  const fd = fs.openSync(path.join(abs, LOG_NAME), 'a');
  // Directory entries must be durable too, or a crash can lose the file (or whole new directories)
  // together with acknowledged records. Cheap, so done on every open.
  const top = created ? path.dirname(path.resolve(created)) : abs;
  for (let p = abs; ; p = path.dirname(p)) {
    fsyncPath(fs, p);
    if (p === top) break;
  }
  return new Wal(fs, fd, fs.fstatSync(fd).size);
}
