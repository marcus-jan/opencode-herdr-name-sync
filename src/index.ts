import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { HerdrClient } from "./herdr"
import { NameSync, type Link, type Session } from "./sync"

export default Plugin.define({
  id: "herdr-name-sync",
  async setup(ctx) {
    const socketPath = ctx.options.socketPath
    if (socketPath !== undefined && (typeof socketPath !== "string" || !socketPath)) {
      throw new Error("herdr-name-sync: socketPath must be a nonempty string")
    }
    const herdr = new HerdrClient(socketPath ?? process.env.HERDR_SOCKET_PATH ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr", "herdr.sock"))
    const controller = new AbortController()
    const key = `link/${encodeURIComponent(ctx.location.directory)}`
    const sync = new NameSync({
      directory: ctx.location.directory,
      async sessions() {
        const sessions: Session[] = []
        let cursor: string | undefined
        do {
          const page = await ctx.session.list(cursor ? { cursor, limit: 100 } :
            { directory: ctx.location.directory, limit: 100 })
          sessions.push(...page.data)
          cursor = page.cursor.next ?? undefined
        } while (cursor && !controller.signal.aborted)
        return sessions
      },
      getSession: (sessionID) => ctx.session.get({ sessionID }),
      renameSession: (sessionID, title) => ctx.session.update({ sessionID, title }),
      workspaces: () => herdr.list(),
      panes: () => herdr.panes(),
      renameWorkspace: (workspaceID, title) => herdr.rename(workspaceID, title),
      async load() {
        const saved = await ctx.storage.get(key)
        if (saved === false) return false
        const record = saved as Record<string, unknown> | undefined
        if (saved && typeof saved === "object" && !Array.isArray(saved) &&
          typeof record?.sessionID === "string" && typeof record.workspaceID === "string" &&
          typeof record.directory === "string" &&
          (record.explicitWorkspace === undefined || typeof record.explicitWorkspace === "boolean")) return saved as unknown as Link
      },
      isUnlinked: async (sessionID) => await ctx.storage.get(`unlinked/${sessionID}`) === true,
      setUnlinked: (sessionID, value) => value ? ctx.storage.set(`unlinked/${sessionID}`, true) :
        ctx.storage.remove(`unlinked/${sessionID}`),
      save: (link) => link === false ? ctx.storage.set(key, false) :
        link ? ctx.storage.set(key, { ...link }) : ctx.storage.remove(key),
    })
    let queue = Promise.resolve()
    let lastWarning = 0
    const warn = (error: unknown) => {
      if (controller.signal.aborted || Date.now() - lastWarning < 30_000) return
      lastWarning = Date.now()
      console.warn("[herdr-name-sync]", error instanceof Error ? error.message : "Sync unavailable")
    }
    const enqueue = (work: () => Promise<void>) => {
      const task = queue.then(() => controller.signal.aborted ? undefined : work())
      queue = task.catch(warn)
      return task
    }
    herdr.onEvent((event) => {
      if (event.event === "workspace_renamed" && typeof event.data.workspace_id === "string") {
        void enqueue(() => sync.workspaceRenamed(event.data.workspace_id!, event.data.label)).catch(() => {})
      } else if (event.event === "workspace_closed") {
        void enqueue(() => sync.reconcile()).catch(() => {})
      }
    })
    await ctx.command.transform((editor) => {
      for (const source of ["session", "workspace"] as const) {
        editor.add({
          name: `herdr-link-${source}`,
          description: `Link this session, keeping the ${source} name (optional: Herdr workspace ID)`,
          execute: ({ sessionID, prompt }) => enqueue(() => {
            const text = prompt.text.trim()
            if (text && /\s/.test(text)) throw new Error("Pass a single Herdr workspace ID, for example: w36")
            return sync.bind(sessionID, source, text || undefined)
          }),
        })
      }
      editor.add({
        name: "herdr-unlink",
        description: "Stop syncing this session until an explicit link command",
        execute: ({ sessionID }) => enqueue(() => sync.unlink(sessionID)),
      })
    })
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          // Events are global; NameSync checks actual session directories and
          // only writes for this plugin instance's checkout.
          if (event.type === "session.renamed") {
            await enqueue(() => sync.sessionRenamed(event.data.sessionID)).catch(() => {})
          } else if (event.type === "session.moved" || event.type === "session.created" || event.type === "session.deleted") {
            await enqueue(() => sync.reconcile()).catch(() => {})
          }
        }
      } catch (error) { warn(error) }
    })()
    const refresh = () => enqueue(async () => {
      const reconnected = await herdr.subscribe()
      await sync.reconcile(reconnected)
    }).catch(() => {})
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5_000)
    timer.unref()
    return () => {
      controller.abort()
      clearInterval(timer)
      sync.stop()
      herdr.close()
    }
  },
})
