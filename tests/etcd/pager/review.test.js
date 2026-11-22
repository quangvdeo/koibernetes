// Regressions for the final-review findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { open } from '../../../etcd/pager/pager.js';
import { InvalidFileError } from '../../../etcd/pager/meta.js';
import { tmpFile, leaf } from './helpers.js';

test('an empty file (crash during create) is initialised like a new one', () => {
  const p = tmpFile();
  fs.writeFileSync(p, '');
  const pager = open(p);
  assert.equal(pager.meta.txid, 1);
  pager.close();
  assert.equal(fs.statSync(p).size, 4 * 4096);
});

test('a freelist naming a meta page or a page past the high-water mark is rejected', () => {
  for (const bad of [1n, 0n, 99n]) {
    const p = tmpFile();
    open(p).close();
    const fd = fs.openSync(p, 'r+');
    const page = Buffer.alloc(4096);
    fs.readSync(fd, page, 0, 4096, 2 * 4096); // freelist page 2
    page.writeUInt16LE(1, 10); // count = 1
    page.writeBigUInt64LE(bad, 16);
    fs.writeSync(fd, page, 0, 4096, 2 * 4096);
    fs.closeSync(fd);
    assert.throws(() => open(p), InvalidFileError, `freelist entry ${bad}`);
  }
});

test('freeing part of the writer\'s own multi-page allocation throws', () => {
  const pager = open(tmpFile());
  const w = pager.beginWrite();
  const run = w.allocate(3);
  assert.throws(() => w.free(run + 1), /inside/);
  w.free(run); // the whole run, fine
  w.rollback();
  pager.close();
});

test('freeing part of the writer\'s own run allocated from the freelist throws', () => {
  const p = tmpFile();
  const pager = open(p);
  let w = pager.beginWrite();
  const a = w.allocate(3);
  w.commit({ pages: new Map([[a, leaf(4096, a, 'x', 3)]]), root: a });
  w = pager.beginWrite();
  const b = w.allocate();
  w.free(a);
  w.commit({ pages: new Map([[b, leaf(4096, b)]]), root: b });
  w = pager.beginWrite(); // a, a+1, a+2 are free again
  const run = w.allocate(3);
  assert.equal(run, a);
  assert.throws(() => w.free(run + 2), /inside/);
  w.rollback();
  pager.close();
});
