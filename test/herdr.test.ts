import { afterEach, expect, test } from "bun:test"
import { createServer, type Socket, type Server } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HerdrClient, type HerdrEvent } from "../src/herdr"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(handle: (request: any, socket: Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-wire-"))
  const path = join(directory, "herdr.sock")
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        handle(JSON.parse(line), socket)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, resolve)
  })
  const client = new HerdrClient(path, 100)
  cleanups.push(async () => {
    client.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  return { client, sockets }
}

test("supports concurrent RPC and subscriptions, including split Unicode frames", async () => {
  const f = await fixture((request, socket) => {
    if (request.method === "workspace.list") {
      const response = Buffer.from(JSON.stringify({ id: request.id, result: { workspaces: [
        { workspace_id: "w1", label: "Fix → ship" },
      ] } }) + "\n")
      const split = response.indexOf(Buffer.from("→")) + 1
      socket.write(response.subarray(0, split))
      socket.write(response.subarray(split))
    } else socket.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n" +
      JSON.stringify({ event: "workspace_renamed", data: { workspace_id: "w1", label: "Renamed" } }) + "\n")
  })
  const events: HerdrEvent[] = []
  f.client.onEvent((event) => events.push(event))
  const [workspaces] = await Promise.all([f.client.list(), f.client.subscribe()])
  expect(workspaces[0]!.label).toBe("Fix → ship")
  expect(events[0]!.data.label).toBe("Renamed")
})

test("sends display-only rename params and surfaces API errors", async () => {
  const requests: any[] = []
  const f = await fixture((request, socket) => {
    requests.push(request)
    socket.write(JSON.stringify({ id: request.id, error: { message: "Workspace missing" } }) + "\n")
  })
  await expect(f.client.rename("w1", "Exact Name!")).rejects.toThrow("Workspace missing")
  expect(requests[0].params).toEqual({ workspace_id: "w1", label: "Exact Name!" })
})

test("disconnect rejects pending work and the next request reconnects", async () => {
  let calls = 0
  const f = await fixture((request, socket) => {
    if (++calls === 1) socket.destroy()
    else socket.write(JSON.stringify({ id: request.id, result: { workspaces: [] } }) + "\n")
  })
  await expect(f.client.list()).rejects.toThrow("disconnected")
  expect(await f.client.list()).toEqual([])
})

test("timeouts and malformed frames reject instead of hanging", async () => {
  const silent = await fixture(() => {})
  await expect(silent.client.list()).rejects.toThrow("timed out")
  const invalid = await fixture((_, socket) => socket.write("{broken json}\n"))
  await expect(invalid.client.list()).rejects.toThrow("Invalid Herdr socket message")
})

test("cleanup prevents future connections", async () => {
  const f = await fixture(() => {})
  f.client.close()
  await expect(f.client.list()).rejects.toThrow("closed")
})

test("one-shot RPC connections are separate from the persistent subscription", async () => {
  let subscription: Socket | undefined
  let subscriptions = 0
  const rpcSockets: Socket[] = []
  const f = await fixture((request, socket) => {
    if (request.method === "events.subscribe") {
      subscriptions++
      subscription = socket
      socket.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n")
    } else {
      rpcSockets.push(socket)
      socket.end(JSON.stringify({ id: request.id, result: { workspaces: [] } }) + "\n")
    }
  })
  expect(await f.client.subscribe()).toBe(true)
  expect(await f.client.subscribe()).toBe(false)
  await f.client.list()
  await f.client.list()
  expect(subscriptions).toBe(1)
  expect(rpcSockets[0]).not.toBe(rpcSockets[1])
  expect(rpcSockets).not.toContain(subscription)
  const received = new Promise<HerdrEvent>((resolve) => f.client.onEvent(resolve))
  subscription!.write(JSON.stringify({ event: "workspace_renamed", data: { workspace_id: "w1", label: "Still live" } }) + "\n")
  expect((await received).data.label).toBe("Still live")
})
