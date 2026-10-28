import { createConnection, type Socket } from "node:net"

export interface Workspace {
  workspace_id: string
  label: string
  worktree?: { checkout_path: string; is_linked_worktree: boolean }
}

// A pane in which Herdr's own OpenCode integration reports the root session.
export interface PaneSession {
  workspace_id: string
  session_id: string
  cwd?: string
}

export interface HerdrEvent {
  event: string
  data: { workspace_id?: string; label?: string }
}

// Herdr uses newline-delimited JSON. Ordinary RPC connections are one-shot;
// events.subscribe keeps its own socket open for unsolicited {event, data}.
export class HerdrClient {
  private sequence = 0
  private sockets = new Set<Socket>()
  private listeners = new Set<(event: HerdrEvent) => void>()
  private subscription?: Promise<void>
  private stream?: Socket
  private closed = false

  constructor(readonly path: string, private timeout = 5_000) {}

  onEvent(listener: (event: HerdrEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private exchange(method: string, params: Record<string, unknown>, stream = false): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Herdr client is closed"))
    const id = `opencode-name-sync-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.path)
      if (stream) this.stream = socket
      this.sockets.add(socket)
      let buffer = ""
      let acknowledged = false
      const timer = setTimeout(() => {
        reject(new Error("Herdr request timed out"))
        socket.destroy()
      }, this.timeout)
      socket.setEncoding("utf8")
      socket.once("connect", () => {
        socket.write(JSON.stringify({ id, method, params }) + "\n")
      })
      socket.on("error", reject)
      socket.on("close", () => {
        clearTimeout(timer)
        this.sockets.delete(socket)
        if (stream && this.stream === socket) {
          this.subscription = undefined
          this.stream = undefined
        }
        if (!acknowledged) reject(new Error("Herdr disconnected"))
      })
      socket.on("data", (chunk: string) => {
        buffer += chunk
        if (buffer.length > 4 * 1024 * 1024) {
          reject(new Error("Herdr message exceeds size limit"))
          socket.destroy()
          return
        }
        let newline: number
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.trim()) continue
          try {
            const message = JSON.parse(line)
            if (message.id === id && !acknowledged) {
              acknowledged = true
              clearTimeout(timer)
              if (message.error) {
                reject(new Error(message.error.message ?? "Herdr request failed"))
                socket.destroy()
                return
              }
              resolve(message.result)
              if (!stream) { socket.destroy(); return }
            } else if (stream && acknowledged && typeof message.event === "string" && message.data) {
              for (const listener of this.listeners) listener(message)
            }
          } catch {
            reject(new Error("Invalid Herdr socket message"))
            socket.destroy()
            return
          }
        }
      })
    })
  }

  async list(): Promise<Workspace[]> {
    const result = await this.exchange("workspace.list", {}) as { workspaces?: unknown }
    if (!Array.isArray(result?.workspaces)) throw new Error("Invalid Herdr workspace list")
    return result.workspaces.filter((item: any) =>
      typeof item?.workspace_id === "string" && typeof item?.label === "string" &&
      (!item.worktree || typeof item.worktree.checkout_path === "string"))
  }

  async panes(): Promise<PaneSession[]> {
    const result = await this.exchange("pane.list", {}) as { panes?: unknown }
    if (!Array.isArray(result?.panes)) throw new Error("Invalid Herdr pane list")
    return result.panes.flatMap((item: any) => {
      const session = item?.agent_session
      if (typeof item?.workspace_id !== "string" || session?.agent !== "opencode" ||
        session.kind !== "id" || typeof session.value !== "string" || !session.value) return []
      return [{ workspace_id: item.workspace_id, session_id: session.value,
        ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}) }]
    })
  }

  async rename(workspaceID: string, label: string): Promise<void> {
    await this.exchange("workspace.rename", { workspace_id: workspaceID, label })
  }

  // Only subscribe once per live connection. The periodic adapter refresh
  // reconnects after close; ordinary reads/writes never use this stream socket.
  async subscribe(): Promise<boolean> {
    const fresh = !this.subscription
    if (!this.subscription) {
      const subscription = this.exchange("events.subscribe", { subscriptions: [
        { type: "workspace.renamed" }, { type: "workspace.closed" },
      ] }, true).then(() => {})
      this.subscription = subscription
      // Clear failed attempts even before their socket's close event runs.
      void subscription.catch(() => {
        if (this.subscription === subscription) this.subscription = undefined
      })
    }
    await this.subscription
    return fresh
  }

  close() {
    this.closed = true
    this.listeners.clear()
    for (const socket of this.sockets) socket.destroy()
  }
}
