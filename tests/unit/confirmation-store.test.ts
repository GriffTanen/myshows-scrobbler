import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  setConfirmationStorePath,
  loadConfirmations,
  saveConfirmations,
} from '../../src/scrobblers/confirmation-store.js'
import type { MyShowsConfirmation } from '../../src/types.js'

let tmpDir: string
let storePath: string

function entry(title: string, status: 'confirmed' | 'failed' = 'confirmed'): MyShowsConfirmation {
  return { timestamp: new Date().toISOString(), title, status }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myshows-confirm-store-'))
  storePath = path.join(tmpDir, 'myshows-confirmations.json')
  setConfirmationStorePath(storePath)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  setConfirmationStorePath('')
})

describe('confirmation-store', () => {
  it('round-trips saved entries (newest-first order preserved)', () => {
    const list = [entry('C'), entry('B'), entry('A')]
    saveConfirmations(list)
    expect(loadConfirmations()).toEqual(list)
  })

  it('persists a failed entry with its reason', () => {
    const list: MyShowsConfirmation[] = [
      { timestamp: new Date().toISOString(), title: 'X', status: 'failed', reason: 'not found' },
    ]
    saveConfirmations(list)
    expect(loadConfirmations()).toEqual(list)
  })

  it('returns [] when the file does not exist yet', () => {
    expect(loadConfirmations()).toEqual([])
  })

  it('returns [] and does not throw on malformed JSON', () => {
    fs.writeFileSync(storePath, '{ this is not json', 'utf8')
    expect(loadConfirmations()).toEqual([])
  })

  it('drops entries that are not valid confirmations', () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify([
        { timestamp: 't', title: 'ok', status: 'confirmed' },
        { title: 'missing timestamp', status: 'confirmed' },
        { timestamp: 't', title: 'bad status', status: 'weird' },
        'not an object',
      ]),
      'utf8',
    )
    expect(loadConfirmations()).toEqual([{ timestamp: 't', title: 'ok', status: 'confirmed' }])
  })

  it('is a no-op when no path is configured (does not throw)', () => {
    setConfirmationStorePath('')
    expect(() => saveConfirmations([entry('A')])).not.toThrow()
    expect(loadConfirmations()).toEqual([])
  })
})
