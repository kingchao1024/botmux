# Local Botmux overlay

This checkout keeps upstream Botmux and the local production changes separate:

- `master` tracks `origin/master` and stays unmodified.
- The active overlay integration branch contains the local commits rebased on
  top of `origin/master`.
- Botmux plugins live in separate repositories and are used for supported
  extension points: skills, MCP servers, CLI commands, dashboard pages, host
  services, and plugin-owned card actions.

## Remotes and source of truth

- `origin` is the preferred synchronization source. Fetch and rebase the overlay
  from its `master` branch.
- `upstream` is the fork's primary repository reference. It is useful for
  comparison, but the overlay update script does not rebase from it by default.
- The retained overlay integration branch contains the deployable private
  changes.

The overlay integration branch stays based on `origin/master`. Publishing is an
explicit operator action after validation; the update script never pushes.

The S1 Ask receipt/authority path and the built-in Ask card renderer cannot be
plugins in Botmux 3.18.13. Botmux reserves the `ask_` callback namespace and has
no general daemon/worker hook. Those changes therefore remain in this overlay.

## Update

From the active overlay integration worktree, run:

```bash
./scripts/update-local-overlay.sh
```

The script fetches `origin/master`, rebases the local commits, runs the focused
Ask/S1 and plugin-card-action tests, builds the project, compiles a versioned
binary, and runs the compiled-binary smoke test. It does not deploy or restart
the live service and does not push the branch.

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
