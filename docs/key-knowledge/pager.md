# The pager: atomic commit by flipping one pointer

Status: implemented in `etcd/pager/` (tests in `tests/etcd/pager/`). Checked against bbolt v1.5.0 source, a real file made by it (hexdump below), and the real `bbolt check`.

## The problem

The WAL solves "survive a crash" by writing a log and fsyncing it. That is fine for a log. A database also needs the *current state*, kept as a structure you can look things up in (a B+tree). Updating a tree in place is dangerous: a crash halfway through a page write leaves a page that is neither old nor new, and a split touches several pages that must change together.

The pager is the layer that makes this safe. Its idea fits in one sentence:

> Never overwrite a page that a committed state points to. Write new pages somewhere else, then switch to them by writing one small record. Either that record is on disk and the new state is live, or it is not and the old state is untouched.

This is **copy-on-write**. bbolt (the database inside etcd) does exactly this. Kubernetes never sees it, but every `kubectl apply` ends up in a pager commit (etcd batches many writes into one commit, by default every 100 ms or 10,000 writes).

## Why Kubernetes needs it

etcd holds the whole cluster state in one file. If a crash could leave that file half-updated, the cluster loses its records of Pods, Services and Secrets. The pager guarantees a crash leaves the file at exactly the last committed state, never a mixture. The WAL gives the same promise for the log. In etcd both exist: the WAL (plus Raft) makes the write durable first, the pager's file holds the state the WAL replays into.

## The file

The file is an array of fixed-size **pages**. Page `n` lives at byte offset `n * pageSize`. Page size is chosen at creation and stored inside the file. bbolt defaults to the OS page size (16384 on Apple silicon Macs, 4096 on most Linux). We default to 4096 and read the size back from the file, so both work.

```
 page 0     page 1     page 2        page 3      page 4 ...
+---------+---------+------------+-----------+--------------
| meta A  | meta B  | freelist   | root leaf | data pages ...
+---------+---------+------------+-----------+--------------
   ^          ^
   two copies of the "which state is live" record
```

Pages 0 and 1 are always the two **meta pages**. Everything else is a data page, a freelist page, or free space. Page contents (branch and leaf pages of the B+tree) belong to the B+tree layer, not to the pager. The pager only needs to know about meta pages and the freelist.

### Page header (16 bytes, little endian, every page starts with it)

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 0 | 8 | `id` | this page's own id (a self check) |
| 8 | 2 | `flags` | `0x01` branch, `0x02` leaf, `0x04` meta, `0x10` freelist |
| 10 | 2 | `count` | number of items on the page |
| 12 | 4 | `overflow` | extra pages that follow, for a big item. A page spanning 3 pages has `overflow = 2` |

### Meta page (header, then 64 bytes of meta, then a checksum)

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 16 | 4 | `magic` | `0xED0CDAED`, marks "this is a bolt file" |
| 20 | 4 | `version` | `2` |
| 24 | 4 | `pageSize` | page size in bytes |
| 28 | 4 | `flags` | unused |
| 32 | 8 | `root.root` | page id of the root bucket's top page (the B+tree entry point) |
| 40 | 8 | `root.sequence` | bucket counter, not used by the pager |
| 48 | 8 | `freelist` | page id of the freelist page, or all ones if not stored |
| 56 | 8 | `pgid` | **high-water mark**: the first page id never yet used. Pages at or above it are unallocated file space |
| 64 | 8 | `txid` | commit counter. Higher = newer |
| 72 | 8 | `checksum` | FNV-1a 64-bit hash of bytes 16..72 (magic through txid) |

The checksum is how a half-written meta page is recognised: if the hash does not match, the page is treated as absent.

### A real file

Made with bbolt v1.5.0, page size 4096, nothing stored. Meta page 0, `xxd` output (offsets in hex):

```
00000000: 0000 0000 0000 0000 0400 0000 0000 0000   id=0, flags=0x04 (meta), count=0, overflow=0
00000010: edda 0ced 0200 0000 0010 0000 0000 0000   magic=0xED0CDAED, version=2, pageSize=0x1000, flags=0
00000020: 0300 0000 0000 0000 0000 0000 0000 0000   root.root=3, root.sequence=0
00000030: 0200 0000 0000 0000 0400 0000 0000 0000   freelist=2, pgid(high-water)=4
00000040: 0000 0000 0000 0000 eefd 8946 116e 5107   txid=0, checksum=0x07516e114689fdee
```

Meta page 1 is identical except `id=1`, `txid=1` and a different checksum. The file is 16384 bytes: page 2 is an empty freelist (flags `0x10`, count 0), page 3 is an empty root leaf (flags `0x02`). `bbolt check` and `bbolt pages` accept it: `OK`, then `0 meta, 1 meta, 2 freelist, 3 leaf`.

## Which state is live

On open, read both meta pages and discard any that fail `magic`, `version` or `checksum`. Of the survivors, the one with the **higher `txid`** is current. If only one is valid, use it. If neither is valid the file is unusable.

Page size has a chicken-and-egg problem: you need it to find page 1, but it is stored inside page 0. bbolt reads page 0 at offset 0 and takes the size from it. If page 0 is damaged it probes offsets 1 KB, 2 KB, 4 KB, ... for page 1. We copy this.

## Commit: the part that makes it atomic

A write transaction never changes an existing live page. It copies the pages it modifies to **new** page ids, bumps `txid`, and at commit does exactly this, in this order:

