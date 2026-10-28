import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"
import { NameSync, meaningful, type Session, type Link } from "../src/sync"
import type { PaneSession, Workspace } from "../src/herdr"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "herdr-sync-"))
  directories.push(directory)
  const sessions: Session[] = [{ id: "s1", title: "Project", location: { directory } }]
  const workspaces: Workspace[] = [{ workspace_id: "w1", label: "Project",
    worktree: { checkout_path: directory, is_linked_worktree: true } }]
  const panes: PaneSession[] = []
  const unlinked = new Set<string>()
  const writes: string[][] = []
  let saved: Link | false | undefined
  const deps = {
    directory,
    sessions: async () => sessions,
    getSession: async (id: string) => {
      const session = sessions.find((session) => session.id === id)
      if (!session) throw new Error("Missing session")
      return session
    },
    renameSession: async (id: string, title: string) => {
      writes.push(["session", id, title])
      sessions.find((session) => session.id === id)!.title = title
    },
    workspaces: async () => workspaces,
    panes: async () => panes,
    isUnlinked: async (id: string) => unlinked.has(id),
    setUnlinked: async (id: string, value: boolean) => { if (value) unlinked.add(id); else unlinked.delete(id) },
    renameWorkspace: async (id: string, title: string) => {
      writes.push(["workspace", id, title])
      workspaces.find((workspace) => workspace.workspace_id === id)!.label = title
    },
    load: async () => saved,
    save: async (link: Link | false | undefined) => { saved = link },
  }
  return { directory, sessions, workspaces, panes, writes, deps, sync: new NameSync(deps), saved: () => saved }
}

