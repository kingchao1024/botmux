# BotMux Residual Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers execute (recommended) or superpowers execute-batch to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining BotMux project-control defects and historical lifecycle debt without rewriting failure evidence or changing the current production runtime before a separate release authorization.

**Architecture:** Keep the project JSON store as the durable owner. Add compact immutable reviewer-replacement receipts beside the bounded human-readable audit, serialize policy reads and project mutation under the existing chat-scoped lock, and model historical failure archival as a distinct `cancelled` terminal with retained failure metadata. Repair the two baseline RPC overlap failures at the worker flush scheduler, then use existing gate lifecycle commands for live administrative closure after an authorized release.

**Tech Stack:** TypeScript, Bun 1.4.2, Vitest, atomic JSON stores, cross-process file locks, Lark daemon IPC.

**Authorization override:** The user explicitly deferred commit, push, merge, CLI claim, restart, and deployment. The plan therefore freezes hashes after each task and has one final commit/release authorization gate instead of per-task commits.

---

## File map

- `src/services/project-group-store.ts`: durable types, validation, cancelled/archive metadata, open-summary semantics.
- `src/services/project-coordinator.ts`: reviewer receipt fingerprinting, exact replay, policy lock, archive CAS action.
- `src/services/group-collaboration-mode-store.ts`: existing shared lock contract; no new state owner.
- `src/core/dashboard-ipc-server.ts`: current-human authorization for archive and live policy derivation.
- `src/cli/project-args.ts`: parse `project workstream archive`.
- `src/cli.ts`: public help and archive result reporting.
- `src/im/lark/project-group-card.ts`: cancelled status presentation and open-workstream filtering.
- `src/worker.ts`: deferred `flushPending` kick after the current flush mutex is released.
- `test/project-group-mode.test.ts`: store/coordinator RED→GREEN coverage.
- `test/project-group-mode-api.test.ts`: daemon authorization and policy-source coverage.
- `test/cli-root-help.test.ts`: public command help.
- `test/worker-codex-rpc-overlap.integration.test.ts`: two existing baseline REDs; assertions remain unchanged.
- `docs/superpowers/specs/2026-10-15-botmux-residual-closure-design.md`: approved design, force-added only at the authorized commit gate.
- `docs/xdev/superpowers/plans/2026-10-15-botmux-residual-closure.md`: this plan.

### Task 1: Freeze the batch identity

**Files:**
- Verify: repository and worktree metadata
- Verify: `/root/.botmux/data/development-standards/v1/process-contract.md`

- [ ] **Step 1: Verify the fixed workspace identity**

Run:

```bash
pwd
git rev-parse --show-toplevel
git rev-parse HEAD
git rev-parse origin/master
git status --short --branch
/root/.bun/bin/bun --version
```

Expected: cwd and top-level are the residual-close worktree, both revisions are `fdefb9030f3085b0c414708690e3f5d294058d32`, the branch is `botmux-residual-close-20261015`, and Bun is `1.4.2`.

- [ ] **Step 2: Verify shared dependencies without installing**

Run:

```bash
test "$(readlink -f node_modules)" = "/data00/home/root/workspaces/botmux-upstream/node_modules"
test -x node_modules/vitest/vitest.mjs
```

Expected: both commands exit 0. Do not run any install command.

- [ ] **Step 3: Record the initial candidate identity**

Run:

```bash
git diff --binary origin/master > /tmp/botmux-residual-close-initial.patch
sha256sum /tmp/botmux-residual-close-initial.patch \
  docs/superpowers/specs/2026-10-15-botmux-residual-closure-design.md \
  docs/xdev/superpowers/plans/2026-10-15-botmux-residual-closure.md
```

Expected: the patch contains only the approved design and plan; save all three SHA-256 values in the delivery record.

### Task 2: Preserve reviewer replacement replay receipts beyond audit eviction

**Files:**
- Modify: `src/services/project-group-store.ts`
- Modify: `src/services/project-coordinator.ts`
- Test: `test/project-group-mode.test.ts`

- [ ] **Step 1: Write the eviction replay RED**

Add a test after `bounds reviewer replacement audit history and validates it on reload`:

