// The real bbolt is the judge: files we write must pass `bbolt check`, files bbolt writes must open here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../../../etcd/pager/pager.js';
import { readHeader, FLAGS } from '../../../etcd/pager/page.js';
import { tmpFile, leaf, fixture, drainFree } from './helpers.js';

function findBbolt() {
  const candidates = [process.env.BBOLT, path.join(os.homedir(), 'go/bin/bbolt')];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  try {
    return execFileSync('which', ['bbolt'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const BBOLT = findBbolt();
const skip = BBOLT ? false : 'bbolt not found: go install go.etcd.io/bbolt/cmd/bbolt@v1.5.0, or set $BBOLT';
const bbolt = (...args) => execFileSync(BBOLT, args, { encoding: 'utf8' });

/** {pgid: type} from `bbolt pages`, e.g. { 0: 'meta', 2: 'free' } */
function pageTypes(file) {
  const out = {};
  for (const line of bbolt('pages', file).split('\n').slice(2)) {
    const [id, type] = line.trim().split(/\s+/);
    if (id) out[id] = type;
  }
  return out;
}

const count = (types) => Object.values(types).reduce((m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {});

function commitRoot(pager, marker) {
  const w = pager.beginWrite();
  const old = pager.meta.root;
  const id = w.allocate();
  w.free(old);
  w.commit({ pages: new Map([[id, leaf(pager.pageSize, id, marker)]]), root: id });
}

test('bbolt check accepts a fresh file of ours', { skip }, () => {
  const p = tmpFile();
  open(p).close();
  assert.equal(bbolt('check', p).trim(), 'OK');
  assert.deepEqual(pageTypes(p), { 0: 'meta', 1: 'meta', 2: 'freelist', 3: 'leaf' });
});

for (const pageSize of [4096, 16384]) {
  test(`bbolt check accepts our file after several commits (page size ${pageSize})`, { skip }, () => {
    const p = tmpFile();
    const pager = open(p, { pageSize });
    for (let i = 0; i < 5; i++) commitRoot(pager, `gen-${i}`);
    const w = pager.beginWrite(); // an overflow page that is allocated, committed, then freed
    const big = w.allocate(3);
    w.commit({ pages: new Map([[big, leaf(pageSize, big, '', 3)]]), root: pager.meta.root });
    const w2 = pager.beginWrite();
    w2.free(big);
    w2.commit({ pages: new Map(), root: pager.meta.root });
    const { hwm, root, freelist } = pager.meta;
    pager.close();
    assert.equal(bbolt('check', p).trim(), 'OK');
    const types = pageTypes(p);
    assert.equal(types[root], 'leaf');
    assert.equal(types[freelist], 'freelist');
    const c = count(types);
    assert.equal(c.meta, 2);
    assert.equal((c.free ?? 0) + c.freelist + c.leaf + c.meta + (c.overflow ?? 0), Object.keys(types).length);
    assert.ok(Object.keys(types).length <= hwm);
  });
}

for (const name of ['bbolt-keys-4096.db', 'bbolt-keys-16384.db']) { // gitleaks:allow (fixture file names, not a key)
  const want = JSON.parse(fs.readFileSync(fixture('expected.json'), 'utf8'))[name];

  test(`opens a real bbolt file: ${name}`, () => {
    const pager = open(fixture(name));
    const { pageSize, txid, root, freelist, hwm } = pager.meta;
    assert.deepEqual({ pageSize, txid, root, freelist, hwm }, {
      pageSize: want.pageSize, txid: want.txid, root: want.root, freelist: want.freelist, hwm: want.hwm,
    });
    assert.equal(readHeader(pager.read(root)).flags, FLAGS.leaf);
    const w = pager.beginWrite();
    assert.equal(drainFree(w, hwm).length, want.freePages);
    w.rollback();
    pager.close();
  });

  test(`our commit on a real bbolt file still passes bbolt check: ${name}`, { skip }, () => {
    const p = tmpFile();
    fs.copyFileSync(fixture(name), p);
    const pager = open(p);
    const w = pager.beginWrite();
    w.commit({ pages: new Map(), root: pager.meta.root }); // rewrites freelist and meta only
    pager.close();
    assert.equal(bbolt('check', p).trim(), 'OK');
    assert.match(bbolt('get', p, 'registry', '/registry/pods/default/pod-007'), /^round-2-0+7$/m);
  });
}
