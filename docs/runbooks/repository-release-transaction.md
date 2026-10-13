# Repository release transaction runbook

This runbook describes the offline host commands. It does not authorize a release, service restart, deployment, or barrier cancellation.

## Preconditions

Use a normal host shell, never a BotMux/Trae-managed turn. Pin the merged commit/tree, clean release worktree, artifact tree/runtime id, rollback tree/runtime id, target unit and host, independent review, required checks, authorization message, and a fresh transaction id. Recompute all hashes immediately before freeze.

The freeze request is a regular JSON file containing `workdir`, `barrierId`, `expectedRevision`, `authorizationRef`, and `snapshot`. The snapshot uses an exact schema: no field may be omitted or added. It must contain `repoKey`, `canonicalCommonDir`, `worktreePath`, `transactionId`, `commitSha`, `treeSha`, `remoteRef`, `remoteCommitSha`, `worktreeClean` (exactly `true`), `bunVersion` (exactly `1.4.2`), `buildToolchainHash`, `artifactPath`, `artifactTreeHash`, `rollbackArtifactPath`, `rollbackTreeHash`, `targetRuntimeHash`, `oldRuntimeHash`, `requiredChecksHash`, `independentReviewHash`, `deploymentPath`, `unit`, `host`, and:

```json
{
  "releaseVerification": {
    "projectChatId": "oc_...",
    "stageAdvanceFingerprint": "psa1:...",
    "completionGateId": "...",
    "expectedFleetAppIds": ["cli_..."]
  }
}
```

All mutation commands require a unique operation id. A retry of the same caller request may have a later server timestamp and still replays the durable result; changing any caller-controlled field under the same operation id is rejected. Cancellation and release additionally repeat and must match the original authorization reference. Treat an uncertain command exit as UNKNOWN and inspect durable state before retrying.

Before computing `artifactTreeHash` and `rollbackTreeHash`, place `.runtime-build-id` in both directories. Its trimmed content must equal `targetRuntimeHash` for the target artifact and `oldRuntimeHash` for the rollback artifact. The target artifact must also contain these exact-schema UTF-8 JSON files:

```json
{"schemaVersion":1,"kind":"required_checks","commitSha":"<commitSha>","treeSha":"<treeSha>","status":"passed"}
{"schemaVersion":1,"kind":"independent_review","commitSha":"<commitSha>","treeSha":"<treeSha>","verdict":"pass"}
```

Store the first record as `.botmux-required-checks.json` and the second as `.botmux-independent-review.json`. `requiredChecksHash` and `independentReviewHash` are the SHA-256 hashes of the respective raw file bytes. The artifact directory hash includes these files, so write all evidence first and compute the tree hash last. The directories and evidence files must be owned by the invoking user, must not be group- or world-writable, and must contain no symlinks.

## Freeze

```bash
node /absolute/fixed/artifact/dist/cli.js repository status --workdir /absolute/release/worktree --json
node /absolute/fixed/artifact/dist/cli.js repository freeze begin --request-file /tmp/freeze-request.json --operation-id <uuid>
node /absolute/fixed/artifact/dist/cli.js repository freeze finalize --barrier-id <id> --expected-revision <n> --operation-id <uuid>
```

`begin` linearizes against writer acquisition. `finalize` must show zero writer, a clean canonical worktree, HEAD commit/tree equal to the resolved `refs/remotes/...` commit, Bun `1.4.2`, the same package/lockfile toolchain hash, both complete artifact trees, both runtime identities, and matching required-check and independent-review evidence before it writes `frozen`. If identity, revision, writer, hash, or authorization evidence changed, cancel only with separate authorization or create a fresh freeze; never edit state JSON.

## Transaction

Set exactly:

```bash
export XDG_RUNTIME_DIR=/run/user/0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus
```

Run the fixed artifact, not a global wrapper:

```bash
node /absolute/fixed/artifact/dist/cli.js repository transaction run --request-file /tmp/transaction-request.json
node /absolute/fixed/artifact/dist/cli.js repository transaction inspect --transaction-id <id> --json
```

The runner first rejects managed-agent context and host mismatch, requires every transaction-owned request field to match the frozen snapshot, then durably creates the immutable request before entering `transaction_active`. It rejects missing bus access, an uninspectable unit, hash drift, symlinks, parent/path replacement, unknown layout, cross-filesystem swaps, stale barrier revision, and request reuse with different bytes before rename or restart. A retry with the same immutable transaction id fresh-inspects the host before replaying a successful terminal receipt, or resumes `transaction_active` from the journal without repeating confirmed rename or restart results. An unprovable intent-only outcome is durably `unknown`.

Immediately before restart, the runner writes `$BOTMUX_DATA_DIR/repository-release-probes/v1/<transactionId>.json` with the transaction id, target runtime hash, project, stage fingerprint, completion gate, and observation boundary. A daemon whose compiled runtime id equals that target may mark the probe produced only after it observes the exact stage event as dispatched and the exact gate as satisfied after the boundary. Verify requires the produced probe and the referenced project records to match byte-for-byte; an old event, another runtime, another transaction, or a descriptor whose PID start identity no longer matches `/proc` fails closed. Do not repair probe, `request.json`, `journal.ndjson`, or `receipt.json` manually.

Interpret terminal status precisely:

- `verified`: target artifact/runtime and every required live check passed.
- `rolled_back`: old artifact/runtime, service, fleet, and cgroup were verified; the barrier stays frozen.
- `rollback_failed`: automatic restoration was attempted once but residual evidence remains.
- `unknown`: journal/state conflict, damaged durable state, or an outcome that cannot be proven.

Only `verified` may advance the barrier to `released`. UNKNOWN and rollback failure require read-only evidence capture and a new human decision; do not retry with changed inputs under the same transaction id.

## Cancel or release

```bash
node /absolute/fixed/artifact/dist/cli.js repository freeze cancel --barrier-id <id> --expected-revision <n> --authorization-ref <om_...> --operation-id <uuid>
node /absolute/fixed/artifact/dist/cli.js repository release --barrier-id <id> --expected-revision <n> --authorization-ref <om_...> --operation-id <uuid>
```

Capture the final repository-control revision plus request, journal, and receipt hashes. A successful code build or offline transaction test is not production PASS.