```ts
it('keeps an evicted reviewer replacement operation idempotent', async () => {
  const f = fixture();
  let project = await deliveredWriteWorkstream(f);
  const firstAction = reviewerReplacement(project.revision);
  project = (await f.coordinator.runReviewerReplacement(f.context, firstAction)).project;
  let oldReviewerAppId = 'cli_reviewer_next';
  for (let index = 0; index < 33; index += 1) {
    const newReviewerAppId = `cli_after_${index}`;
    project = (await f.coordinator.runReviewerReplacement(f.context, {
      ...reviewerReplacement(project.revision), oldReviewerAppId, newReviewerAppId,
      authorizationRef: `om_after_${index}`,
      allowedReviewerAppIds: ['cli_worker', newReviewerAppId],
    })).project;
    oldReviewerAppId = newReviewerAppId;
  }
  expect(project.workstreams[0]!.reviewerReplacements).toHaveLength(32);
  const beforeReplay = project.revision;
  const replay = await f.coordinator.runReviewerReplacement(f.context, firstAction);
  expect(replay.project.revision).toBe(beforeReplay);
  expect(replay.project.workstreams[0]!.reviewerAppIds).toEqual([oldReviewerAppId]);
});
```

- [ ] **Step 2: Run the RED**

Run:

```bash
node node_modules/vitest/vitest.mjs run --no-cache --project unit \
  test/project-group-mode.test.ts -t 'keeps an evicted reviewer replacement operation idempotent'
```

Expected: FAIL with `project_revision_conflict` because the first full audit record was evicted.

- [ ] **Step 3: Add the compact durable receipt type**

Add to `project-group-store.ts`:

```ts
export interface ProjectReviewerReplacementReceipt {
  operationFingerprint: string;
  fromRevision: number;
  toRevision: number;
}

export interface ProjectWorkstream {
  // existing fields stay unchanged
  reviewerReplacementReceipts?: ProjectReviewerReplacementReceipt[];
}
```

Validate fingerprints with `/^prr1:[a-f0-9]{64}$/`, require positive safe revisions and `toRevision === fromRevision + 1`, reject duplicates, and preserve legacy projects where the field is absent.

- [ ] **Step 4: Fingerprint the stable request and consult receipts before CAS**

Add to `project-coordinator.ts`:

```ts
function reviewerReplacementFingerprint(
  context: ProjectCoordinatorContext,
  action: ProjectWorkstreamReviewerReplacementAction,
  reason: string,
): string {
  const canonical = JSON.stringify({
    chatId: context.chatId,
    dispatchRoot: action.dispatchRoot.trim(),
    oldReviewerAppId: action.oldReviewerAppId.trim(),
    newReviewerAppId: action.newReviewerAppId.trim(),
    authorizationRef: action.authorizationRef.trim(),
    authorizedByOpenId: action.authorizedByOpenId?.trim() ?? '',
    reason,
    coordinatorSessionId: context.coordinatorSessionId,
    expectedRevision: action.expectedRevision,
  });
  return `prr1:${createHash('sha256').update(canonical).digest('hex')}`;
}
```

Inside the store mutation, compute the fingerprint after input validation. If a matching receipt exists, restore the pre-mutation project revision fields and return current durable state without checking current reviewer bindings. On a new successful replacement, append one compact receipt and keep the existing full audit slice at 32.

- [ ] **Step 5: Run focused GREEN and reload validation**

Run:

```bash
node node_modules/vitest/vitest.mjs run --no-cache --project unit \
  test/project-group-mode.test.ts -t 'reviewer replacement|evicted reviewer replacement|audit history'
```

Expected: all selected tests pass, including tampered receipt rejection.

### Task 3: Retry card projection on an exact reviewer replacement replay

**Files:**
- Modify: `src/services/project-coordinator.ts`
- Test: `test/project-group-mode.test.ts`

- [ ] **Step 1: Write the projection retry RED**

Add:

