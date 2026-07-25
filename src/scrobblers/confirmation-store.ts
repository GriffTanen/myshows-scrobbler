// Persists the auto-confirm history (newest-first) to disk so it survives a container
// restart — the in-memory ring buffer in server.ts is seeded from load() on startup and
// mirrored here on every append. Best-effort: any fs error is logged and swallowed, this
// is auxiliary UI data and must never disrupt the scrobble/confirm flow. Mirrors the
// on-disk state pattern in myshows-web-auth.ts.
import fs from 'node:fs'
import path from 'node:path'
import type { MyShowsConfirmation } from '../types.js'
import { error as logError } from '../logger.js'

let storePath = ''

export function setConfirmationStorePath(p: string): void {
  storePath = p
}

/** Read the persisted history (newest-first). Returns [] when unset, missing, or malformed. */
export function loadConfirmations(): MyShowsConfirmation[] {
  try {
    if (!storePath || !fs.existsSync(storePath)) {
      return []
    }
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as unknown
    if (!Array.isArray(raw)) {
      return []
    }
    return raw.filter(
      (e): e is MyShowsConfirmation =>
        !!e &&
        typeof (e as MyShowsConfirmation).timestamp === 'string' &&
        typeof (e as MyShowsConfirmation).title === 'string' &&
        ((e as MyShowsConfirmation).status === 'confirmed' ||
          (e as MyShowsConfirmation).status === 'failed'),
    )
  } catch (err) {
    logError(`[confirmation-store] Failed to read history: ${(err as Error).message}`)
    return []
  }
}

/**
 * Persist the full newest-first list (already capped by the caller). Written atomically via
 * a temp file + rename so a crash mid-write can't leave a truncated JSON that loadConfirmations
 * would then drop. No-op when no path is configured.
 */
export function saveConfirmations(entries: MyShowsConfirmation[]): void {
  if (!storePath) {
    return
  }
  try {
    const dir = path.dirname(storePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const tmp = `${storePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8')
    fs.renameSync(tmp, storePath)
  } catch (err) {
    logError(`[confirmation-store] Failed to persist history: ${(err as Error).message}`)
  }
}
