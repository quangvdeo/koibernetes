# Linearizability

## Definition

The system behaves as if there is **one copy of the data**, and every operation takes effect **instantly at a single point in time** somewhere between its start and its finish.

Consequence: **once a write is acknowledged, every read that starts afterward sees it (or something newer).** No client ever sees time go backwards.

## The picture

Every operation has a start and a finish. Between them it has one hidden "instant" where it takes effect, called the *linearization point*.

```
time ------------------------------------------------>

A:   |---- write x=1 ----|
                    ^ takes effect somewhere in here

B:                           |---- read x ----|
```

B starts after A finished, so B **must** return 1. Anything else violates linearizability.

If operations overlap, the system may order them either way, but it must be one consistent order for everyone:

```
A:   |------ write x=1 ------|
B:        |--- read x ---|             may return 0 or 1
C:                  |--- read x ---|   if B saw 1, C must also see 1
```

Two rules summarize it:

1. **Real-time order:** if operation X finishes before Y starts, X is ordered before Y.
2. **Single history:** all clients agree on one order, and each read returns the value of the latest write in that order.

## What breaks it

A replicated database with a leader and followers, where a follower serves reads:

```
t1: client A writes x=1 to the leader        -> ack
t2: client B reads x from a lagging follower -> returns 0
```

B started after A got its ack but saw the old value. This is a **stale read**. It is not linearizable. It is allowed under weaker models such as eventual consistency.

Going backwards in time is also a violation:

```
t1: client reads x from replica 1            -> 1
t2: same client reads x from replica 2 (lag) -> 0
```

## Compared with nearby terms

| Model | Guarantee |
|---|---|
| **Eventual consistency** | If writes stop, replicas converge eventually. Reads can be stale or go backwards meanwhile. (Default DynamoDB reads.) |
| **Sequential consistency** | Everyone sees one common order, but it does not have to match real time. A read after an ack may still be stale. |
| **Serializability** | A property of *transactions*: the result equals some serial order. Says nothing about real time, so it can be stale. |
| **Linearizability** | A property of *single objects/operations*: one common order that also respects real time. |
| **Strict serializability** | Both: transactions are serializable and respect real time. |

Note: etcd's "serializable read" option is a different thing from linearizability. It means "answer from the local member, possibly stale, fast".

## How etcd achieves it

- **Writes** go through the Raft leader and are committed on a quorum. They are applied in log order, so there is one total order.
- **Reads** cannot just return the leader's local value. A deposed leader (cut off by a partition but unaware of it) could serve stale data. etcd uses **ReadIndex**:
  1. The leader records its current commit index.
  2. It confirms it is still leader: a heartbeat is acknowledged by a quorum.
  3. It waits until its applied state has reached that commit index.
  4. It serves the read.

  A newly elected leader first commits an entry of its own term (a no-op), otherwise its commit index could still be behind.

This costs a quorum round trip, which etcd shares across all reads waiting at the same time. The faster alternative, a serializable read from any member, drops the guarantee.

## Why Kubernetes cares

- **Scheduling:** the scheduler binds pod A to node 1. If a later read could still show A as unscheduled, a second scheduler might place it on node 2.
- **Optimistic concurrency:** compare-and-swap on `mod_revision` only works if everyone agrees on the single latest revision of a key.
- **List-then-watch:** a LIST must be a real point-in-time snapshot, and the revision it returns must mean the same thing everywhere.
- **Leader election:** controller-manager instances compete for one Lease object; compare-and-swap on it lets only one acquire or renew it at a time. (The holder can still be wrong after a long pause until its lease expires; leases are time based.)

Kubernetes also relaxes it on purpose: reads with `resourceVersion=0` are served from the API server's watch cache, which can be slightly stale, for performance. Writes always go to etcd. Since v1.31 (beta, on by default) consistent reads are served from the watch cache too, but only after etcd's progress notification shows the cache has caught up to etcd's current revision, so they stay linearizable.

## Implication for our implementation

For a single-node store, linearizability is nearly free: one process holds all state and one lock orders operations, so a read after a write always sees it. The difficulty only appears with replication (Raft), which we build last (step 9). The store interface should be designed so replication can be added later without changing callers.

Test idea: run many concurrent clients doing Put, Get and Txn. Record each operation's start time, end time and result, then check that some single valid ordering explains all results. This is how linearizability checkers (Jepsen's Knossos, Porcupine) work.