```ts
it('retries projection after durable reviewer replacement success', async () => {
  const f = fixture();
  const delivered = await deliveredWriteWorkstream(f);
  const action = reviewerReplacement(delivered.revision);
  f.transport.updateCard = vi.fn()
    .mockRejectedValueOnce(new Error('projection unavailable'))
    .mockResolvedValueOnce(undefined);
  const first = await f.coordinator.runReviewerReplacement(f.context, action);
  expect(first.projectionWarning).toBe('projection unavailable');
  const durableRevision = first.project.revision;
  const retry = await f.coordinator.runReviewerReplacement(f.context, action);
  expect(retry.project.revision).toBe(durableRevision);
  expect(retry).not.toHaveProperty('projectionWarning');
  expect(f.transport.updateCard).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the RED**

Run the test by exact name. Expected: FAIL because the replay returns before `publish`.

- [ ] **Step 3: Remove the early projection return**

Change `runReviewerReplacement` so both new commits and receipt replays call `publish`:

```ts
const applied = await this.apply(context, action);
try {
  return { project: await this.publish(context, applied) };
} catch (error) {
  return {
    project: readProjectGroup(context.dataDir, context.chatId) ?? applied,
    projectionWarning: error instanceof Error ? error.message : String(error),
  };
}
```

Do not mutate project revision merely to record projection state.

- [ ] **Step 4: Run focused GREEN**

Expected: both the new retry test and existing durable-success warning test pass.

### Task 4: Serialize reviewer policy with project mutation

**Files:**
- Modify: `src/services/project-coordinator.ts`
- Modify: `src/core/dashboard-ipc-server.ts`
- Test: `test/project-group-mode.test.ts`
- Test: `test/project-group-mode-api.test.ts`

- [ ] **Step 1: Write the policy revocation RED**

Create a fixture with project workers `cli_worker`, `cli_reviewer`, and `cli_reviewer_next`. Hold `withProjectTaskControlChatLock`, start reviewer replacement, revoke `cli_reviewer_next` through `writeGroupCollaborationMode`, then release the lock. Assert that only the operation which acquires the shared lock first can commit, and the other sees either `project_reviewer_not_allowed` or the already-committed project revision.

Use two independent async operations and the real JSON stores; do not share an in-memory mutex between them.

- [ ] **Step 2: Run the RED**

Expected: the replacement can currently commit using the stale `allowedReviewerAppIds` array after revocation.

- [ ] **Step 3: Derive policy inside the shared lock**

Wrap replacement in the existing cross-process lock:

```ts
return queued(`${context.dataDir}:${context.chatId}`, () =>
  withProjectTaskControlChatLock(context.dataDir, context.chatId, async () => {
    const mode = readGroupCollaborationMode(context.dataDir, context.chatId);
    if (mode?.mode !== 'project') throw new Error('project_mode_required');
    const allowedReviewerAppIds = [...(mode.workerAppIds ?? [])];
    return execute({ ...action, allowedReviewerAppIds });
  }));
```

Keep the project revision CAS inside `apply`. Remove Dashboard IPC injection of a pre-lock allowlist; the route may still verify project mode before calling the coordinator.

- [ ] **Step 4: Run cross-process GREEN and API tests**

Run:

```bash
node node_modules/vitest/vitest.mjs run --no-cache --project unit \
  test/project-group-mode.test.ts test/project-group-mode-api.test.ts
```

Expected: no stale-policy commit, and the daemon still strips caller-supplied trusted fields.

### Task 5: Add auditable failed-workstream archival

**Files:**
- Modify: `src/services/project-group-store.ts`
- Modify: `src/services/project-coordinator.ts`
- Modify: `src/cli/project-args.ts`
- Modify: `src/cli.ts`
- Modify: `src/core/dashboard-ipc-server.ts`
- Modify: `src/im/lark/project-group-card.ts`
- Test: `test/project-group-mode.test.ts`
- Test: `test/project-group-mode-api.test.ts`
- Test: `test/cli-root-help.test.ts`

- [ ] **Step 1: Write archive lifecycle REDs**

Cover these exact outcomes:

```ts
expect(archive(failed)).toMatchObject({
  status: 'cancelled', archivedFromStatus: 'failed',
  archiveAuthorizationRef: 'om_archive', archivedByOpenId: 'ou_authorizer',
});
expect(projectRemainingSummary(project)).toBe('无');
await expect(archive(completed)).rejects.toThrow('project_workstream_archive_state_invalid');
await expect(archiveWithStaleRevision()).rejects.toThrow('project_revision_conflict');
```

Also assert exact retry leaves revision and inode unchanged, tampered archive metadata fails reload, and completion gates still reject a cancelled source workstream.

- [ ] **Step 2: Run archive REDs**

Expected: parse/type failures because `cancelled` and archive action do not exist.

- [ ] **Step 3: Add durable types and strict validation**

Extend the status and workstream shape:

```ts
export type ProjectWorkstreamStatus =
  | 'pending' | 'in_progress' | 'in_review' | 'blocked'
  | 'completed' | 'failed' | 'cancelled';

