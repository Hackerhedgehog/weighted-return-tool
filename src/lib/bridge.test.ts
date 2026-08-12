import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchSession, saveTsv } from './bridge'

const SESSION = {
  dir: '/a/scenarios',
  sourceFile: 'set-values-regular.tsv',
  filename: 'ref-weights-regular.tsv',
  game: 'joker-stacks-magic',
  tsv: '0\t1000.00\tjoker5-maxwin\n',
}

function stubFetch(res: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res))
}

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchSession', () => {
  it('returns the session when the bridge answers', async () => {
    stubFetch(jsonRes(200, { ...SESSION, sessionId: 'abc123', seq: 3, openAs: 'new-tab' }))
    expect(await fetchSession()).toEqual({
      ...SESSION,
      sessionId: 'abc123',
      seq: 3,
      openAs: 'new-tab',
    })
  })

  it('defaults the feed identity when an older bridge omits it', async () => {
    stubFetch(jsonRes(200, SESSION))
    expect(await fetchSession()).toEqual({ ...SESSION, sessionId: '', seq: 1, openAs: 'overwrite' })
  })

  it('returns null on 404', async () => {
    stubFetch(jsonRes(404, { error: 'nope' }))
    expect(await fetchSession()).toBeNull()
  })

  it('returns null when the SPA fallback serves HTML', async () => {
    stubFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => ({}),
    })
    expect(await fetchSession()).toBeNull()
  })

  it('returns null when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await fetchSession()).toBeNull()
  })

  it('returns null when the payload is the wrong shape', async () => {
    stubFetch(jsonRes(200, { dir: '/a' }))
    expect(await fetchSession()).toBeNull()
  })
})

describe('saveTsv', () => {
  it('reports a successful write', async () => {
    stubFetch(jsonRes(200, { path: '/a/scenarios/ref-weights-regular.tsv' }))
    expect(await saveTsv('ref-weights-regular.tsv', 'x', false)).toEqual({
      kind: 'saved',
      path: '/a/scenarios/ref-weights-regular.tsv',
    })
  })

  it('reports a conflict', async () => {
    stubFetch(jsonRes(409, { exists: true, filename: 'ref-weights-regular.tsv' }))
    expect(await saveTsv('ref-weights-regular.tsv', 'x', false)).toEqual({
      kind: 'exists',
      filename: 'ref-weights-regular.tsv',
    })
  })

  it('reports a rejection', async () => {
    stubFetch(jsonRes(400, { error: 'Filename must end with .tsv' }))
    expect(await saveTsv('x', 'x', false)).toEqual({
      kind: 'error',
      message: 'Filename must end with .tsv',
    })
  })

  it('reports a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await saveTsv('a.tsv', 'x', false)).toEqual({ kind: 'error', message: 'offline' })
  })

  it('sends the overwrite flag', async () => {
    const spy = vi.fn().mockResolvedValue(jsonRes(200, { path: '/a/out.tsv' }))
    vi.stubGlobal('fetch', spy)
    await saveTsv('out.tsv', 'body', true)
    const body = JSON.parse(spy.mock.calls[0][1].body as string)
    expect(body).toEqual({ filename: 'out.tsv', text: 'body', overwrite: true })
  })
})
