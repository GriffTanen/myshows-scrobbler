// EXPERIMENTAL, unofficial: reverse-engineered from the myshows.me web client, not part of
// the public scrobble API. Reproduces the browser's SSR auth flow to obtain a session
// `auth.token` for calling internal `/v3/rpc/` methods (see myshows-confirm.ts) — the public
// scrobble token (config `myshows_token`) is rejected by those methods (401 Invalid token).
//
// `msRefreshToken` is a ROTATING refresh token: the server only accepts it once. A successful
// GET issues a new `msRefreshToken` in the response Set-Cookie header, which MUST replace the
// stored one before the next call — reusing a spent token gets a 301 to /login/ and can also
// invalidate a concurrently-running browser session using the same token. Persisted to disk
// so a restart doesn't burn the last known-good token by starting from an empty file.
import fs from 'node:fs'
import path from 'node:path'
import { fetchWithTimeout } from '../http.js'
import { info, warn, error as logError } from '../logger.js'

const WATCH_HISTORY_URL = 'https://myshows.me/profile/watch-history/'

interface WebAuthState {
  refreshToken: string
  /** Cached from the last successful fetch — reused until a call rejects it (401/redirect),
   *  so we don't burn the one-shot rotating refresh token on every confirm. */
  authToken?: string
}

let statePath = ''

export function setWebAuthStatePath(p: string): void {
  statePath = p
}

function readState(): WebAuthState | null {
  try {
    if (!statePath || !fs.existsSync(statePath)) {
      return null
    }
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<WebAuthState>
    return raw.refreshToken ? { refreshToken: raw.refreshToken, authToken: raw.authToken } : null
  } catch (err) {
    logError(`[myshows-web-auth] Failed to read state: ${(err as Error).message}`)
    return null
  }
}

function writeState(state: WebAuthState): void {
  try {
    const dir = path.dirname(statePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    logError(`[myshows-web-auth] Failed to persist state: ${(err as Error).message}`)
  }
}

/** Seed the rotating refresh token once (e.g. from a value copied out of the browser). */
export function seedRefreshToken(refreshToken: string): void {
  writeState({ refreshToken })
}

/** Parse a single Set-Cookie value into [name, value], ignoring attributes (Path, Max-Age, ...). */
function parseCookiePair(setCookieValue: string): [string, string] | null {
  const first = setCookieValue.split(';', 1)[0]
  const eq = first.indexOf('=')
  if (eq < 0) {
    return null
  }
  return [first.slice(0, eq).trim(), first.slice(eq + 1).trim()]
}

/**
 * Extract `state.auth.token`'s value out of the Nuxt SSR payload (`__NUXT_DATA__`).
 *
 * __NUXT_DATA__ is a JSON array using an index-reference format (Nuxt devalue-style): a
 * `"token": N` key inside the auth state object points at array index N, which holds the
 * actual string value (not embedded inline). We anchor on the `"auth":` state slot rather
 * than parsing the whole Pinia graph, then walk to the referenced index.
 *
 * On failure this logs a snippet of HTML around the anchor points actually found, so a
 * format change on the site's side can be diagnosed from logs alone — reproducing it costs
 * a live (one-shot, rotating) refresh token, so guessing blind here is expensive.
 */
function extractAuthToken(html: string): string | null {
  const scriptMatch = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!scriptMatch) {
    logError('[myshows-web-auth] __NUXT_DATA__ script tag not found in response')
    return null
  }

  let data: unknown[]
  try {
    data = JSON.parse(scriptMatch[1]) as unknown[]
  } catch (err) {
    logError(`[myshows-web-auth] Failed to parse __NUXT_DATA__ JSON: ${(err as Error).message}`)
    return null
  }

  const authIdx = html.indexOf('"auth":')
  if (authIdx < 0) {
    logError('[myshows-web-auth] "auth" state key not found in __NUXT_DATA__')
    return null
  }
  const tokenKeyMatch = /"token":(\d+)/.exec(html.slice(authIdx, authIdx + 200))
  if (!tokenKeyMatch) {
    logError(
      `[myshows-web-auth] "token" reference not found near "auth" key. Context: ${html.slice(authIdx, authIdx + 200)}`,
    )
    return null
  }

  const targetIndex = Number(tokenKeyMatch[1])
  const value = resolveNuxtRef(data, data[targetIndex], 0)
  if (typeof value !== 'string') {
    logError(
      `[myshows-web-auth] Resolved auth.token index ${targetIndex} is not a string (got ${typeof value}: ${JSON.stringify(value)})`,
    )
    return null
  }
  return value
}

