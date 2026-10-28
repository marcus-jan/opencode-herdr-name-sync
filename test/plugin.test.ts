import { expect, test } from "bun:test"
import { createServer, type Socket } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index"

test("plugin wires persistent ownership, commands and cleanup to the SDK context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-plugin-"))
  const path = join(directory, "herdr.sock")
  const sockets = new Set<Socket>()
  const workspace = { workspace_id: "w1", label: "Project",
    worktree: { checkout_path: directory, is_linked_worktree: true } }
  const session = { id: "s1", title: "Project", location: { directory } }
  const methods: string[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      const request = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      methods.push(request.method)
      if (request.method === "workspace.rename") workspace.label = request.params.label
      const result = request.method === "workspace.list" ? { workspaces: [workspace] } :
        request.method === "pane.list" ? { panes: [] } :
        { type: request.method === "events.subscribe" ? "subscription_started" : "workspace_renamed" }
      const response = JSON.stringify({ id: request.id, result }) + "\n"
      if (request.method === "events.subscribe") socket.write(response)
      else socket.end(response)
    })
  })
  let cleanup: (() => unknown) | undefined
  try {
    await new Promise<void>((resolve) => server.listen(path, resolve))
    type Invocation = { sessionID: string; prompt: { text: string } }
    const input = (text = ""): Invocation => ({ sessionID: "s1", prompt: { text } })
    const commands = new Map<string, { execute(input: Invocation): Promise<void> }>()
    const storage = new Map<string, unknown>()
    let linked!: () => void
    const ready = new Promise<void>((resolve) => { linked = resolve })
    let streamAborted = false
    const context = {
      options: { socketPath: path },
      location: { directory },
      session: {
        list: async () => ({ data: [session], cursor: { next: null } }),
        get: async () => session,
        update: async ({ title }: { title: string }) => { session.title = title },
      },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => { storage.set(key, value); linked() },
        remove: async (key: string) => { storage.delete(key) },
      },
      command: { transform: async (edit: (editor: unknown) => void) => edit({
        add: (command: { name: string; execute(input: Invocation): Promise<void> }) => commands.set(command.name, command),
      }) },
      event: { async *subscribe({ signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          streamAborted = true
          resolve()
        }, { once: true }))
      } },
    } as unknown as Parameters<typeof plugin.setup>[0]
    cleanup = await plugin.setup(context) as () => unknown
    await ready
    expect(commands.size).toBe(3)
    expect([...storage.values()][0]).toMatchObject({ sessionID: "s1", workspaceID: "w1" })
    workspace.label = "Workspace wins"
    await commands.get("herdr-link-workspace")!.execute(input())
    expect(session.title).toBe("Workspace wins")
    session.title = "Session wins"
    await commands.get("herdr-link-session")!.execute(input())
    expect(workspace.label).toBe("Session wins")
    await commands.get("herdr-unlink")!.execute(input())
    expect([...storage.values()][0]).toBe(false)
    workspace.worktree!.checkout_path = "/elsewhere"
    workspace.label = "Misc"
    await expect(commands.get("herdr-link-workspace")!.execute(input("w1 extra"))).rejects.toThrow("single")
    await expect(commands.get("herdr-link-workspace")!.execute(input("missing"))).rejects.toThrow("not found")
    await commands.get("herdr-link-workspace")!.execute(input("  w1  "))
    expect(session.title).toBe("Misc")
    expect([...storage.values()][0]).toMatchObject({ workspaceID: "w1", explicitWorkspace: true })
    cleanup()
    cleanup = await plugin.setup(context) as () => unknown
    session.title = "Explicit session"
    await commands.get("herdr-link-session")!.execute(input())
    expect(workspace.label).toBe("Explicit session")
    cleanup()
    expect(streamAborted).toBe(true)
    const count = methods.length
    await commands.get("herdr-link-session")!.execute(input())
    expect(methods.length).toBe(count)
  } finally {
    cleanup?.()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