interface ProjectWorkstreamArchive {
  archivedFromStatus: 'failed';
  archivedAt: string;
  archiveReason: string;
  archiveAuthorizationRef: string;
  archivedByOpenId: string;
}
```

Require all archive fields together only when `status === 'cancelled'`. Update remaining/open helpers to exclude `completed` and `cancelled`; do not change completion-gate success, which remains `completed/100` only.

- [ ] **Step 4: Add the coordinator action and canonical prompt**

Add `archive_workstream` with root, expected revision, authorization ref, verified actor, reason, and timestamp. Under the project store lock: validate IDs, require `failed`, apply CAS, preserve all failure evidence, set cancelled/archive fields, and make the exact same action idempotent.

Canonical prompt:

```ts
return '授权归档 BotMux 历史 failed workstream：' + JSON.stringify({
  dispatchRoot, expectedRevision, reason,
});
```

- [ ] **Step 5: Add CLI and daemon routing**

Support the concrete CLI shape `botmux project workstream archive` with required flags `--root`, `--expected-revision`, `--authorization-ref`, and `--reason`. Parser tests use root `om_failed_archive`, revision `1219`, authorization message `om_archive_authorization`, and reason `历史失败已由后续成功批次替代`.

The daemon must call `verifiedCurrentProjectHumanActor` and inject `archivedByOpenId`; caller-supplied actor fields are ignored. Add `cancelled` card metadata without changing failed styling or history text.

- [ ] **Step 6: Run archive GREEN**

Run project-group store, API, CLI help, and card tests. Expected: all pass and no existing status snapshot changes outside the new cancelled cases.

### Task 6: Repair deferred RPC flush scheduling

**Files:**
- Modify: `src/worker.ts`
- Test: `test/worker-codex-rpc-overlap.integration.test.ts`

- [ ] **Step 1: Preserve the two real REDs**

Run with an isolated tmux wrapper and no Vitest cache:

```bash
PATH=/tmp/botmux-residual-baseline-bin:/root/.bun/bin:$PATH \
node node_modules/vitest/vitest.mjs run --no-cache --project unit \
  test/worker-codex-rpc-overlap.integration.test.ts --reporter=json \
  --outputFile=/tmp/botmux-residual-overlap-red.json
```

Expected: 5/7 pass. The only failures are:

- `re-drives a trusted steer queued before a resume turn/start ACK without releasing ordinary input`
- `releases an ordinary follower when the native terminal arrives while turn/steer awaits its ACK`

The same two failures must reproduce on parent `cfc2b30d777e07a11f66e0b3c2e92bef0ebd7f8a`.

- [ ] **Step 2: Add a deferred kick owned by the flush mutex**

Add state and helper near `isFlushing`:

```ts
let flushPendingAfterCurrent = false;

