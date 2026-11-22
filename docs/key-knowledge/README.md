# Key knowledge

The ideas that decide how Kubernetes works, one note each. Concept notes for a single component live in that component's folder (`etcd/wal.md`). A note belongs here when the idea is reused across components or explains a design choice in Kubernetes itself.

Each note: what it is, why Kubernetes needs it, how we build it, and where the code is.

| Note | Idea | Used by | Status |
|---|---|---|---|
| [linearizability.md](linearizability.md) | A read after a finished write always sees it; one global order of operations | etcd, API server | Written |
| [pager.md](pager.md) | Fixed-size pages, two meta pages, copy-on-write: atomic commit without a log | etcd (bbolt), B+tree, backend | Written, implemented |

## Rules

- Short. If it needs more than a few screens, split it.
- Link to the code and tests that implement the idea.
- Add a row here when you add a note.
