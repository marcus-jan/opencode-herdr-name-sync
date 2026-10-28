# OpenCode Herdr Name Sync

An OpenCode V2 server plugin that keeps an owning session's title and a Herdr
workspace's display label in sync, in both directions. It never renames a Git
branch or checkout directory.

## Status

Early release with Bun tests. Only **linked Git worktree** workspaces sync. Main
checkouts and non-Git spaces (such as **Misc**) keep their own names and are never
renamed. Version 0.3.x pairs worktrees with the OpenCode session that Herdr (0.9+)
reports for each pane, with no command needed. Releases are distributed through
GitHub, not npm.

## Install

Install the tagged GitHub release globally in OpenCode:

```sh
opencode plugin add 'github:marcus-jan/opencode-herdr-name-sync#v0.3.1'
```

This adds the package to `~/.config/opencode/opencode.json(c)`. Herdr must be
running. With Herdr 0.9+ and its OpenCode integration (installed by Herdr in
`~/.config/opencode/plugins/herdr-agent-state.js`), every linked worktree
workspace that runs an OpenCode session is linked automatically.

## Use locally

```sh
bun install
bun run check
```

Add the local package directory to `plugins` in your OpenCode `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-herdr-name-sync",
      "options": {
        // Optional: otherwise HERDR_SOCKET_PATH is used, then
        // $XDG_CONFIG_HOME/herdr/herdr.sock (default ~/.config/herdr/herdr.sock).
        "socketPath": "/absolute/path/to/herdr.sock",
      },
    },
  ],
}
```

OpenCode reloads configuration changes automatically; `/reload` can force a
reload. No Herdr CLI subprocess is required at runtime.

### Choose the owning session

In the session you want to link, use one of these slash commands:

| Command | Initial conflict resolution |
| --- | --- |
| `/herdr-link-session [workspace-ID]` | Keep this session's title; rename the workspace. |
| `/herdr-link-workspace [workspace-ID]` | Keep the workspace label; rename this session. |
| `/herdr-unlink` | Stop syncing this session (durably) until an explicit link command. |

Explicit linking can transfer ownership from another top-level session. Only
future changes to the chosen owner sync. Links and the unlinked state persist in
OpenCode's plugin storage. Commands report invalid or ambiguous matches as errors.

### Linking a specific worktree by ID

Find the worktree workspace's ID with `herdr workspace list`, then pass that ID:

```text
/herdr-link-workspace w0
```

This keeps that worktree's current label and gives it to the current session. Use
`/herdr-link-session w0` instead to keep the session title. Main checkouts and
non-Git spaces are rejected.

An explicit ID bypasses path matching and resolves duplicate-checkout
ambiguity. The selection is saved, so future edits sync in both directions and
link commands can omit the ID afterward, including after reload. The owner must
remain a top-level session in its original directory. Closing the workspace or
moving/deleting the owner invalidates the link. `/herdr-unlink` still stops sync.

Stored (explicit or path-matched) links are kept per OpenCode location
directory. Herdr-reported pairings take precedence: a stored link is dropped when
Herdr reports a different session in its workspace or its session in another one.

### Automatic behavior

- **Herdr-reported sessions (primary):** Herdr's OpenCode integration reports the
  root session running in each pane. A workspace whose panes report exactly one
  OpenCode session is paired with it if it is a linked worktree. On first pairing, the
  workspace label wins and is copied to the session, unless the label is still a
  default directory name, in which case the session title wins. Pairing waits
  until the session has a real (non-placeholder) title. Workspaces reporting
  several sessions, and sessions open in several workspaces, are skipped; use an
  explicit link command for those. Many sessions in one checkout can each pair
  with their own workspace. Pairings are re-read every five seconds and on each
  rename.
- **Fallbacks (older Herdr or no report):** the stored/path-matching rules below.
- **Startup:** link automatically only when exactly one top-level session and one
  eligible workspace exist, and their meaningful names already match. Do not
  overwrite differing names, even when restoring a saved link.
- **New workspace without a session:** leave its label alone. The plugin does not
  create a session or start an agent.