function requestPendingFlush(): void {
  if (isFlushing) {
    flushPendingAfterCurrent = true;
    return;
  }
  queueMicrotask(() => { void flushPending(); });
}
```

Replace the ACK/terminal-race `queueMicrotask` calls that invoke `flushPending` while the current flush still owns the mutex with `requestPendingFlush()`.

At the end of `flushPending`:

```ts
} finally {
  isFlushing = false;
  const kick = flushPendingAfterCurrent;
  flushPendingAfterCurrent = false;
  if (kick) queueMicrotask(() => { void flushPending(); });
  if (codexAppPromptReplay.consumeAfterFlush(codexAppTurnLiveness)) {
    // existing replay body remains unchanged
  }
}
```

The flag prevents a busy-loop: only an explicit event that lost its kick while `isFlushing` was true schedules the next flush.

- [ ] **Step 3: Run overlap GREEN twice**

Run the exact isolated command twice with separate output files. Expected: 7/7 pass in both runs; no timeout increase and no changed assertion.

- [ ] **Step 4: Run adjacent worker suites**

Run worker queue merge, RPC engine, RPC wiring, worker receipt wiring, and TraeX context tests. Expected: all pass.

### Task 7: Run the complete affected gates and freeze the candidate

**Files:**
- Verify: all modified source, tests, spec, and plan
- Create outside repo: `/tmp/botmux-residual-close-delivery-record.md`

- [ ] **Step 1: Run focused and affected suites**

Run project-group suites, the seven overlap tests, all reviewer-replace direct tests, CLI help, and project card tests. Record exact pass/fail totals and exit codes.

- [ ] **Step 2: Run repository gates**

```bash
node node_modules/typescript/bin/tsc --noEmit
/root/.bun/bin/bun run check:agent
git diff --check
/root/.bun/bin/bun run build
```

Expected: every command exits 0. Build must not claim the global CLI.

- [ ] **Step 3: Run two fresh hostile rounds**

Each round uses a new `/tmp` data root and independent processes. Cover eviction replay, projection fail/retry, policy revoke race, cancelled replay/tamper, completion-gate rejection of cancelled, and both RPC ACK/terminal races. Expected: two consecutive dry rounds with no new P0/P1.

- [ ] **Step 4: Freeze identity**

Record base SHA, `git diff --binary` SHA-256, exact path set, per-file SHA-256, Bun version, build runtime ID, and every gate result in `/tmp/botmux-residual-close-delivery-record.md` using the standard delivery template.

### Task 8: Independent read-only review

**Files:**
- Review: fixed candidate only
- Evidence: `/tmp/botmux-residual-close-delivery-record.md`

- [ ] **Step 1: Start one read-only reviewer against the frozen identity**

The reviewer receives exact cwd, branch, base, patch hash, path set, per-file hashes, design, plan, RED/GREEN evidence, and required commands. It must not modify the worktree or reuse the author verdict.

- [ ] **Step 2: Close review findings**

P0/P1 return to the same writer and the same reviewer rechecks the new frozen identity. P2/P3 are recorded and stop expansion unless they affect correctness, security, or release readiness.

- [ ] **Step 3: Mark code ready only after final PASS**

Expected: independent verdict PASS, P0=0, P1=0, all hashes match, and required gates remain valid for the reviewed candidate.

### Task 9: Request commit, push, and deployment authorization

**Files:**
- No mutation before authorization

- [ ] **Step 1: Present the fixed candidate**

Report changed files, RED/GREEN, gates, independent review, commit message proposal, impact, rollback artifact plan, and production verification. Ask separately for commit/push and for deployment/restart.

- [ ] **Step 2: Commit only if authorized**

```bash
git add -f \
  docs/superpowers/specs/2026-10-15-botmux-residual-closure-design.md \
  docs/xdev/superpowers/plans/2026-10-15-botmux-residual-closure.md
git add \
  src/cli.ts \
  src/cli/project-args.ts \
  src/core/dashboard-ipc-server.ts \
  src/im/lark/project-group-card.ts \
  src/services/project-coordinator.ts \
  src/services/project-group-store.ts \
  src/worker.ts \
  test/cli-root-help.test.ts \
  test/project-group-mode-api.test.ts \
  test/project-group-mode.test.ts \
  test/worker-codex-rpc-overlap.integration.test.ts
git commit -m "fix(project): 收口评审换绑与历史任务生命周期"
```

Before commit, confirm the index path set equals the reviewed closed set. Push only after the separate push authorization.

- [ ] **Step 3: Deploy the fixed artifact only if authorized**

Use a fixed artifact, rollback snapshot, hash manifest, external systemd cutover, automatic rollback, 11/11 bot health check, runtime/tree hash verification, and cgroup verification. Do not rebuild between review and deployment unless reproducibility is re-proved.

### Task 10: Perform live administrative closure

**Files:**
- Mutate only through supported CLI/daemon routes

- [ ] **Step 1: Archive the nine historical failed workstreams**

For each root, generate the exact canonical archive authorization text from the deployed CLI, obtain a fresh human message, then run archive with the current project revision. After each operation, re-read the project and verify `status=cancelled`, `archivedFromStatus=failed`, unchanged evidence, and no open-count contribution.

- [ ] **Step 2: Retire or replace the completion gate**

Run `botmux project gate status`, derive the exact gate fingerprint, send the canonical retire/replace authorization prompt, and execute the supported command with that exact message ID. Keep the abandoned canary tombstone and replacement relationship intact.

- [ ] **Step 3: Reconcile durable state**

Verify BotMux workstream counts, completion gates, TaskControl active tasks, human-action, coordinator-action, project card warnings, whiteboard, online document, and Meego. Any stale projection is corrected from durable state; no JSON or SQLite direct edit is allowed.

- [ ] **Step 4: Final production report**

Report code identity, deployed runtime, nine archive receipts, gate lifecycle receipt, open workstream count, ledger counts, rollback path, and current live observation. Distinguish code ready, deployed, and production passed.
