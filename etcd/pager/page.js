// bbolt page header: every page starts with these 16 bytes (little endian).
export const HEADER_SIZE = 16;
export const FLAGS = Object.freeze({ branch: 0x01, leaf: 0x02, meta: 0x04, freelist: 0x10 });

/** @param {Buffer} buf @returns {{ id: number, flags: number, count: number, overflow: number }} */
export function readHeader(buf) {
  return {
    id: Number(buf.readBigUInt64LE(0)),
    flags: buf.readUInt16LE(8),
    count: buf.readUInt16LE(10),
    overflow: buf.readUInt32LE(12),
  };
}

/** @param {Buffer} buf @param {{ id: number, flags: number, count: number, overflow: number }} h */
export function writeHeader(buf, { id, flags, count, overflow }) {
  buf.writeBigUInt64LE(BigInt(id), 0);
  buf.writeUInt16LE(flags, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(overflow, 12);
}
