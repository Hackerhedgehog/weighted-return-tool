import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { bridgeConfigFromEnv, initialSession, type BridgeSession } from './config.ts'
import { sessionResult, saveResult, switchResult, type JsonResult } from './handlers.ts'

function send(res: ServerResponse, result: JsonResult): void {
  res.statusCode = result.status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(result.body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    // Concatenated as bytes and decoded once at the end — decoding each chunk
    // on its own (`raw += chunk`) mangles a multi-byte UTF-8 sequence that
    // straddles a chunk boundary into replacement characters on both sides.
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

/**
 * A cross-origin form POST is a CORS "simple request" — the browser never
 * preflights it, so it reaches this middleware on its own. Nothing in this
 * project's Vite config stops it either: `server.allowedHosts` is widened for
 * ngrok, but that is a Host-header check on where the request was addressed,
 * not a check on which origin sent it, so it neither blocks nor blesses a
 * cross-site POST. Demanding an explicit `application/json` Content-Type turns
 * a cross-origin caller into one that *does* need a preflight, which Vite's
 * default CORS then refuses — a form post, or any simple cross-site request,
 * can never set this header itself. Both real callers (the app's `saveTsv`,
 * the CLI's switch call) already send it, so nothing legitimate breaks.
 */
function hasJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type']
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('application/json')
}

/**
 * Serves the CLI's set-values file to the app, writes its export back, and
 * lets the CLI re-point the session at another file entirely.
 *
 * With no bridge environment this registers nothing at all — `/__bridge/*`
 * then falls through to Vite's SPA fallback, the client's probe sees HTML
 * instead of JSON, and the tool runs exactly as it always has. `apply: 'serve'`
 * keeps it out of production builds entirely.
 */
export function bridgePlugin(env: Record<string, string | undefined> = process.env): Plugin {
  // The session starts from the environment and can be re-pointed at another
  // file — or another game — while the server runs. Null still means "no
  // bridge at all": nothing is registered and `/__bridge/*` falls through.
  // The feed identity (sessionId, seq, openAs) is seeded here so it spans the
  // whole dev-server run, not any one request.
  const cfg = bridgeConfigFromEnv(env)
  let session = cfg === null ? null : initialSession(cfg)

  return {
    name: 'wrt-bridge',
    apply: 'serve',
    configureServer(server) {
      if (session === null) return
      const active = () => session as BridgeSession

      console.log(`[bridge] ${active().game || 'session'} — reading ${active().file}`)
      console.log(`[bridge] saves land in ${active().dir}`)

      server.middlewares.use('/__bridge/session', (_req, res) => {
        send(res, sessionResult(active()))
      })

      server.middlewares.use('/__bridge/save', (req, res) => {
        if (req.method !== 'POST') {
          send(res, { status: 405, body: { error: 'Use POST.' } })
          return
        }
        if (!hasJsonContentType(req)) {
          send(res, { status: 415, body: { error: 'Content-Type must be application/json.' } })
          return
        }
        readBody(req)
          .then((raw) => {
            let parsed: unknown
            try {
              parsed = JSON.parse(raw)
            } catch {
              send(res, { status: 400, body: { error: 'Body must be JSON.' } })
              return
            }
            send(res, saveResult(active(), parsed))
          })
          .catch((err: Error) => send(res, { status: 500, body: { error: err.message } }))
      })

      server.middlewares.use('/__bridge/switch', (req, res) => {
        if (req.method !== 'POST') {
          send(res, { status: 405, body: { error: 'Use POST.' } })
          return
        }
        if (!hasJsonContentType(req)) {
          send(res, { status: 415, body: { error: 'Content-Type must be application/json.' } })
          return
        }
        readBody(req)
          .then((raw) => {
            let parsed: unknown
            try {
              parsed = JSON.parse(raw)
            } catch {
              send(res, { status: 400, body: { error: 'Body must be JSON.' } })
              return
            }
            const { result, next } = switchResult(active(), parsed)
            if (next !== null) {
              session = next
              // Named explicitly — the startup log's "saves land in <dir>"
              // goes stale the instant a switch changes the directory, so
              // the terminal must never be left claiming the old one.
              console.log(`[bridge] switched to ${next.file} (saves land in ${next.dir})`)
              // The app loads the bridge session on mount, so a full reload is
              // the whole of the handover.
              server.hot.send({ type: 'full-reload', path: '*' })
            }
            send(res, result)
          })
          .catch((err: Error) => send(res, { status: 500, body: { error: err.message } }))
      })
    },
  }
}
