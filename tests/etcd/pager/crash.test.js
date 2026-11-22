// Power-cut matrix for commit: crash before every operation of a commit, let every subset of
// the unsynced writes survive (the disk may reorder them), and tear the meta write at every byte.
// After reopen the file must be exactly state A or state B.
import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../../../etcd/pager/pager.js';
import { FakeFs, CrashSignal } from '../wal/fake-fs.js';
import { durableDir, leaf, markerOf } from './helpers.js';

const FILE = '/d/db';
const PS = 4096;

function commitRoot(pager, marker) {
  const w = pager.beginWrite();
  const old = pager.meta.root;
  const id = w.allocate();
  w.free(old);
  w.commit({ pages: new Map([[id, leaf(PS, id, marker)]]), root: id });
}

/** FakeFs holding committed state A, with the pager that wrote it still open. */
function stateA() {
  const fs = new FakeFs();
  durableDir(fs, '/d');
  const pager = open(FILE, { fs });
  commitRoot(pager, 'A');
  return { fs, pager };
}

/** Every way the unsynced writes could have reached the platter. */
function survivals(pending) {
  const out = [];
  for (let mask = 0; mask < 1 << pending.length; mask++) {
    const picked = pending.filter((_, i) => mask & (1 << i));
    out.push(picked);
    const m = picked.findIndex((w) => w.pos === 0 || w.pos === PS); // a meta slot
    if (m >= 0) {
      for (let cut = 1; cut < 80; cut++) {
        out.push(picked.map((w, i) => (i === m ? { pos: w.pos, data: w.data.subarray(0, cut) } : w)));
      }
    }
  }
  return out;
}

/** Runs the matrix; returns the cases that ended in neither A nor B. */
function matrix({ skipFirstCommitFsync = false } = {}) {
  const bad = [];
  let cases = 0;
  for (let k = 0; ; k++) {
    const probe = stateA();
    const { fs, pager } = probe;
    if (skipFirstCommitFsync) {
      const first = fs.fileFsyncCount;
      fs.skipFileFsync = (n) => n === first;
    }
    fs.crashAtOp = k;
    let crashed = false;
    try {
      commitRoot(pager, 'B');
    } catch (e) {
      if (!(e instanceof CrashSignal)) throw e;
      crashed = true;
    }
    const pending = fs.pendingWrites(FILE).map((w) => ({ pos: w.pos, data: Buffer.from(w.data) }));
    for (const keep of survivals(pending)) {
      cases++;
      const { fs: f2 } = rebuild(k, skipFirstCommitFsync);
      f2.crash((p) => (p === FILE ? keep : []));
      let state;
      try {
        const reopened = open(FILE, { fs: f2 });
        state = `${reopened.meta.txid}:${markerOf(reopened.read(reopened.meta.root))}`;
        reopened.close();
      } catch (e) {
        state = `open failed: ${e.message}`;
      }
      if (state !== '2:A' && state !== '3:B') bad.push({ k, writes: keep.map((w) => [w.pos, w.data.length]), state });
    }
    if (!crashed) break;
  }
  return { bad, cases };
}

// The FakeFs state after a crash is consumed by crash(), so replay the same run for each case.
function rebuild(k, skipFirstCommitFsync) {
  const { fs, pager } = stateA();
  if (skipFirstCommitFsync) {
    const first = fs.fileFsyncCount;
    fs.skipFileFsync = (n) => n === first;
  }
  fs.crashAtOp = k;
  try { commitRoot(pager, 'B'); } catch (e) { if (!(e instanceof CrashSignal)) throw e; }
  return { fs };
}

test('a power cut anywhere in a commit leaves exactly the old or the new state', () => {
  const { bad, cases } = matrix();
  assert.ok(cases >= 85, `only ${cases} cases`); // 4 data-write subsets + meta absent/full + 79 tear points
  assert.deepEqual(bad, []);
});

test('harness check: without the data fsync the matrix finds a broken state', () => {
  const { bad } = matrix({ skipFirstCommitFsync: true });
  assert.ok(bad.length > 0, 'the crash model failed to catch a missing fsync');
});
