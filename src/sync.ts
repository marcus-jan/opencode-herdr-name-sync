import { realpath } from "node:fs/promises"
import { basename } from "node:path"
import type { PaneSession, Workspace } from "./herdr"

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
  panes(): Promise<PaneSession[]>
  renameWorkspace(id: string, title: string): Promise<void>
  load(): Promise<Link | false | undefined>
  save(link: Link | false | undefined): Promise<void>
  isUnlinked(sessionID: string): Promise<boolean>
  setUnlinked(sessionID: string, unlinked: boolean): Promise<void>
}

interface Pair {
  session: Session
  workspace: Workspace
  reported: boolean
  defaults: string[]
}

export function meaningful(title: string | undefined): title is string {
  return !!title?.trim() && !/^(?:New session|Child session)(?:\s*[-–—].*)?$/i.test(title)
}

export async function canonical(directory: string): Promise<string | undefined> {
  try { return await realpath(directory) } catch { return undefined }
}

const key = (pair: Pair) => `${pair.session.id}\n${pair.workspace.workspace_id}`

// All entrypoints are serialized by the adapter. Always read current state,
// rather than trusting queued event titles: echoed/stale events then become
// no-ops instead of changing a newer title back.
//
// Pairs come from two sources. Herdr's OpenCode integration reports which
// root session runs in each pane. The stored link (explicit command or Git
// checkout path match) is the fallback. Only linked worktrees are eligible.
export class NameSync {
  private link?: Link
  private loaded = false
  private stopped = false
  private autoLink = true
  private known = new Set<string>()
  private unlinked = new Map<string, boolean>()
  private sessionEcho = new Map<string, string>()
  private workspaceLabels = new Map<string, string>()

  constructor(private deps: SyncDependencies) {}

  stop() { this.stopped = true }

  private async isUnlinked(sessionID: string) {
    if (!this.unlinked.has(sessionID)) this.unlinked.set(sessionID, await this.deps.isUnlinked(sessionID))
    return this.unlinked.get(sessionID)!
  }

  private async snapshot() {
    if (this.stopped) return
    const directory = await canonical(this.deps.directory)
    if (!directory) return
    const [sessions, all, panes] = await Promise.all([
      this.deps.sessions(), this.deps.workspaces(), this.deps.panes(),
    ])
    // Main checkouts and non-Git spaces keep their own names.
    const workspaces = all.filter((workspace) => workspace.worktree?.is_linked_worktree === true)
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
    const bySession = new Map<string, Set<string>>()
    const byWorkspace = new Map<string, Set<string>>()
    const cwds = new Map<string, string[]>()
    for (const pane of panes) {
      if (!bySession.has(pane.session_id)) bySession.set(pane.session_id, new Set())
      if (!byWorkspace.has(pane.workspace_id)) byWorkspace.set(pane.workspace_id, new Set())
      bySession.get(pane.session_id)!.add(pane.workspace_id)
      byWorkspace.get(pane.workspace_id)!.add(pane.session_id)
      if (pane.cwd) cwds.set(pane.workspace_id, [...cwds.get(pane.workspace_id) ?? [], basename(pane.cwd)])
    }
    const defaults = (workspace: Workspace) => [basename(directory), ...cwds.get(workspace.workspace_id) ?? []]
    // Two sessions in one workspace, or one session in two, is ambiguous.
    const conflicts = (sessionID: string, workspaceID: string) =>
      [...byWorkspace.get(workspaceID) ?? []].some((id) => id !== sessionID) ||
      [...bySession.get(sessionID) ?? []].some((id) => id !== workspaceID)
    const pairs: Pair[] = []
    for (const workspace of workspaces) {
      const reported = byWorkspace.get(workspace.workspace_id)
      if (reported?.size !== 1) continue
      const session = roots.find((item) => reported.has(item.id))
      if (!session || conflicts(session.id, workspace.workspace_id) || await this.isUnlinked(session.id)) continue
      pairs.push({ session, workspace, reported: true, defaults: defaults(workspace) })
    }
    // Explicit selection does not require Git metadata. Without it, duplicate
    // checkout paths are ambiguous and must never be guessed from environment.
    let workspace = this.link?.explicitWorkspace ?
      workspaces.find((item) => item.workspace_id === this.link!.workspaceID) :
      matches.length === 1 ? matches[0] : undefined
    const owner = roots.find((session) => session.id === this.link?.sessionID)
    if (this.link && (!workspace || !owner || this.link.directory !== directory ||
      this.link.workspaceID !== workspace.workspace_id || conflicts(owner.id, workspace.workspace_id))) {
      await this.deps.save(undefined)
      this.link = undefined
      workspace = matches.length === 1 ? matches[0] : undefined
    }
    if (this.link && owner && workspace && !pairs.some((pair) => pair.session.id === owner.id)) {
      pairs.push({ session: owner, workspace, reported: false, defaults: defaults(workspace) })
    }
    // The checkout heuristic only applies when Herdr reports nothing either way.
    const candidate = !this.link && this.autoLink && roots.length === 1 && workspace &&
      !bySession.has(roots[0]!.id) && !byWorkspace.has(workspace.workspace_id) &&
      !await this.isUnlinked(roots[0]!.id) ? { session: roots[0]!, workspace } : undefined
    const matched = matches.length === 1 ? matches[0] : undefined
    if (this.stopped) return
    return { directory, roots, all, workspaces, pairs, candidate, matched, conflicts }
  }

