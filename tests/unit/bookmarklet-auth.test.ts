import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../src/server.js'
import { PlexAdapter } from '../../src/adapters/plex.js'

// Exercises POST /api/auth/myshows-bookmarklet (the extension handoff endpoint) end-to-end
// via fastify.inject, asserting the seed-time validation: only a plausible msRefreshToken
// (long, ASCII) is accepted and reflected by the status endpoint.

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myshows-bookmarklet-'))
  configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      myshows_token: 'stub-token',
      myshows_url: 'https://api.myshows.me/v2/rpc/',
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

async function post(
  server: Awaited<ReturnType<typeof buildServer>>,
  body: unknown,
): Promise<{ statusCode: number }> {
  const res = await server.fastify.inject({
    method: 'POST',
    url: '/api/auth/myshows-bookmarklet',
    payload: body,
  })
  return { statusCode: res.statusCode }
}

async function isConnected(server: Awaited<ReturnType<typeof buildServer>>): Promise<boolean> {
  const res = await server.fastify.inject({ method: 'GET', url: '/api/auth/myshows-status' })
  return JSON.parse(res.payload).connected === true
}

const VALID_TOKEN = 'a'.repeat(40) // long opaque ASCII string, like a real msRefreshToken

describe('POST /api/auth/myshows-bookmarklet', () => {
  it('accepts a plausible token and reports connected', async () => {
    const server = await buildServer()
    expect(await isConnected(server)).toBe(false)

    const { statusCode } = await post(server, { refreshToken: VALID_TOKEN })
    expect(statusCode).toBe(200)
    expect(await isConnected(server)).toBe(true)

    await server.fastify.close()
  })

  it('rejects a missing token with 400 and stays disconnected', async () => {
    const server = await buildServer()
    const { statusCode } = await post(server, {})
    expect(statusCode).toBe(400)
    expect(await isConnected(server)).toBe(false)
    await server.fastify.close()
  })

  it('rejects a too-short token with 400', async () => {
    const server = await buildServer()
    const { statusCode } = await post(server, { refreshToken: 'short' })
    expect(statusCode).toBe(400)
    expect(await isConnected(server)).toBe(false)
    await server.fastify.close()
  })

  it('rejects a non-ASCII token with 400', async () => {
    const server = await buildServer()
    const { statusCode } = await post(server, {
      refreshToken: 'токен-достаточно-длинный-но-кириллица',
    })
    expect(statusCode).toBe(400)
    expect(await isConnected(server)).toBe(false)
    await server.fastify.close()
  })
})
