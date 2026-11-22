// bbolt meta page: header, then the meta fields, then an FNV-1a 64 checksum of the fields.
import { FLAGS, HEADER_SIZE, writeHeader } from './page.js';

export const MAGIC = 0xed0cdaed;
export const VERSION = 2;
export const META_END = 80; // header (16) + fields (56) + checksum (8)
const SUM_FROM = HEADER_SIZE; // magic
const SUM_TO = 72; // checksum covers magic..txid
const NO_FREELIST = 0xffffffffffffffffn;

export class InvalidFileError extends Error {}
export class VersionError extends Error {}
export class ChecksumError extends Error {}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a 64-bit, as Go's hash/fnv New64a. @param {Uint8Array} bytes @returns {bigint} */
export function fnv1a64(bytes) {
  let h = FNV_OFFSET;
  for (const b of bytes) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK; // ponytail: BigInt per byte, 56 bytes per meta, not hot
  return h;
}

/**
 * @typedef {{ pageSize: number, flags: number, root: number, sequence: number,
 *             freelist: number, hwm: number, txid: number }} Meta
 * @param {Meta} m
 * @param {number} pageSize
 * @returns {Buffer} a full meta page, header id = txid % 2 (the slot it belongs in)
 */
export function encodeMeta(m, pageSize) {
  const buf = Buffer.alloc(pageSize);
  writeHeader(buf, { id: m.txid % 2, flags: FLAGS.meta, count: 0, overflow: 0 });
  buf.writeUInt32LE(MAGIC, 16);
  buf.writeUInt32LE(VERSION, 20);
  buf.writeUInt32LE(m.pageSize, 24);
  buf.writeUInt32LE(m.flags, 28);
  buf.writeBigUInt64LE(BigInt(m.root), 32);
  buf.writeBigUInt64LE(BigInt(m.sequence), 40);
  buf.writeBigUInt64LE(BigInt(m.freelist), 48);
  buf.writeBigUInt64LE(BigInt(m.hwm), 56);
  buf.writeBigUInt64LE(BigInt(m.txid), 64);
  buf.writeBigUInt64LE(fnv1a64(buf.subarray(SUM_FROM, SUM_TO)), 72);
  return buf;
}

function u64(buf, off, name) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidFileError(`pager: meta ${name} too large: ${v}`);
  return Number(v);
}

/**
 * Validates in bbolt's order (magic, version, checksum).
 * @param {Buffer} buf at least META_END bytes, starting at the page
 * @returns {Meta}
 */
export function decodeMeta(buf) {
  if (buf.length < META_END) throw new InvalidFileError('pager: short meta page');
  if (buf.readUInt32LE(16) !== MAGIC) throw new InvalidFileError('pager: not a bolt file (bad magic)');
  const version = buf.readUInt32LE(20);
  if (version !== VERSION) throw new VersionError(`pager: file format version ${version}, want ${VERSION}`);
  if (buf.readBigUInt64LE(72) !== fnv1a64(buf.subarray(SUM_FROM, SUM_TO))) throw new ChecksumError('pager: meta checksum mismatch');
  if (buf.readBigUInt64LE(48) === NO_FREELIST) {
    throw new InvalidFileError('pager: file has no stored freelist (bbolt NoFreelistSync), unsupported');
  }
  return {
    pageSize: buf.readUInt32LE(24),
    flags: buf.readUInt32LE(28),
    root: u64(buf, 32, 'root'),
    sequence: u64(buf, 40, 'sequence'),
    freelist: u64(buf, 48, 'freelist'),
    hwm: u64(buf, 56, 'hwm'),
    txid: u64(buf, 64, 'txid'),
  };
}
