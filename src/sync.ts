import { realpath } from "node:fs/promises"
import { basename } from "node:path"
import type { Workspace } from "./herdr"

export interface Session {
  id: string
  parentID?: string
  title?: string
  location: { directory: string }
}

export interface Link {
  sessionID: string
  workspaceID: string
  directory: string
  explicitWorkspace?: boolean
}

export interface SyncDependencies {
  directory: string
  sessions(): Promise<readonly Session[]>
  getSession(id: string): Promise<Session>
  renameSession(id: string, title: string): Promise<void>
  workspaces(): Promise<Workspace[]>
  renameWorkspace(id: string, title: string): Promise<void>
  load(): Promise<Link | false | undefined>
  save(link: Link | false | undefined): Promise<void>
}

export function meaningful(title: string | undefined): title is string {
  return !!title?.trim() && !/^(?:New session|Child session)(?:\s*[-–—].*)?$/i.test(title)
}

export async function canonical(directory: string): Promise<string | undefined> {
  try { return await realpath(directory) } catch { return undefined }
}

// All entrypoints are serialized by the adapter. Always read current state,
// rather than trusting queued event titles: echoed/stale events then become
// no-ops instead of changing a newer title back.
export class NameSync {
  private link?: Link
  private loaded = false
  private stopped = false
  private autoLink = true
  private sessionEcho?: string
  private workspaceLabels = new Map<string, string>()

  constructor(private deps: SyncDependencies) {}

  stop() { this.stopped = true }

  private async snapshot() {
    if (this.stopped) return
    const directory = await canonical(this.deps.directory)
    if (!directory) return
    const [sessions, workspaces] = await Promise.all([this.deps.sessions(), this.deps.workspaces()])
    const roots: Session[] = []
    for (const session of sessions) {
      if (!session.parentID && await canonical(session.location.directory) === directory) roots.push(session)
    }
    const matches: Workspace[] = []
    for (const workspace of workspaces) {
      if (workspace.worktree && await canonical(workspace.worktree.checkout_path) === directory) matches.push(workspace)
    }
    if (!this.loaded) {
      const saved = await this.deps.load()
      this.autoLink = saved !== false
      this.link = saved || undefined
      this.loaded = true
    }
    // Explicit selection does not require Git metadata. Without it, duplicate
    // checkout paths are ambiguous and must never be guessed from environment.
    let workspace = this.link?.explicitWorkspace ?
      workspaces.find((item) => item.workspace_id === this.link!.workspaceID) :
      matches.length === 1 ? matches[0] : undefined
    const owner = roots.find((session) => session.id === this.link?.sessionID)
    if (this.link && (!workspace || !owner || this.link.directory !== directory ||
      this.link.workspaceID !== workspace.workspace_id)) {
      await this.deps.save(undefined)
      this.link = undefined
      workspace = matches.length === 1 ? matches[0] : undefined
    }
    if (this.stopped) return
    return { directory, roots, workspace, workspaces }
  }

  private async remember(session: Session, workspace: Workspace, directory: string, explicitWorkspace = false) {
    const link: Link = { sessionID: session.id, workspaceID: workspace.workspace_id, directory,
      ...(explicitWorkspace ? { explicitWorkspace: true } : {}) }
    await this.deps.save(link)
    this.link = link
    this.sessionEcho = undefined
    this.autoLink = true
    this.workspaceLabels.set(workspace.workspace_id, workspace.label)
  }

  async reconcile(resetBaseline = false) {
    const state = await this.snapshot()
    if (state?.workspace && (resetBaseline || !this.workspaceLabels.has(state.workspace.workspace_id))) {
      this.workspaceLabels.set(state.workspace.workspace_id, state.workspace.label)
    }
    if (!state?.workspace || this.link || !this.autoLink || state.roots.length !== 1) return
    const session = state.roots[0]!
    // Startup only establishes ownership when no names need changing.
    if (meaningful(session.title) && session.title === state.workspace.label) {
      await this.remember(session, state.workspace, state.directory)
    }
  }

  async sessionRenamed(sessionID: string) {
    const state = await this.snapshot()
    if (!state?.workspace) return
    const session = state.roots.find((item) => item.id === sessionID)
    if (!session || !meaningful(session.title)) return
    if (this.link?.sessionID === sessionID && this.sessionEcho === session.title) {
      this.sessionEcho = undefined
      return
    }
    if (this.link?.sessionID === sessionID) this.sessionEcho = undefined
    if (!this.link && this.autoLink && state.roots.length === 1 &&
      (state.workspace.label === session.title || state.workspace.label === basename(state.directory))) {
      await this.remember(session, state.workspace, state.directory)
    }
    if (this.link?.sessionID !== sessionID || this.stopped) return
    if (state.workspace.label !== session.title) {
      await this.deps.renameWorkspace(state.workspace.workspace_id, session.title)
      this.workspaceLabels.set(state.workspace.workspace_id, session.title)
    }
  }

  async workspaceRenamed(workspaceID: string, eventLabel?: string) {
    const previousLabel = this.workspaceLabels.get(workspaceID)
    const state = await this.snapshot()
    if (!state?.workspace || !this.link || this.link.workspaceID !== workspaceID) return
    if (eventLabel !== undefined && eventLabel !== state.workspace.label) return
    this.workspaceLabels.set(workspaceID, state.workspace.label)
    // Herdr can deliver existing rename notifications on subscription. An
    // unchanged label is not a new edit and must not resolve startup conflicts.
    if (previousLabel === undefined || previousLabel === state.workspace.label) return
    // Fetch again so a move or deletion since the list cannot redirect a write.
    const session = await this.deps.getSession(this.link.sessionID)
    if (session.parentID || await canonical(session.location.directory) !== state.directory || this.stopped) return
    if (meaningful(state.workspace.label) && session.title !== state.workspace.label) {
      await this.deps.renameSession(session.id, state.workspace.label)
      this.sessionEcho = state.workspace.label
    }
  }

  async bind(sessionID: string, source: "session" | "workspace", workspaceID?: string) {
    const state = await this.snapshot()
    if (!state) return
    const workspace = workspaceID ? state.workspaces.find((item) => item.workspace_id === workspaceID) : state.workspace
    if (!workspace) throw new Error(workspaceID ? `Herdr workspace not found: ${workspaceID}` :
      "Expected exactly one Herdr Git workspace for this session directory. " +
      "Pass a workspace ID to link any space, including non-Git spaces. Available: " +
      state.workspaces.map((item) => `${item.workspace_id} (${item.label})`).join(", "))
    const session = state.roots.find((item) => item.id === sessionID)
    if (!session) throw new Error("Only a top-level session in this directory can own its workspace")
    const title = source === "session" ? session.title : workspace.label
    if (!meaningful(title)) throw new Error("Choose a meaningful title before linking")
    // Ownership is explicit here: this command may replace a previous owner.
    const explicit = workspaceID !== undefined ||
      (this.link?.explicitWorkspace === true && this.link.workspaceID === workspace.workspace_id)
    await this.remember(session, workspace, state.directory, explicit)
    if (this.stopped) return
    if (source === "session" && workspace.label !== title) {
      await this.deps.renameWorkspace(workspace.workspace_id, title)
      this.workspaceLabels.set(workspace.workspace_id, title)
    } else if (source === "workspace" && session.title !== title) {
      await this.deps.renameSession(session.id, title)
      this.sessionEcho = title
    }
  }

  async unlink() {
    await this.deps.save(false)
    this.link = undefined
    this.autoLink = false
    this.loaded = true
  }
}
