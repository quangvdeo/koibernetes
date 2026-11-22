/**
 * fsync a file or a directory by path. Directory fsync makes new directory entries durable.
 * @param {typeof import('node:fs')} fs real fs, or a fake with the same sync methods
 * @param {string} p
 */
export function fsyncPath(fs, p) {
  const fd = fs.openSync(p, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