/**
 * Nuxt/Vue's devalue-style payload wraps reactive values as `["Ref", N]` /
 * `["ShallowReactive", N]` / `["EmptyRef", N]` tuples pointing at another array index holding
 * the actual value, which can itself be another wrapper. Unwrap up to a handful of hops
 * before giving up — a real payload never nests this deep, so a low cap just prevents an
 * infinite loop on a malformed/cyclic array without needing cycle-tracking.
 */
function resolveNuxtRef(data: unknown[], value: unknown, depth: number): unknown {
  if (depth > 5) {
    return value
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  ) {
    return resolveNuxtRef(data, data[value[1]], depth + 1)
  }
  return value
}

/**
 * Return the last-known session `auth.token` without touching the network or the rotating
 * refresh token. This is the access token — it's valid for ~14 days — so callers should try
 * it first and only fall back to `refreshSessionAuthToken()` if the RPC call rejects it.
 * Returns null when no refresh token has ever been seeded (auto-confirm never configured).
 */
export function getCachedAuthToken(): string | null {
  return readState()?.authToken ?? null
}

/**
 * Return the current rotating refresh token as-is (not spent, not rotated). The site's
 * session check on regular pages (e.g. watch-history) requires this cookie present
 * alongside msAuthToken on every request — it isn't purely a fallback for a stale access
 * token. Returns null when no refresh token has ever been seeded.
 */
export function getCurrentRefreshToken(): string | null {
  return readState()?.refreshToken ?? null
}

/**
 * Spend the persisted (one-shot, rotating) `msRefreshToken` to obtain a fresh session
 * `auth.token`, and cache it for `getCachedAuthToken()`. Only call this when there's no
 * cached token yet, or the cached one was just rejected — every call here burns the current
 * refresh token and requires the server's freshly-issued replacement to be captured
 * correctly, so it should not run more often than necessary. Returns null when there's no
 * stored refresh token, the request fails, or the server rejects it (rotation already spent,
 * session revoked, ...) — callers should treat that as "auto-confirm unavailable this time"
 * and skip, not retry aggressively.
 */
export async function refreshSessionAuthToken(): Promise<string | null> {
  const state = readState()
  if (!state) {
    warn('[myshows-web-auth] No refresh token configured — auto-confirm disabled')
    return null
  }

  const response = await fetchWithTimeout(WATCH_HISTORY_URL, {
    headers: {
      'Cookie': `msRefreshToken=${state.refreshToken}`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
    redirect: 'manual',
  })

  if (response.status !== 200) {
    logError(
      `[myshows-web-auth] Session refresh failed: HTTP ${response.status} (refresh token likely rotated or revoked)`,
    )
    return null
  }

  // Rotation: capture and PERSIST the new msRefreshToken from Set-Cookie immediately, before
  // touching the response body at all. The old refresh token is spent the instant the server
  // accepted this request — if anything below fails (HTML parsing, unexpected format), we must
  // not lose the one chance to save its replacement, or auto-confirm is permanently stuck
  // until a human re-seeds a fresh token from the browser.
  const setCookieHeaders =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  let newRefreshToken: string | null = null
  for (const header of setCookieHeaders) {
    const pair = parseCookiePair(header)
    if (pair && pair[0] === 'msRefreshToken' && pair[1]) {
      newRefreshToken = pair[1]
    }
  }
  const effectiveRefreshToken =
    newRefreshToken && newRefreshToken !== state.refreshToken ? newRefreshToken : state.refreshToken
  if (newRefreshToken && newRefreshToken !== state.refreshToken) {
    writeState({ refreshToken: effectiveRefreshToken, authToken: state.authToken })
    info('[myshows-web-auth] Rotated session refresh token')
  }

  const html = await response.text()
  const token = extractAuthToken(html)
  if (!token) {
    logError('[myshows-web-auth] Could not locate auth.token in SSR payload')
    return null
  }

  writeState({ refreshToken: effectiveRefreshToken, authToken: token })
  return token
}