- **First session title:** on a meaningful session rename, automatically link a
  sole top-level session if the workspace label is still the checkout directory's
  basename (or already equals the title). A custom label requires an explicit
  link command. Basename equality is a heuristic, not proof the label was never
  edited; use `/herdr-unlink` to disable automatic linking.
- **After linking:** sync subsequent session title edits/generated titles to
  Herdr, and workspace label edits back to the owner. Empty titles and OpenCode's
  `New session` / `Child session` placeholder titles are ignored.
- **Multiple sessions:** never infer an owner when multiple top-level sessions
  exist. A previously selected owner remains selected. Child/subagent sessions
  cannot own or rename a workspace.
- **Moves, deletion, closure:** validate the link against current session and
  workspace inventories before writing. Forget stale links.

## Matching and safety

Fallback path matching requires an exact canonical filesystem-path match between the session's
`location.directory` and Herdr's `worktree.checkout_path`. Symlinks are resolved;
prefix/subdirectory matches are deliberately not supported. Only linked worktrees
(`is_linked_worktree: true`) are eligible; main checkouts and workspaces without
Herdr Git metadata are always ignored, including for explicit link commands.
Without an explicit workspace ID, duplicate workspaces pointing to the same
checkout are ignored. The plugin
does **not** fall back to the server's
inherited `HERDR_WORKSPACE_ID`: a shared OpenCode server can serve many unrelated
workspaces. Each plugin instance is scoped to its own location directory.

The explicit workspace-ID selection is deliberate user input, not a guess based
on a label, focus, or server environment. It works when the worktree's checkout
path differs from the session directory.

Both directions are serialized, use current API state, and suppress echoed or
stale events. Herdr may emit existing rename notifications on subscription;
unchanged labels do not resolve startup conflicts. Herdr connections are checked
every five seconds and subscriptions are re-established after disconnects. Edits
made while disconnected are not replayed as writes; the next live edit or an
explicit link command chooses the winning name. Simultaneous edits are not a
transaction across applications; processing order determines the outcome.

Cleanup aborts the OpenCode stream, closes sockets, stops the timer and prevents
queued work from writing. Already-issued API requests may finish. Transient errors
are logged with rate limiting rather than breaking session execution. Sync runs
only while the OpenCode plugin is loaded and Herdr is reachable.

## Development

- `src/index.ts`: OpenCode plugin lifecycle, commands, persistent storage, event queue.
- `src/sync.ts`: ownership, matching and two-way synchronization policy.
- `src/herdr.ts`: bounded newline-delimited socket transport; one-shot RPC and a
  separate persistent event subscription.
- `test/`: ownership and safety tests plus fake Unix-socket transport tests.

Uses Bun, strict TypeScript and `@opencode/plugin` 2.1.4, following the repository
structure of [opencode-copilot-usage](https://github.com/marcus-jan/opencode-copilot-usage)
and [opencode-cliproxyapi-claude-usage](https://github.com/marcus-jan/opencode-cliproxyapi-claude-usage).
Version 2.1.4 subscribes to all OpenCode events and filters locally because it
does not yet expose the event-type filter described by the current V2 docs.

### Manual end-to-end test (changes display names)

1. Use a disposable Herdr linked-worktree workspace with exactly one matching checkout and
   one top-level OpenCode session; install the plugin there using the config above.
2. Set distinct session/workspace names. Confirm loading does not overwrite either.
3. Run `/herdr-link-workspace`; confirm the session adopts the workspace label.
4. Rename the session in OpenCode. Confirm the workspace follows once.
5. Rename the workspace in Herdr. Confirm the session follows once.
6. Create a second top-level session and a child session. Confirm their title
   changes cannot rename the workspace. `/herdr-link-session` can explicitly
   transfer ownership to the second top-level session.
7. Run `/herdr-unlink`; confirm renames stop, including after `/reload`.
8. Re-link, restart Herdr, and check that subscription reconnects without
    overwriting differing names. Move/delete the owner and confirm it cannot rename
    its former workspace.
9. In a main checkout or non-Git space, confirm renames never sync and
   `/herdr-link-workspace <workspace-ID>` is rejected.

Inspect Herdr's installed contract with `herdr api schema --json`.
OpenCode plugin documentation: <https://opencode.ai/v2/docs/build/plugins/server>.

## License

MIT
