import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
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

function fakeRes(): ServerResponse & { statusCode: number; body: unknown; done: Promise<void> } {
  let finish!: () => void
  const done = new Promise<void>((resolvePromise) => {
    finish = resolvePromise
  })
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    done,
    setHeader() {
      /* no test here cares which headers were set */
    },
    end(chunk: string) {
      res.body = JSON.parse(chunk)
      finish()
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: unknown; done: Promise<void> }
}

function sessionBody(routes: Map<string, RouteHandler>): unknown {
  const res = fakeRes()
  routes.get('/__bridge/session')!(fakeReq('GET'), res)
  return res.body
}

/**
 * `readBody` only ever listens for 'data'/'end'/'error', so an EventEmitter
 * wearing `method` and `headers` stands in for the whole request stream. The
 * handler subscribes synchronously, so emitting right after calling it is
 * safe; the response settles on a later microtask, hence the awaitable `done`.
 */
async function postJson(
  routes: Map<string, RouteHandler>,
  path: string,
  body: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
  const res = fakeRes()
  routes.get(path)!(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await res.done
  return { statusCode: res.statusCode, body: res.body }
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

describe('bridgePlugin — feed identity', () => {
  function launched() {
    const dir = tempDir()
    const file = resolve(dir, 'set-values-regular.tsv')
    writeFileSync(file, '0\t1\tlabel\n', 'utf8')
    return { dir, file, ...registerRoutes({ WRT_BRIDGE_DIR: dir, WRT_BRIDGE_FILE: file }) }
  }

  it('starts at seq 1, overwriting, with one id for the whole run', () => {
    const { routes } = launched()
    const first = sessionBody(routes) as { sessionId: string; seq: number; openAs: string }
    const second = sessionBody(routes) as { sessionId: string }
    expect(first.seq).toBe(1)
    expect(first.openAs).toBe('overwrite')
    expect(first.sessionId).toMatch(/^[0-9a-f]{16}$/)
    expect(second.sessionId).toBe(first.sessionId)
  })

  it('bumps the seq and round-trips openAs on an accepted switch', async () => {
    const { routes, hotSend, dir, file } = launched()
    const before = sessionBody(routes) as { sessionId: string }

    const r = await postJson(routes, '/__bridge/switch', { dir, file, openAs: 'new-tab' })
    expect(r.statusCode).toBe(200)
    expect(hotSend).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })

    const after = sessionBody(routes) as { sessionId: string; seq: number; openAs: string }
    expect(after.seq).toBe(2)
    expect(after.openAs).toBe('new-tab')
    // Same dev-server run: switching files never mints a new id.
    expect(after.sessionId).toBe(before.sessionId)
  })

  it('400s an invalid openAs and leaves the session untouched', async () => {
    const { routes, hotSend, dir, file } = launched()
    const before = sessionBody(routes)

    const r = await postJson(routes, '/__bridge/switch', { dir, file, openAs: 'both' })
    expect(r.statusCode).toBe(400)
    expect((r.body as { error: string }).error).toMatch(/openAs/)

    expect(sessionBody(routes)).toEqual(before)
    expect(hotSend).not.toHaveBeenCalled()
  })

  it('keeps seq and openAs where the last accepted switch left them after a refusal', async () => {
    const { routes, dir, file } = launched()
    await postJson(routes, '/__bridge/switch', { dir, file, openAs: 'new-tab' })

    const r = await postJson(routes, '/__bridge/switch', { dir, file: resolve(dir, 'gone.tsv') })
    expect(r.statusCode).toBe(400)

    const after = sessionBody(routes) as { seq: number; openAs: string }
    expect(after.seq).toBe(2)
    expect(after.openAs).toBe('new-tab')
  })
})
