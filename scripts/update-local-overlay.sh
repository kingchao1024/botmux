#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo_dir"

if [[ $(git branch --show-current) != "local/s1-overlay" ]]; then
  echo "error: run this from branch local/s1-overlay" >&2
  exit 2
fi
if [[ -n $(git status --porcelain) ]]; then
  echo "error: worktree is not clean" >&2
  exit 2
fi
if [[ ! -d node_modules ]]; then
  echo "error: node_modules is absent; prepare dependencies in the canonical checkout first" >&2
  exit 2
fi

git fetch origin master --tags
GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-TRAE CLI}" \
GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-noreply@bytedance.com}" \
GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-TRAE CLI}" \
GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-noreply@bytedance.com}" \
  git rebase origin/master

bun_cmd=(npx --yes bun@1.4.0)
"${bun_cmd[@]}" run test -- \
  test/api-only-mode-wiring.test.ts \
  test/ask-card.test.ts \
  test/ask-broker.test.ts \
  test/ask-api.test.ts \
  test/ask-args.test.ts \
  test/ask-cli.test.ts \
  test/ask-receipt.test.ts \
  test/ask-receipt-authority-boundary.test.ts \
  test/ask-receipt-command.test.ts \
  test/ask-receipt-key.test.ts \
  test/ask-receipt-startup-order.test.ts \
  test/ask-card-event-claim-store.test.ts \
  test/ask-persist-store-atomicity.test.ts \
  test/ask-resume-restart.test.ts \
  test/ask-s1-daemon-route.test.ts \
  test/ask-ordinary-daemon-route.test.ts \
  test/bot-registry.test.ts \
  test/daemon-discovery.test.ts \
  test/device-isolation-activation-client.test.ts \
  test/device-isolation-daemon-ipc.test.ts \
  test/device-isolation-daemon.test.ts \
  test/device-isolation-roster.test.ts \
  test/daemon-discovery.test.ts \
  test/event-dispatcher.test.ts \
  test/fleet-runtime.test.ts \
  test/fleet-runtime-spawn-env.test.ts \
  test/fleet-supervisor.integration.test.ts \
  test/fs-policy.test.ts \
  test/index-supervisor-env-boundary.test.ts \
  test/model-catalog.test.ts \
  test/platform-device-isolation.test.ts \
  test/plugin-card-action-gateway.test.ts \
  test/plugin-card-action-gateway.integration.test.ts \
  test/plugin-service-restart-lifecycle.test.ts \
  test/read-isolation.test.ts \
  test/restart-true-readiness.test.ts \
  test/secure-host-file.test.ts \
  test/session-delete-cli.test.ts \
  test/session-ready-cli.test.ts \
  test/setup-bots-store.test.ts \
  test/shutdown-supervisor-contract.test.ts
"${bun_cmd[@]}" run build

upstream_tag=$(git describe --tags --abbrev=0 --match 'v[0-9]*')
version="${upstream_tag#v}-s1overlay.$(git rev-parse --short=8 HEAD)"
candidate="$repo_dir/dist-bin/botmux-$version"
BOTMUX_VERIFY_BAKED_VERSION="$version" \
  "${bun_cmd[@]}" run build:bun -- --target bun-linux-x64 --out "$candidate"
node scripts/smoke-bun-binary.mjs "$candidate"
sha256sum "$candidate"
printf 'candidate=%s\n' "$candidate"
