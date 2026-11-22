// CRC32C (Castagnoli), reflected polynomial 0x82F63B78.
// Node's zlib.crc32 is the IEEE variant, so this is our own table-driven version.

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

/**
 * @param {Uint8Array} buf
 * @param {number} [seed] a previous result, so crc32c(b, crc32c(a)) covers a then b
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32c(buf, seed = 0) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) crc = TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
