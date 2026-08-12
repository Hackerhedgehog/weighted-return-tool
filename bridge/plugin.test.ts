import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { bridgePlugin } from './plugin'

const made: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'bridge-plugin-'))
  made.push(dir)
  return dir
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void

// The plugin only ever calls `server.middlewares.use` and `server.hot.send` —
// stubbing just those two avoids having to satisfy the whole ViteDevServer shape.
interface FakeServer {
  middlewares: { use: (path: string, handler: RouteHandler) => void }
  hot: { send: (payload: unknown) => void }
}

function registerRoutes(env: Record<string, string | undefined>) {
  const routes = new Map<string, RouteHandler>()
  const hotSend = vi.fn()
  const server: FakeServer = {
    middlewares: { use: (path, handler) => routes.set(path, handler) },
    hot: { send: hotSend },
  }
  const configureServer = bridgePlugin(env).configureServer as unknown as (server: FakeServer) => void
  configureServer(server)
  return { routes, hotSend }
}

// No stream plumbing needed: a rejected request never reaches `readBody`, so
// a plain object with `method` and `headers` is all these handlers ever read.
function fakeReq(method: string, contentType?: string): IncomingMessage {
  return {
    method,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
  } as unknown as IncomingMessage
}

function fakeRes(): ServerResponse & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {
      /* no test here cares which headers were set */
    },
    end(chunk: string) {
      res.body = JSON.parse(chunk)
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: unknown }
}

function sessionBody(routes: Map<string, RouteHandler>): unknown {
  const res = fakeRes()
  routes.get('/__bridge/session')!(fakeReq('GET'), res)
  return res.body
}

describe('bridgePlugin — content-type guard', () => {
  it('refuses a save with no content-type and leaves the file unwritten', () => {
    const dir = tempDir()
    writeFileSync(resolve(dir, 'set-values-regular.tsv'), '0\t1\tlabel\n', 'utf8')
    const { routes } = registerRoutes({ WRT_BRIDGE_DIR: dir, WRT_BRIDGE_FILE: resolve(dir, 'set-values-regular.tsv') })

    const res = fakeRes()
    routes.get('/__bridge/save')!(fakeReq('POST'), res)

    expect(res.statusCode).toBe(415)
    expect(existsSync(resolve(dir, 'ref-weights-regular.tsv'))).toBe(false)
  })

  it('refuses a save sent as text/plain and leaves the file unwritten', () => {
    const dir = tempDir()
    writeFileSync(resolve(dir, 'set-values-regular.tsv'), '0\t1\tlabel\n', 'utf8')
    const { routes } = registerRoutes({ WRT_BRIDGE_DIR: dir, WRT_BRIDGE_FILE: resolve(dir, 'set-values-regular.tsv') })

    const res = fakeRes()
    routes.get('/__bridge/save')!(fakeReq('POST', 'text/plain'), res)

    expect(res.statusCode).toBe(415)
    expect(existsSync(resolve(dir, 'ref-weights-regular.tsv'))).toBe(false)
  })

  it('refuses a switch with no content-type and leaves the session unchanged', () => {
    const dir = tempDir()
    writeFileSync(resolve(dir, 'set-values-regular.tsv'), '0\t1\tlabel\n', 'utf8')
    const { routes, hotSend } = registerRoutes({
      WRT_BRIDGE_DIR: dir,
      WRT_BRIDGE_FILE: resolve(dir, 'set-values-regular.tsv'),
    })
    const before = sessionBody(routes)

    const res = fakeRes()
    routes.get('/__bridge/switch')!(fakeReq('POST'), res)

    expect(res.statusCode).toBe(415)
    expect(sessionBody(routes)).toEqual(before)
    expect(hotSend).not.toHaveBeenCalled()
  })

  it('refuses a switch sent as text/plain and leaves the session unchanged', () => {
    const dir = tempDir()
    writeFileSync(resolve(dir, 'set-values-regular.tsv'), '0\t1\tlabel\n', 'utf8')
    const { routes, hotSend } = registerRoutes({
      WRT_BRIDGE_DIR: dir,
      WRT_BRIDGE_FILE: resolve(dir, 'set-values-regular.tsv'),
    })
    const before = sessionBody(routes)

    const res = fakeRes()
    routes.get('/__bridge/switch')!(fakeReq('POST', 'text/plain'), res)

    expect(res.statusCode).toBe(415)
    expect(sessionBody(routes)).toEqual(before)
    expect(hotSend).not.toHaveBeenCalled()
  })
})
