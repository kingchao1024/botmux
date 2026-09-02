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
git rebase origin/master

bun_cmd=(npx --yes bun@1.4.0)
"${bun_cmd[@]}" run test -- \
  test/ask-card.test.ts \
  test/ask-broker.test.ts \
  test/ask-api.test.ts \
  test/ask-receipt.test.ts \
  test/ask-card-event-claim-store.test.ts \
  test/ask-s1-daemon-route.test.ts \
  test/ask-ordinary-daemon-route.test.ts \
  test/event-dispatcher.test.ts \
  test/plugin-card-action-gateway.test.ts \
  test/plugin-card-action-gateway.integration.test.ts
"${bun_cmd[@]}" run build

upstream_tag=$(git describe --tags --abbrev=0 --match 'v[0-9]*')
version="${upstream_tag#v}-s1overlay.$(git rev-parse --short=8 HEAD)"
candidate="$repo_dir/dist-bin/botmux-$version"
BOTMUX_VERIFY_BAKED_VERSION="$version" \
  "${bun_cmd[@]}" run build:bun -- --target bun-linux-x64 --out "$candidate"
node scripts/smoke-bun-binary.mjs "$candidate"
sha256sum "$candidate"
printf 'candidate=%s\n' "$candidate"
