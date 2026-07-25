import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../src/server.js'
import { PlexAdapter } from '../../src/adapters/plex.js'

// Verifies the UI can toggle auto-confirm via PATCH /api/config (the on/off switch added to
// the MyShows panel) and that GET /api/config reflects it — i.e. the setting round-trips to
// disk without needing a config.json edit.

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myshows-config-patch-'))
  configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      myshows_token: 'stub-token',
      myshows_url: 'https://api.myshows.me/v2/rpc/',
      auto_confirm: false,
      sources: [],
    }),
    'utf8',
  )
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function buildServer() {
  vi.spyOn(PlexAdapter.prototype, 'start').mockImplementation(function () {
    /* noop */
  })
  return createServer({ ui: false, configPath, skipBootstrap: true })
}

async function getAutoConfirm(server: Awaited<ReturnType<typeof buildServer>>): Promise<boolean> {
  const res = await server.fastify.inject({ method: 'GET', url: '/api/config' })
  return JSON.parse(res.payload).autoConfirm === true
}

describe('PATCH /api/config { autoConfirm }', () => {
  it('turns auto-confirm on and reflects it in GET /api/config', async () => {
    const server = await buildServer()
    expect(await getAutoConfirm(server)).toBe(false)

    const res = await server.fastify.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { autoConfirm: true },
    })
    expect(res.statusCode).toBe(200)
    expect(await getAutoConfirm(server)).toBe(true)

    await server.fastify.close()
  })

  it('turns it back off', async () => {
    const server = await buildServer()
    await server.fastify.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { autoConfirm: true },
    })
    await server.fastify.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { autoConfirm: false },
    })
    expect(await getAutoConfirm(server)).toBe(false)
    await server.fastify.close()
  })
})