  // Establish newly observed pairs. Reported pairs adopt the Herdr label,
  // unless it is still a default directory name and the session has a real
  // title. Stored links never overwrite names at startup.
  private async settle(pairs: Pair[]) {
    const settled = new Set<string>()
    for (const pair of pairs) {
      if (this.known.has(key(pair)) || this.stopped) continue
      const { session, workspace } = pair
      if (pair.reported) {
        if (!meaningful(session.title)) continue
        const sessionWins = pair.defaults.includes(workspace.label) || !meaningful(workspace.label)
        if (sessionWins && workspace.label !== session.title) {
          await this.deps.renameWorkspace(workspace.workspace_id, session.title)
          workspace.label = session.title
        } else if (!sessionWins && session.title !== workspace.label) {
          await this.deps.renameSession(session.id, workspace.label)
          this.sessionEcho.set(session.id, workspace.label)
          session.title = workspace.label
        }
      }
      this.known.add(key(pair))
      this.workspaceLabels.set(workspace.workspace_id, workspace.label)
      settled.add(key(pair))
    }
    return settled
  }

  private async remember(session: Session, workspace: Workspace, directory: string, explicitWorkspace = false) {
    const link: Link = { sessionID: session.id, workspaceID: workspace.workspace_id, directory,
      ...(explicitWorkspace ? { explicitWorkspace: true } : {}) }
    await this.deps.save(link)
    this.link = link
    this.sessionEcho.delete(session.id)
    this.autoLink = true
    this.known.add(`${session.id}\n${workspace.workspace_id}`)
    this.workspaceLabels.set(workspace.workspace_id, workspace.label)
  }

  async reconcile(resetBaseline = false) {
    const state = await this.snapshot()
    if (!state) return
    for (const pair of state.pairs) {
      if (resetBaseline || !this.workspaceLabels.has(pair.workspace.workspace_id)) {
        this.workspaceLabels.set(pair.workspace.workspace_id, pair.workspace.label)
      }
    }
    await this.settle(state.pairs)
    const candidate = state.candidate
    // Startup only establishes checkout ownership when no names need changing.
    if (candidate && meaningful(candidate.session.title) && candidate.session.title === candidate.workspace.label) {
      await this.remember(candidate.session, candidate.workspace, state.directory)
    }
  }

  async sessionRenamed(sessionID: string) {
    const state = await this.snapshot()
    if (!state) return
    const settled = await this.settle(state.pairs)
    let pair = state.pairs.find((item) => item.session.id === sessionID)
    const session = pair?.session ?? state.candidate?.session
    if (!session || session.id !== sessionID || !meaningful(session.title)) return
    if (this.sessionEcho.get(sessionID) === session.title) {
      this.sessionEcho.delete(sessionID)
      return
    }
    this.sessionEcho.delete(sessionID)
    const candidate = state.candidate
    if (!pair && candidate && (candidate.workspace.label === session.title ||
      candidate.workspace.label === basename(state.directory))) {
      await this.remember(session, candidate.workspace, state.directory)
      pair = { session, workspace: candidate.workspace, reported: false, defaults: [] }
    }
    if (!pair || settled.has(key(pair)) || this.stopped) return
    if (pair.workspace.label !== session.title) {
      await this.deps.renameWorkspace(pair.workspace.workspace_id, session.title)
      this.workspaceLabels.set(pair.workspace.workspace_id, session.title)
    }
  }

