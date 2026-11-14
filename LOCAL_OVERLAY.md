# Local Botmux development checkout

This checkout is a private development and deployment workspace. Local commits,
experiments, and temporary uncommitted changes may live here directly.

- `master` is the working branch. It may diverge from `origin/master` and may
  carry uncommitted changes while work is in progress.
- Botmux plugins live in separate repositories and are used for supported
  extension points: skills, MCP servers, CLI commands, dashboard pages, host
  services, and plugin-owned card actions.

## Remotes

- `origin` — private repository (`code.byted.org:wangchao.2048/botmux`),
  preferred source for this workspace.
- `upstream` — GitHub fork reference, useful for comparison.
- `botmux-public` — public Botmux upstream (`deepcoldy/botmux`).

Fetching or merging is an explicit action. Use a separate worktree for a clean
comparison when needed; preserve in-progress changes in this checkout.

## Plugins first

The S1 Ask receipt/authority path and the built-in Ask card renderer cannot be
plugins in Botmux 3.18.13. Botmux reserves the `ask_` callback namespace and has
no general daemon/worker hook. Those changes therefore remain in this checkout.

## Legacy overlay update script

`scripts/update-local-overlay.sh` encodes an older workflow that required a
clean worktree and an overlay integration branch rebased on `origin/master`.
It is optional and is not required for ordinary development.

## Build and deployment

The root fleet's user-level `botmux.service` executes this checkout's
`dist/cli.js` directly. Check the running entrypoint before changing build
artifacts. Build validation should use an isolated copy while that fleet is
live; an in-place `bun run build` replaces its deployment artifact.

Publishing or restarting production requires explicit authorization and
validation. Keep the prior artifact and configuration backup until the fleet,
Dashboard, session registry, and a real Lark send/Ask callback are verified.

On Linux hosts where `botmux.service` is enabled, restart production only with
`systemctl --user restart botmux.service`. Do not run `botmux start`,
`botmux restart`, or `bun run daemon:restart` from a BotMux/Trae session: the
detached supervisor can inherit that transient session scope and be killed when
the session ends while the oneshot unit still reports `active (exited)`. After a
restart, verify both `botmux status` and `/proc/<supervisor-pid>/cgroup`; the live
supervisor must belong to `botmux.service`, not `botmux-session-*.scope`.
