# Local Botmux overlay

This checkout keeps upstream Botmux and the local production changes separate:

- `master` tracks `origin/master` and stays unmodified.
- `local/s1-overlay` contains the local commits rebased on top of upstream.
- Botmux plugins live in separate repositories and are used for supported
  extension points: skills, MCP servers, CLI commands, dashboard pages, host
  services, and plugin-owned card actions.

## Remotes and source of truth

- `origin` is the public upstream repository, `deepcoldy/botmux`. Fetch from it;
  do not publish private overlay commits there.
- `codebase` is the private repository, `wangchao.2048/botmux`, and is the sole
  remote source of truth for private overlay commits.
- Codebase `master` mirrors the clean upstream `master`.
- Codebase `local/s1-overlay` contains the deployable private overlay.
- The current upstream release anchor `v3.18.13` is mirrored to Codebase. Older
  release tags are intentionally not pushed because the repository's pre-push
  guard rejects stable tags below the current maximum version.

This checkout keeps `local/s1-overlay` based on `origin/master` for upstream
rebases, while its default push destination is `codebase`. After a successful
update and validation, publish the overlay with:

```bash
git push codebase local/s1-overlay
```

The S1 Ask receipt/authority path and the built-in Ask card renderer cannot be
plugins in Botmux 3.18.13. Botmux reserves the `ask_` callback namespace and has
no general daemon/worker hook. Those changes therefore remain in this overlay.

## Update

From the `local/s1-overlay` worktree, run:

```bash
./scripts/update-local-overlay.sh
```

The script fetches `origin/master`, rebases the local commits, runs the focused
Ask/S1 and plugin-card-action tests, builds the project, compiles a versioned
binary, and runs the compiled-binary smoke test. It does not deploy or restart
the live service. After validation, push `local/s1-overlay` to Codebase; private
overlay commits must not be pushed to `origin`.

If the rebase stops on a conflict, preserve both the upstream behavior and the
local security invariant, add the resolved files, and continue with
`git rebase --continue`. Never skip the tests after resolving a conflict.

## Deployment boundary

Validated binaries are copied to:

```text
~/.local/lib/botmux-overlay/releases/
```

The stable `current` symlink, the command wrapper, and the systemd override must
all resolve to the same binary before restarting `botmux.service`. Keep the prior
target and configuration backup until the new fleet, Dashboard HTTP endpoint,
session registry, and a real Lark send/Ask callback have been verified.
