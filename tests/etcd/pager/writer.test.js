import test from 'node:test';
import assert from 'node:assert/strict';
import realFs from 'node:fs';
import { open, PoisonedError } from '../../../etcd/pager/pager.js';
import { decodeMeta } from '../../../etcd/pager/meta.js';
import { tmpFile, leaf, markerOf, drainFree } from './helpers.js';

/** One commit: new root leaf with `marker`, old root freed. Returns the new root id. */
function commitRoot(pager, marker) {
  const w = pager.beginWrite();
  const old = pager.meta.root;
  const id = w.allocate();
  w.free(old);
  w.commit({ pages: new Map([[id, leaf(pager.pageSize, id, marker)]]), root: id });
  return id;
}

test('commit a new root, reopen sees it', () => {
  const p = tmpFile();
  let pager = open(p);
  const root = commitRoot(pager, 'gen-1');
  assert.equal(root, 4);
  assert.equal(pager.meta.txid, 2);
  assert.equal(markerOf(pager.read(4)), 'gen-1');
  pager.close();
  pager = open(p);
  assert.equal(pager.meta.root, 4);
  assert.equal(pager.meta.txid, 2);
  assert.equal(markerOf(pager.read(4)), 'gen-1');
  pager.close();
  const raw = realFs.readFileSync(p);
  assert.equal(decodeMeta(raw.subarray(0, 4096)).txid, 2); // slot txid % 2 = 0 rewritten
  assert.equal(decodeMeta(raw.subarray(4096, 8192)).txid, 1); // slot 1 untouched
});

test('only one writer at a time', () => {
  const pager = open(tmpFile());
  const w = pager.beginWrite();
  assert.throws(() => pager.beginWrite(), /writer/);
  w.rollback();
  pager.beginWrite().rollback();
  pager.close();
});

test('copy-on-write is enforced and a rejected commit writes nothing', () => {
  const p = tmpFile();
  const pager = open(p);
  const before = realFs.readFileSync(p);
  const w = pager.beginWrite();
  const a = w.allocate();
  const b = w.allocate(2);
  const ps = pager.pageSize;
  const good = () => new Map([[a, leaf(ps, a)], [b, leaf(ps, b, '', 2)]]);
  const cases = {
    'live page': (m) => m.set(3, leaf(ps, 3)),
    'missing page': (m) => m.delete(b),
    'wrong size': (m) => m.set(b, leaf(ps, b, '', 1)),
    'header id': (m) => m.set(a, leaf(ps, a + 7)),
    'overflow': (m) => { const x = leaf(ps, b, '', 2); x.writeUInt32LE(0, 12); m.set(b, x); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const m = good();
    mutate(m);
    assert.throws(() => w.commit({ pages: m, root: a }), Error, name);
  }
  for (const root of [0, 1, 99, 2]) assert.throws(() => w.commit({ pages: good(), root }), Error, `root ${root}`);
  assert.deepEqual(realFs.readFileSync(p), before);
  w.commit({ pages: good(), root: a }); // still usable after rejections
  assert.equal(pager.meta.root, a);
  pager.close();
});

test('rollback restores high-water mark and freelist', () => {
  const pager = open(tmpFile());
  const w = pager.beginWrite();
  assert.equal(w.allocate(3), 4);
  w.free(3);
  w.rollback();
  assert.throws(() => w.allocate(), /closed/);
  const w2 = pager.beginWrite();
  assert.equal(w2.allocate(), 4);
  w2.free(3); // not double-freed: rollback undid it
  w2.rollback();
  assert.equal(pager.meta.txid, 1);
  pager.close();
});

test('a page freed by the writer that allocated it is reusable at once', () => {
  const pager = open(tmpFile());
  const w = pager.beginWrite();
  const a = w.allocate();
  w.free(a);
  assert.equal(w.allocate(), a);
  w.rollback();
  pager.close();
});

test('a committed page freed by a commit is pending, then reusable', () => {
  const pager = open(tmpFile());
  commitRoot(pager, 'gen-1'); // frees root 3 and freelist page 2 under txid 2
  const w = pager.beginWrite();
  assert.deepEqual(drainFree(w, pager.meta.hwm), [2, 3]);
  w.rollback();
  pager.close();
});

test('an open reader blocks reuse of pages it can see', () => {
  const pager = open(tmpFile());
  commitRoot(pager, 'gen-1'); // txid 2, root 4
  const r = pager.beginRead(); // pins txid 2, sees root 4
  commitRoot(pager, 'gen-2'); // txid 3 frees root 4
  commitRoot(pager, 'gen-3'); // txid 4
  let w = pager.beginWrite();
  assert.ok(!drainFree(w, pager.meta.hwm).includes(4));
  w.rollback();
  assert.equal(markerOf(pager.read(r.meta.root)), 'gen-1'); // still intact for the reader
  r.release();
  w = pager.beginWrite();
  assert.ok(drainFree(w, pager.meta.hwm).includes(4));
  w.rollback();
  pager.close();
});

test('pending pages survive reopen as free pages', () => {
  const p = tmpFile();
  let pager = open(p);
  commitRoot(pager, 'gen-1');
  pager.close();
  pager = open(p);
  const w = pager.beginWrite();
  assert.deepEqual(drainFree(w, pager.meta.hwm), [2, 3]);
  w.rollback();
  pager.close();
});

test('overflow pages and a freelist bigger than one page round trip', () => {
  const p = tmpFile();
  let pager = open(p, { pageSize: 1024 }); // a freelist page holds 126 ids
  let w = pager.beginWrite();
  const ids = Array.from({ length: 300 }, () => w.allocate());
  const big = w.allocate(3);
  const pages = new Map(ids.map((id) => [id, leaf(1024, id)]));
  const bigPage = leaf(1024, big, 'big', 3);
  bigPage.write('tail', 3 * 1024 - 4);
  pages.set(big, bigPage);
  w.commit({ pages, root: big });
  w = pager.beginWrite();
  for (const id of ids.slice(0, 200)) w.free(id);
  const keep = w.allocate();
  w.commit({ pages: new Map([[keep, leaf(1024, keep)]]), root: big });
  pager.close();

  pager = open(p);
  const back = pager.read(big);
  assert.equal(back.length, 3 * 1024);
  assert.equal(markerOf(back), 'big');
  assert.equal(back.toString('utf8', 3 * 1024 - 4), 'tail');
  w = pager.beginWrite();
  const free = drainFree(w, pager.meta.hwm);
  for (const id of ids.slice(0, 200)) assert.ok(free.includes(id), `page ${id} lost`);
  w.rollback();
  pager.close();
});

for (const op of ['writeSync', 'fsyncSync']) {
  test(`${op} failure poisons the pager and leaves the old state`, () => {
    const p = tmpFile();
    open(p).close();
    let armed = false;
    const fs = { ...realFs };
    fs[op] = (...a) => {
      if (armed) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realFs[op](...a);
    };
    const pager = open(p, { fs });
    const w = pager.beginWrite();
    const id = w.allocate();
    armed = true;
    assert.throws(() => w.commit({ pages: new Map([[id, leaf(4096, id)]]), root: id }), /EIO/);
    armed = false;
    assert.throws(() => pager.read(3), PoisonedError);
    assert.throws(() => pager.beginWrite(), PoisonedError);
    pager.close();
    const again = open(p);
    assert.equal(again.meta.txid, 1);
    assert.equal(again.meta.root, 3);
    again.close();
  });
}