  async workspaceRenamed(workspaceID: string, eventLabel?: string) {
    const previousLabel = this.workspaceLabels.get(workspaceID)
    const state = await this.snapshot()
    if (!state) return
    const settled = await this.settle(state.pairs)
    const pair = state.pairs.find((item) => item.workspace.workspace_id === workspaceID)
    if (!pair || settled.has(key(pair))) return
    const workspace = pair.workspace
    if (eventLabel !== undefined && eventLabel !== workspace.label) return
    this.workspaceLabels.set(workspaceID, workspace.label)
    // Herdr can deliver existing rename notifications on subscription. An
    // unchanged label is not a new edit and must not resolve startup conflicts.
    if (previousLabel === undefined || previousLabel === workspace.label) return
    // Fetch again so a move or deletion since the list cannot redirect a write.
    const session = await this.deps.getSession(pair.session.id)
    if (session.parentID || await canonical(session.location.directory) !== state.directory || this.stopped) return
    if (meaningful(workspace.label) && session.title !== workspace.label) {
      await this.deps.renameSession(session.id, workspace.label)
      this.sessionEcho.set(session.id, workspace.label)
    }
  }

  async bind(sessionID: string, source: "session" | "workspace", workspaceID?: string) {
    const state = await this.snapshot()
    if (!state) return
    const reported = state.pairs.find((item) => item.reported && item.session.id === sessionID)?.workspace
    const workspace = workspaceID ? state.workspaces.find((item) => item.workspace_id === workspaceID) :
      reported ?? state.pairs.find((item) => item.session.id === sessionID)?.workspace ?? state.matched
    const ineligible = workspaceID && state.all.find((item) => item.workspace_id === workspaceID)
    if (!workspace && ineligible) throw new Error(
      `Only linked Git worktree workspaces sync; ${workspaceID} (${ineligible.label}) is a main checkout or non-Git space`)
    if (!workspace) throw new Error(workspaceID ? `Herdr workspace not found: ${workspaceID}` :
      "Could not tell which Herdr workspace runs this session. " +
      "Pass a linked worktree workspace ID. Available: " +
      state.workspaces.map((item) => `${item.workspace_id} (${item.label})`).join(", "))
    const session = state.roots.find((item) => item.id === sessionID)
    if (!session) throw new Error("Only a top-level session in this directory can own its workspace")
    if (state.conflicts(session.id, workspace.workspace_id)) {
      throw new Error(`Herdr reports a different OpenCode session for ${workspace.workspace_id} or this session`)
    }
    const title = source === "session" ? session.title : workspace.label
    if (!meaningful(title)) throw new Error("Choose a meaningful title before linking")
    await this.deps.setUnlinked(session.id, false)
    this.unlinked.set(session.id, false)
    // Ownership is explicit here: this command may replace a previous owner.
    const explicit = workspaceID !== undefined ||
      (this.link?.explicitWorkspace === true && this.link.workspaceID === workspace.workspace_id) ||
      workspace !== state.matched
    await this.remember(session, workspace, state.directory, explicit)
    if (this.stopped) return
    if (source === "session" && workspace.label !== title) {
      await this.deps.renameWorkspace(workspace.workspace_id, title)
      this.workspaceLabels.set(workspace.workspace_id, title)
    } else if (source === "workspace" && session.title !== title) {
      await this.deps.renameSession(session.id, title)
      this.sessionEcho.set(session.id, title)
    }
  }

  async unlink(sessionID: string) {
    if (!this.loaded) {
      const saved = await this.deps.load()
      this.autoLink = saved !== false
      this.link = saved || undefined
      this.loaded = true
    }
    await this.deps.setUnlinked(sessionID, true)
    this.unlinked.set(sessionID, true)
    if (!this.link || this.link.sessionID === sessionID) {
      await this.deps.save(false)
      this.link = undefined
      this.autoLink = false
    }
    for (const item of this.known) if (item.startsWith(`${sessionID}\n`)) this.known.delete(item)
  }
}
