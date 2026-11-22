# koibernetes

Five years working with Kubernetes. Scaled services for millions of users. Then one day I realised I didn't really understand any of it.

So I'm rebuilding Kubernetes from scratch, in plain JavaScript, one component at a time, vibe-coding my way down to the bottom to see what actually happens behind `kubectl apply`.

This is a learning project, not something to run in production.

## The plan

The build goes bottom up, one component at a time:

| # | Component | Status |
|---|---|---|
| 1 | **etcd**, the store everything else is built on | In progress |
| 2 | API server | Not started |
| 3 | kubelet | Not started |
| 4 | scheduler | Not started |
| 5 | controller-manager (ReplicaSet, Deployment) | Not started |
| 6 | metrics pipeline | Not started |
| 7 | HPA | Not started |
| 8 | kubeadm-style bootstrap | Not started |

etcd itself is built layer by layer, the same way the real one is:

| Layer | Status |
|---|---|
| WAL (write-ahead log) | Done |
| Pager (bbolt on-disk format, atomic copy-on-write commit) | Done |
| B+tree | Next |
| Backend, index, MVCC store, watch | Not started |
| gRPC API (so `etcdctl` and a real `kube-apiserver` can connect) | Not started |
| Raft | Last |

## Rules I'm holding myself to

- **Understand first.** Every piece starts as a short note on what it is, why Kubernetes needs it and how it works, before any code. Those notes live in [docs/key-knowledge/](docs/key-knowledge/).
- **Plain JavaScript.** Node, ES modules, no dependencies, no build step.
- **Tests first, and the real thing is the judge.** Where real software exists it checks our work: the pager's files must pass the real `bbolt check`, and later the real `etcdctl` and `kube-apiserver` must be able to talk to our etcd.
- **Crash on purpose.** Durability code is tested on a fake disk that loses, reorders and tears unsynced writes.

## Run the tests

```bash
npm test
```

Node 22 or newer. The bbolt oracle tests run when the `bbolt` CLI is installed (`go install go.etcd.io/bbolt/cmd/bbolt@v1.5.0`) and skip otherwise.

## Layout

```
etcd/wal/       write-ahead log
etcd/pager/     bbolt-format page file
tests/etcd/     tests, fake disk, bbolt fixtures
docs/key-knowledge/   the ideas that matter most, one note each
```