1. Write all the new data pages (sorted by page id so the disk writes are mostly sequential).
2. Write a fresh freelist page too (to a new location).
3. **fsync.** Now every new page is durable, but nothing points at them yet. A crash here is harmless: the old meta is still current and the new pages are just unreferenced garbage.
4. Write the **meta page**. Which of the two slots is decided by `txid % 2`, so it always overwrites the *older* meta, never the one in use. It carries the new root, freelist, high-water mark and txid.
5. **fsync.** Now the new state is live.

The order is the whole trick. The meta write is last, and it is one small write in one place. Crash cases:

| Crash happens | What is on disk | On reopen |
|---|---|---|
| before step 4 | old meta valid, new pages unreferenced | old state, as if the commit never ran |
| during step 4, meta half written | the new meta fails its checksum, the other meta is still good | old state |
| after step 4's write, before its fsync | the new meta may or may not have reached the disk | old or new state, each complete |
| after step 4's fsync | new meta valid and newer | new state |

No log is needed for this. The data pages themselves are the "log", the meta page is the commit record. This is why bbolt can omit a WAL and etcd, which needs one for Raft anyway, runs it beside.

If step 3's fsync were skipped, a power cut could reorder things so the meta reaches disk but a data page does not: a live pointer to garbage. The fsync between data and meta is mandatory. Our crash test (`tests/etcd/pager/crash.test.js`) lets the fake disk keep any subset of unsynced writes; deleting this fsync from the code makes it fail.

## Free pages and the freelist

Copy-on-write creates garbage: every commit abandons the old copies of the pages it changed. Without recycling, the file only grows. The **freelist** is the list of reusable page ids.

**Allocating** a page: take the first run of contiguous ids on the freelist that is long enough. If none, take the high-water mark (`pgid`) and move it up, growing the file. That is bbolt's `array` freelist, and ours. bbolt also has a `hashmap` freelist that indexes free runs by length; etcd can select it (`--backend-bbolt-freelist-type`, documented default `map` in etcd v3.6). The on-disk freelist page is the same either way, only the in-memory search differs.

**Freeing** is subtle. Page P, abandoned by commit N, cannot be reused immediately, because:

- a read transaction that started before N is still reading the old tree, which still uses P; and
- until commit N's meta is durable, the old state (which uses P) is still the one a crash would return to.

So freed pages go into a **pending** list tagged with the txid that freed them, and move to the real free list only once no open reader could still see them. bbolt tracks the oldest open read txid for this.

**Persistence.** Each commit writes the freelist as a page: header with `flags=0x10`, `count`, then `count` page ids as 8-byte numbers. If `count` would reach 65535 (the 16-bit maximum) the real count goes in the first 8-byte slot and `count` is set to `0xFFFF`. The stored list is free pages *plus* pending pages: after a crash no readers exist, so pending pages are free by definition. The old freelist page is itself freed (pending) at each commit, since a fresh one replaces it.

Pages 0 and 1 can never be freed or allocated. They are the metas.

## Overflow pages

A single item (a large value) can exceed one page. Then the page is allocated as `n` contiguous pages, the header on the first has `overflow = n - 1`, and the rest hold continuation bytes. Allocation needs a contiguous run, which is why the freelist searches for runs.

## What we build, and where the boundary is

Scope (agreed 2026-11-21):

- **The pager owns:** open/create a file, page size, read page *n*, write dirty pages, the page cache, both meta pages and picking the live one, the freelist (allocate, free, pending, release, persist), and `commit` with the fsync order above.
- **The B+tree layer owns:** what is inside branch and leaf pages, buckets, cursors, rebalancing, and deciding *which* pages are dirty.
- **Out of the pager:** transactions as a user concept (one writer, snapshot readers). The pager only needs the read-txid bookkeeping that decides when pending pages are released.

Node differences from bbolt:

- **No mmap.** bbolt maps the file into memory and treats page *n* as a slice. Node has no mmap, so we `fs.readSync` a page at `n * pageSize` into a `Buffer`, and keep recently used pages in our own cache. Reads then cost a copy where bbolt pays none. That is slower but not different in meaning.
- **Sync call.** bbolt calls `fdatasync` on Linux and `fsync` elsewhere. We call `fs.fsyncSync`; on Linux `fsync` is a superset of `fdatasync`.
- **Locking.** bbolt takes an OS file lock (`flock`) so only one process opens the file. Node cannot. This is the same gap as the WAL process lock, recorded in `docs/etcd/overview.md` under deferred work, and it gets solved once for both when the server exists.

## How it is tested (`tests/etcd/pager/`)

- **Oracle:** files our pager writes pass the real `bbolt check`, and `bbolt pages` lists the expected page types. Files real bbolt wrote (4096 and 16384 page sizes, with keys) open in our pager with the same meta fields, and still pass `bbolt check` after one of our commits.
- **Byte-level:** a new file is byte-identical to the one bbolt v1.5.0 creates, checksum `0x07516e114689fdee` included.
- **Crash:** power cut before every write and fsync of a commit, every subset of unsynced writes surviving, the meta write torn at every byte: always exactly the old or the new state. One meta corrupt falls back to the other; both corrupt is an error.
- **Freelist:** allocate, free, reuse; a page freed while a reader is open is not reused until the reader releases it; free and pending pages survive reopen; a freelist bigger than one page round trips.

## Where this fits

```
 etcd store (MVCC)
      |
 backend (transactions, buckets)
      |
 B+tree  ----- decides which pages change
      |
 PAGER   ----- this note: pages, metas, freelist, atomic commit
      |
 file on disk
```

Related: [linearizability.md](linearizability.md) (what the layers above must preserve), `docs/etcd/wal.md` (the other durability idea: log, fsync, then acknowledge).