describe("name synchronization", () => {
  test("equal names link silently, then renames sync both ways without echo", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    expect(f.writes).toEqual([])
    expect(f.saved()).toMatchObject({ sessionID: "s1", workspaceID: "w1" })
    f.sessions[0]!.title = "Session title"
    await f.sync.sessionRenamed("s1")
    await f.sync.workspaceRenamed("w1", "Session title")
    expect(f.writes).toEqual([["workspace", "w1", "Session title"]])
    f.workspaces[0]!.label = "Herdr title"
    await f.sync.workspaceRenamed("w1", "Herdr title")
    await f.sync.sessionRenamed("s1")
    expect(f.writes).toEqual([
      ["workspace", "w1", "Session title"], ["session", "s1", "Herdr title"],
    ])
  })

  test("startup conflicts do not overwrite either name, even with a persisted link", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    f.workspaces[0]!.label = "Edited while disconnected"
    const restarted = new NameSync(f.deps)
    await restarted.reconcile()
    expect(f.writes).toEqual([])
    f.sessions[0]!.title = "Next edit"
    await restarted.sessionRenamed("s1")
    expect(f.writes).toEqual([["workspace", "w1", "Next edit"]])
  })

  test("custom labels require explicit selection of the initial winner", async () => {
    const f = await fixture()
    f.workspaces[0]!.label = "Deliberate workspace name"
    await f.sync.reconcile()
    await f.sync.sessionRenamed("s1")
    expect(f.writes).toEqual([])
    await f.sync.bind("s1", "workspace")
    expect(f.sessions[0]!.title).toBe("Deliberate workspace name")
    f.sessions[0]!.title = "Session wins"
    await f.sync.bind("s1", "session")
    expect(f.workspaces[0]!.label).toBe("Session wins")
  })

  test("first meaningful rename seeds a default checkout label, not a placeholder", async () => {
    const f = await fixture()
    f.workspaces[0]!.label = basename(f.directory)
    f.sessions[0]!.title = "New session - 2026-10-28T12:00:00Z"
    await f.sync.sessionRenamed("s1")
    expect(f.writes).toEqual([])
    f.sessions[0]!.title = "Implement feature"
    await f.sync.sessionRenamed("s1")
    expect(f.writes).toEqual([["workspace", "w1", "Implement feature"]])
  })

  test("opening a workspace with no session does nothing", async () => {
    const f = await fixture()
    f.sessions.splice(0)
    await f.sync.reconcile()
    await f.sync.workspaceRenamed("w1", "Project")
    expect(f.saved()).toBeUndefined()
    expect(f.writes).toEqual([])
  })

  test("ignores child and competing sessions; explicit ownership survives other roots", async () => {
    const f = await fixture()
    f.sessions.push({ id: "child", parentID: "s1", title: "Child task", location: { directory: f.directory } })
    await f.sync.reconcile()
    await f.sync.sessionRenamed("child")
    f.sessions.push({ id: "s2", title: "Other root", location: { directory: f.directory } })
    await f.sync.sessionRenamed("s2")
    expect(f.writes).toEqual([])
    await expect(f.sync.bind("child", "session")).rejects.toThrow("top-level")
    f.sessions[0]!.title = "Owner edit"
    await f.sync.sessionRenamed("s1")
    expect(f.workspaces[0]!.label).toBe("Owner edit")
    await f.sync.bind("s2", "session")
    expect(f.workspaces[0]!.label).toBe("Other root")
  })

  test("ambiguous top-level ownership is never inferred", async () => {
    const f = await fixture()
    f.sessions.push({ id: "s2", title: "Project", location: { directory: f.directory } })
    await f.sync.reconcile()
    await f.sync.sessionRenamed("s1")
    expect(f.saved()).toBeUndefined()
  })

  test("duplicate workspaces and generic workspaces require an explicit workspace ID", async () => {
    const f = await fixture()
    f.workspaces.push({ ...f.workspaces[0]!, workspace_id: "w2" })
    await expect(f.sync.bind("s1", "session")).rejects.toThrow("Could not tell")
    f.workspaces.splice(1)
    delete f.workspaces[0]!.worktree
    await f.sync.sessionRenamed("s1")
    expect(f.writes).toEqual([])
  })

  test("main checkouts and non-Git spaces are never synced, even when reported or requested", async () => {
    for (const kind of ["main", "non-Git"] as const) {
      const f = await fixture()
      if (kind === "main") f.workspaces[0]!.worktree!.is_linked_worktree = false
      else delete f.workspaces[0]!.worktree
      f.workspaces[0]!.label = "Misc"
      f.sessions[0]!.title = "Generated title"
      f.panes.push({ workspace_id: "w1", session_id: "s1" })
      await f.sync.reconcile()
      f.sessions[0]!.title = "Session edit"
      await f.sync.sessionRenamed("s1")
      f.workspaces[0]!.label = "Herdr edit"
      await f.sync.workspaceRenamed("w1", "Herdr edit")
      await expect(f.sync.bind("s1", "session", "w1")).rejects.toThrow("Only linked Git worktree")
      await expect(f.sync.bind("s1", "session")).rejects.toThrow("Could not tell")
      expect(f.writes).toEqual([])
      expect(f.saved()).toBeUndefined()
    }
  })

  test("a stored link to a space that is no longer eligible is dropped", async () => {
    const f = await fixture()
    await f.sync.bind("s1", "session", "w1")
    f.workspaces[0]!.worktree!.is_linked_worktree = false
    f.sessions[0]!.title = "Ignored"
    await f.sync.sessionRenamed("s1")
    expect(f.saved()).toBeUndefined()
    expect(f.writes).toEqual([])
  })

  test("explicit selection links a worktree by ID and syncs both directions after reload", async () => {
    const f = await fixture()
    f.workspaces[0]!.worktree!.checkout_path = "/elsewhere"
    f.workspaces[0]!.label = "Misc"
    await f.sync.bind("s1", "workspace", "w1")
    expect(f.sessions[0]!.title).toBe("Misc")
    expect(f.saved()).toMatchObject({ explicitWorkspace: true, workspaceID: "w1" })
    const restarted = new NameSync(f.deps)
    await restarted.reconcile()
    f.sessions[0]!.title = "Organize notes"
    await restarted.sessionRenamed("s1")
    expect(f.workspaces[0]!.label).toBe("Organize notes")
    f.workspaces[0]!.label = "Workspace edit"
    await restarted.workspaceRenamed("w1", "Workspace edit")
    expect(f.sessions[0]!.title).toBe("Workspace edit")
    await restarted.bind("s1", "session")
    expect(f.saved()).toMatchObject({ explicitWorkspace: true })
    await restarted.unlink("s1")
    f.sessions[0]!.title = "Unlinked edit"
    await restarted.sessionRenamed("s1")
    expect(f.workspaces[0]!.label).toBe("Workspace edit")
  })

  test("explicit IDs resolve duplicate paths and may target a space with unrelated Git metadata", async () => {
    const f = await fixture()
    f.workspaces.push({ ...f.workspaces[0]!, workspace_id: "w2", label: "Other" })
    await f.sync.bind("s1", "session", "w2")
    expect(f.writes).toEqual([["workspace", "w2", "Project"]])
    f.workspaces[1]!.worktree = { checkout_path: "/unrelated", is_linked_worktree: true }
    f.sessions[0]!.title = "Selected only"
    await f.sync.sessionRenamed("s1")
    expect(f.workspaces[1]!.label).toBe("Selected only")
    expect(f.workspaces[0]!.label).toBe("Project")
  })

  test("invalid explicit IDs and children cannot replace an existing link", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    const saved = f.saved()
    await expect(f.sync.bind("s1", "session", "missing")).rejects.toThrow("not found")
    f.sessions.push({ id: "child", parentID: "s1", title: "Child", location: { directory: f.directory } })
    await expect(f.sync.bind("child", "session", "w1")).rejects.toThrow("top-level")
    expect(f.saved()).toEqual(saved)
    expect(f.writes).toEqual([])
  })

  test("explicit links expire on closure, moves or deletion without auto-linking an unmatched space", async () => {
    for (const change of ["closure", "move", "deletion"] as const) {
      const f = await fixture()
      f.workspaces[0]!.worktree!.checkout_path = "/elsewhere"
      await f.sync.bind("s1", "workspace", "w1")
      if (change === "closure") f.workspaces.splice(0)
      if (change === "move") f.sessions[0]!.location.directory = "/"
      if (change === "deletion") f.sessions.splice(0)
      f.sessions.push({ id: "s2", title: "Project", location: { directory: f.directory } })
      await f.sync.reconcile()
      expect(f.saved()).toBeUndefined()
      await f.sync.sessionRenamed("s2")
      expect(f.writes).toEqual([])
    }
  })

  test("an explicit link still ignores startup conflicts and competing sessions", async () => {
    const f = await fixture()
    f.workspaces[0]!.worktree!.checkout_path = "/elsewhere"
    await f.sync.bind("s1", "session", "w1")
    f.workspaces[0]!.label = "Offline edit"
    f.sessions.push({ id: "s2", title: "Other", location: { directory: f.directory } })
    const restarted = new NameSync(f.deps)
    await restarted.reconcile(true)
    await restarted.workspaceRenamed("w1", "Offline edit")
    await restarted.sessionRenamed("s2")
    expect(f.writes).toEqual([])
    f.sessions[0]!.title = "Owner edit"
    await restarted.sessionRenamed("s1")
    expect(f.workspaces[0]!.label).toBe("Owner edit")
  })

  test("moving or deleting the owner invalidates the link", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    const other = join(f.directory, "other")
    await mkdir(other)
    f.sessions[0]!.location.directory = other
    await f.sync.workspaceRenamed("w1", "Project")
    expect(f.saved()).toBeUndefined()
    expect(f.writes).toEqual([])
    f.sessions[0]!.location.directory = f.directory
    await f.sync.reconcile()
    f.sessions.splice(0)
    await f.sync.reconcile()
    expect(f.saved()).toBeUndefined()
  })

  test("canonical matching handles symlinks, never prefix matches", async () => {
    const f = await fixture()
    const alias = `${f.directory}-alias`
    directories.push(alias)
    await symlink(f.directory, alias)
    f.workspaces[0]!.worktree!.checkout_path = alias
    await f.sync.reconcile()
    expect(f.saved()).toMatchObject({ sessionID: "s1" })
    f.workspaces[0]!.worktree!.checkout_path = join(f.directory, "missing")
    await f.sync.reconcile()
    expect(f.saved()).toBeUndefined()
  })

  test("unlink is durable and explicit linking enables synchronization again", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    await f.sync.unlink("s1")
    const restarted = new NameSync(f.deps)
    await restarted.reconcile()
    f.sessions[0]!.title = "Ignored"
    await restarted.sessionRenamed("s1")
    expect(f.saved()).toBe(false)
    expect(f.writes).toEqual([])
    await restarted.bind("s1", "session")
    expect(f.workspaces[0]!.label).toBe("Ignored")
  })

  test("a delayed workspace echo cannot roll back a newer session edit", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    f.sessions[0]!.title = "First"
    await f.sync.sessionRenamed("s1")
    f.sessions[0]!.title = "Second"
    await f.sync.workspaceRenamed("w1", "First")
    await f.sync.sessionRenamed("s1")
    expect(f.sessions[0]!.title).toBe("Second")
    expect(f.workspaces[0]!.label).toBe("Second")
    expect(f.writes.every((write) => write[0] === "workspace")).toBe(true)
  })

  test("stale workspace events and stopped instances cannot write", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    f.workspaces[0]!.label = "Latest"
    await f.sync.workspaceRenamed("w1", "Obsolete")
    f.sync.stop()
    await f.sync.workspaceRenamed("w1", "Latest")
    expect(f.writes).toEqual([])
  })

  test("subscription replay and reconnect baselines never resolve name conflicts", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    f.workspaces[0]!.label = "Edited offline"
    await f.sync.reconcile(true)
    await f.sync.workspaceRenamed("w1", "Edited offline")
    expect(f.sessions[0]!.title).toBe("Project")
    expect(f.writes).toEqual([])
    f.workspaces[0]!.label = "Live change"
    // Periodic validation must not consume a queued live edit.
    await f.sync.reconcile()
    await f.sync.workspaceRenamed("w1", "Live change")
    expect(f.sessions[0]!.title).toBe("Live change")
  })

  test("failed API writes surface and can be retried on the next rename", async () => {
    const f = await fixture()
    let fail = true
    const sync = new NameSync({ ...f.deps, renameWorkspace: async (id, title) => {
      if (fail) throw new Error("Unavailable")
      await f.deps.renameWorkspace(id, title)
    } })
    await sync.reconcile()
    f.sessions[0]!.title = "Retry me"
    await expect(sync.sessionRenamed("s1")).rejects.toThrow("Unavailable")
    expect(f.workspaces[0]!.label).toBe("Project")
    fail = false
    await sync.sessionRenamed("s1")
    expect(f.workspaces[0]!.label).toBe("Retry me")
  })

  test("Herdr-reported sessions link a worktree in another directory and the custom label wins first", async () => {
    const f = await fixture()
    f.workspaces[0]!.worktree!.checkout_path = "/elsewhere"
    f.workspaces[0]!.label = "Misc"
    f.sessions[0]!.title = "Generated title"
    f.panes.push({ workspace_id: "w1", session_id: "s1" })
    await f.sync.reconcile()
    expect(f.writes).toEqual([["session", "s1", "Misc"]])
    await f.sync.sessionRenamed("s1")
    expect(f.writes.length).toBe(1)
    f.sessions[0]!.title = "Session edit"
    await f.sync.sessionRenamed("s1")
    expect(f.workspaces[0]!.label).toBe("Session edit")
    f.workspaces[0]!.label = "Herdr edit"
    await f.sync.workspaceRenamed("w1", "Herdr edit")
    expect(f.sessions[0]!.title).toBe("Herdr edit")
    expect(f.saved()).toBeUndefined()
  })

  test("a reported session waits for a real title and replaces a default directory label", async () => {
    const f = await fixture()
    f.workspaces[0]!.label = basename(f.directory)
    f.sessions[0]!.title = "New session - 2026-10-28T12:00:00Z"
    f.panes.push({ workspace_id: "w1", session_id: "s1" })
    await f.sync.reconcile()
    expect(f.writes).toEqual([])
    f.sessions[0]!.title = "Implement feature"
    await f.sync.sessionRenamed("s1")
    expect(f.writes).toEqual([["workspace", "w1", "Implement feature"]])
  })

  test("many sessions in one checkout each sync with the workspace that runs them", async () => {
    const f = await fixture()
    f.sessions.push({ id: "s2", title: "Second", location: { directory: f.directory } })
    f.workspaces.push({ ...f.workspaces[0]!, workspace_id: "w2", label: "Second" })
    f.panes.push({ workspace_id: "w1", session_id: "s1" }, { workspace_id: "w2", session_id: "s2" },
      { workspace_id: "w3", session_id: "elsewhere" })
    await f.sync.reconcile()
    f.sessions[1]!.title = "Second edit"
    await f.sync.sessionRenamed("s2")
    f.workspaces[0]!.label = "First edit"
    await f.sync.workspaceRenamed("w1", "First edit")
    expect(f.writes).toEqual([["workspace", "w2", "Second edit"], ["session", "s1", "First edit"]])
  })

  test("ambiguous pane reports and unlinked sessions are never synced", async () => {
    const f = await fixture()
    f.sessions.push({ id: "s2", title: "Other", location: { directory: f.directory } })
    f.panes.push({ workspace_id: "w1", session_id: "s1" }, { workspace_id: "w1", session_id: "s2" })
    await f.sync.reconcile()
    f.sessions[0]!.title = "Edit"
    await f.sync.sessionRenamed("s1")
    expect(f.writes).toEqual([])
    f.panes.splice(1)
    await f.sync.unlink("s1")
    const restarted = new NameSync(f.deps)
    await restarted.sessionRenamed("s1")
    expect(f.writes).toEqual([])
    await restarted.bind("s1", "session")
    expect(f.workspaces[0]!.label).toBe("Edit")
    f.sessions[0]!.title = "Relinked"
    await restarted.sessionRenamed("s1")
    expect(f.workspaces[0]!.label).toBe("Relinked")
  })

  test("a stored link yields when Herdr reports another session in that workspace", async () => {
    const f = await fixture()
    await f.sync.reconcile()
    expect(f.saved()).toMatchObject({ sessionID: "s1" })
    f.panes.push({ workspace_id: "w1", session_id: "elsewhere" })
    f.sessions[0]!.title = "Not mine"
    await f.sync.sessionRenamed("s1")
    expect(f.saved()).toBeUndefined()
    expect(f.writes).toEqual([])
    await expect(f.sync.bind("s1", "session", "w1")).rejects.toThrow("different OpenCode session")
  })

  test("meaningful titles retain exact spelling but reject empty/default names", () => {
    for (const title of [undefined, "", "  ", "New session", "Child session - date"]) expect(meaningful(title)).toBe(false)
    expect(meaningful("GRR-1234: Fix → Deploy")).toBe(true)
  })
})
