import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"
import { NameSync, meaningful, type Session, type Link } from "../src/sync"
import type { Workspace } from "../src/herdr"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "herdr-sync-"))
  directories.push(directory)
  const sessions: Session[] = [{ id: "s1", title: "Project", location: { directory } }]
  const workspaces: Workspace[] = [{ workspace_id: "w1", label: "Project",
    worktree: { checkout_path: directory, is_linked_worktree: false } }]
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
    renameWorkspace: async (id: string, title: string) => {
      writes.push(["workspace", id, title])
      workspaces.find((workspace) => workspace.workspace_id === id)!.label = title
    },
    load: async () => saved,
    save: async (link: Link | false | undefined) => { saved = link },
  }
  return { directory, sessions, workspaces, writes, deps, sync: new NameSync(deps), saved: () => saved }
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

  test("duplicate workspaces and generic workspaces cannot be renamed", async () => {
    const f = await fixture()
    f.workspaces.push({ ...f.workspaces[0]!, workspace_id: "w2" })
    await expect(f.sync.bind("s1", "session")).rejects.toThrow("exactly one")
    f.workspaces.splice(1)
    delete f.workspaces[0]!.worktree
    await f.sync.sessionRenamed("s1")
    expect(f.writes).toEqual([])
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
    await f.sync.unlink()
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

  test("meaningful titles retain exact spelling but reject empty/default names", () => {
    for (const title of [undefined, "", "  ", "New session", "Child session - date"]) expect(meaningful(title)).toBe(false)
    expect(meaningful("GRR-1234: Fix → Deploy")).toBe(true)
  })
})
