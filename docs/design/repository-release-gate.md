# Repository release gate

Repository-scoped write ownership is keyed by the canonical Git common directory, not by a chat, session, or linked worktree path. The stable key is
`sha256("botmux-repository-v1\0" + realpath(git-common-dir))`.

## State ownership

`$BOTMUX_DATA_DIR/repository-control/v1/<repoKey>.json` is the durable owner for one repository. All mutations run under its pinned 0700 parent and leaf lock, use a monotonically increasing revision, and retain an operation-id result for idempotent retry. The operation identity hashes caller-controlled fields only; the server observation time updates state but cannot turn an otherwise identical retry into an input conflict.

- A write dispatch must acquire the single writer lease before project reservation or seed delivery.
- Read-only work does not acquire a lease.
- Every writer generation binds its real session, generation, bot identity, dispatch root, and working directory before its first IPC message.
- Heartbeat, release, and abandon require the current lease id and fencing token. A generation exit can abandon only the exact bound generation and must carry termination evidence.
- Entering `draining` and acquiring a writer use the same durable state lock. Draining rejects new writers; finalize requires no live writer and fresh reads of the canonical release worktree. The immutable exact-schema snapshot binds repository identity, canonical worktree, transaction id, HEAD commit/tree, resolved remote ref, clean state, Bun/build toolchain, artifact and rollback paths and hashes, target and old runtime hashes, required-check and independent-review hashes, deployment path, unit, host, and live-verification identifiers. Finalize hashes both pinned artifact directories, reads their runtime identities, and validates exact-schema required-check and independent-review evidence against the frozen commit/tree. Missing, unknown, malformed, dirty, or mismatched fields fail closed.

Project reservations and workstreams keep `repositoryLeaseRef` as a reference. They do not arbitrate repository ownership. Review-only work stays lease-free; a failed review must reacquire a new fencing token before repair. Reacquisition immediately attaches that lease to the already-running worker generation before the project update; attach failure releases the new lease, and replacing the stopped prior handle prevents an old callback from releasing the new fencing token.

## Release transaction

The barrier state is `open → draining → frozen → transaction_active → released`. A successful rollback returns it to `frozen`; uncertain results remain `transaction_active`.

Each transaction owns `$BOTMUX_DATA_DIR/deployments/<transactionId>/` with a 0700 directory and 0600 files:

- `request.json` is immutable and binds repository, barrier revision, authorization, transaction id, commit/tree, artifact/rollback hashes, runtime ids, required-check and independent-review hashes, unit, host, and paths. Every transaction-owned field must equal the frozen snapshot before host adapters are constructed.
- `journal.ndjson` is the durable truth. Entries have monotonic sequence, previous hash, and their own hash. Every rename or restart records intent before the action and result after it.
- `receipt.json` is a replaceable projection rebuilt from the request and valid journal. A corrupt or truncated chain produces `unknown`, never success.

Prepare rejects managed-agent context and host mismatch, then validates the exact systemd user bus, target unit, barrier snapshot, artifact/runtime identities, known layout, and same-filesystem rename boundary before a service or directory mutation. Artifact inspection and every rename share one pinned 0700 parent and cross-process lock, reject symlinks, and reject an operation if the absolute parent path no longer names the pinned directory. Before restart, the host adapter durably publishes a transaction/runtime/time-bound release probe. A daemon running the target build may produce that probe only after it observes the exact dispatched stage-advance event and satisfied completion gate after the probe boundary. Host verification also binds each fresh daemon descriptor to the exact `/proc` process-start identity, exact fleet membership, and exact service cgroup path segment.

Persisted details redact secrets, tokens, passwords, private keys, credentials, cookies, and full environment values. Symlink, owner, mode, oversized-file, parent-replacement, input-drift, and terminal-state conflicts fail closed.

## Recovery

`old-dist/old-runtime`, `new-dist/old-runtime`, and `new-dist/new-runtime` are recognized. The immutable request is durable before the barrier enters `transaction_active`; a retry with the same transaction id and frozen inputs resumes that state. Confirmed journal results are not repeated. An incomplete intent is reconciled against the current filesystem before continuing. Restart or required verification failure enters rollback once; rollback never recursively invokes itself. Replaying a successful terminal receipt first fresh-inspects the same pinned host state and all status-specific checks; drift appends `unknown` and keeps the barrier active. `verified` requires runtime, service, fleet, cgroup, live behavior, and completion gate checks. `rolled_back` requires the old artifact/runtime plus service, fleet, and cgroup checks. Any other terminal evidence is `rollback_failed` or `unknown`.

The CLI runner is host-only and does not depend on the live daemon accepting a mutation. First deployment remains a bootstrap exception: an old daemon cannot enforce this barrier and must be drained and stopped under separate authorization before the new fixed artifact initializes it.
