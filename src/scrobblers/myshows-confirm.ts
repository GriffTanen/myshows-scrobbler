// EXPERIMENTAL, unofficial: auto-approves a scrobble right after it's sent, so it doesn't
// require a manual click in the "Ожидают" queue on myshows.me. The public scrobble API
// (/start, /pause, /stop) never returns the scrobbleId needed to approve it directly, so
// there's no way to call the confirm endpoint from the scrobble response alone.
// Workaround: read the freshly-created pending entry back out of the watch-history page
// (Nuxt SSR JSON payload) to resolve title/season/episode -> scrobbleId, then call the same
// internal `scrobble.SetStatus` RPC the site's own "Подтвердить" button uses.
//
// Note: `manage.CheckEpisode` / `manage.SetMovieStatus` (the site's separate "mark episode
// watched" buttons) were tried first and DO mark the episode watched in stats/counters, but
// leave the pending scrobble entry sitting in the queue forever — they're a different,
// independent system from scrobble approval. scrobble.SetStatus is the one that actually
// clears the queue entry (confirmed: it also updates the watched status/counters itself).
//
// Reverse-engineered from the site's JS bundle and devtools traffic; not a supported
// integration path. See myshows-web-auth.ts for the session-token half of this.
import { fetchWithTimeout } from '../http.js'
import { info, warn, error as logError } from '../logger.js'
import {
  getCachedAuthToken,
  getCurrentRefreshToken,
  refreshSessionAuthToken,
} from './myshows-web-auth.js'

const RPC_URL = 'https://myshows.me/v3/rpc/'
const WATCH_HISTORY_URL = 'https://myshows.me/profile/watch-history/'

interface PendingEntry {
  scrobbleId: number
  objectType: 'episode' | 'movie'
  title: string
  originalTitle: string | null
  season: number | null
  episode: number | null
}

/** What we need from a scrobbled item to find its matching pending entry. */
export interface ConfirmTarget {
  type: 'movie' | 'episode'
  title: string
  originalTitle: string | null
  showTitle: string | null
  showOriginalTitle: string | null
  season: number | null
  episode: number | null
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
 * Walk the Nuxt `__NUXT_DATA__` devalue-style array: `state.Scrobble.pending` holds an array
 * of indices, each pointing at a pending-entry object whose fields are themselves indices
 * into the same flat array (Nuxt interns repeated primitives). We resolve just the fields
 * we need rather than reconstructing the whole graph.
 */
function extractPendingEntries(html: string): PendingEntry[] {
  const scriptMatch = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!scriptMatch) {
    return []
  }

  let data: unknown[]
  try {
    data = JSON.parse(scriptMatch[1]) as unknown[]
  } catch (err) {
    logError(`[myshows-confirm] Failed to parse __NUXT_DATA__: ${(err as Error).message}`)
    return []
  }

  const pendingIdx = html.indexOf('"pending":')
  if (pendingIdx < 0) {
    return []
  }
  const pendingKeyMatch = /"pending":(\d+)/.exec(html.slice(pendingIdx, pendingIdx + 40))
  if (!pendingKeyMatch) {
    return []
  }

  const pendingList = data[Number(pendingKeyMatch[1])]
  if (!Array.isArray(pendingList)) {
    return []
  }

  const deref = (idx: unknown): unknown =>
    typeof idx === 'number' ? resolveNuxtRef(data, data[idx], 0) : undefined

  const entries: PendingEntry[] = []
  for (const entryIdx of pendingList) {
    const entry = deref(entryIdx) as Record<string, unknown> | undefined
    if (!entry) {
      continue
    }
    // Every field on `entry` (including `id`, the scrobbleId scrobble.SetStatus expects) is
    // itself an index into `data`, NOT the value directly — same as objectType/title/etc.
    // below. Skipping the deref() here was a real bug: it silently took the raw array index
    // (e.g. 60) as if it were the scrobbleId, matching schema shape but wrong data, so
    // scrobble.SetStatus rejected it as "Not found" without any type/parse error to catch it.
    const scrobbleId = deref(entry.id)
    if (typeof scrobbleId !== 'number') {
      continue
    }
    const objectType = deref(entry.objectType)
    if (objectType !== 'episode' && objectType !== 'movie') {
      continue
    }
    const title = deref(entry.title)
    if (typeof title !== 'string') {
      continue
    }
    const originalTitle = deref(entry.originalTitle)
    const season = deref(entry.season)
    const episode = deref(entry.episode)

    entries.push({
      scrobbleId,
      objectType,
      title,
      originalTitle: typeof originalTitle === 'string' ? originalTitle : null,
      season: typeof season === 'number' ? season : null,
      episode: typeof episode === 'number' ? episode : null,
    })
  }
  return entries
}

function titlesMatch(a: string, b: string | null): boolean {
  return b !== null && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Pick the pending entry matching a scrobbled item. Episodes match on season+episode plus
 * either title; movies match on title only. Ambiguous on rewatches or duplicate titles —
 * picks the first match, which is a real (accepted) limitation of not having a direct ID.
 */
function findMatch(entries: PendingEntry[], target: ConfirmTarget): PendingEntry | null {
  return (
    entries.find((e) => {
      if (e.objectType !== target.type) {
        return false
      }
      if (target.type === 'movie') {
        return titlesMatch(e.title, target.title) || titlesMatch(e.title, target.originalTitle)
      }
      const nameMatches =
        titlesMatch(e.title, target.showTitle) || titlesMatch(e.title, target.showOriginalTitle)
      return nameMatches && e.season === target.season && e.episode === target.episode
    }) ?? null
  )
}

/**
 * null = auth rejected (caller should refresh and retry); [] = fetched fine, nothing pending.
 *
 * Needs BOTH msAuthToken and msRefreshToken cookies together — a request with only
 * msAuthToken gets a bare 301 to /login/ with no Set-Cookie at all, confirmed by testing
 * directly against the site. msRefreshToken isn't just a fallback for an expired access
 * token here; the site's own session check apparently requires it present on every request.
 */
async function fetchPendingEntries(
  authToken: string,
  refreshToken: string,
): Promise<PendingEntry[] | null> {
  const response = await fetchWithTimeout(WATCH_HISTORY_URL, {
    headers: {
      'Cookie': `msAuthToken=${authToken}; msRefreshToken=${refreshToken}`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
    redirect: 'manual',
  })

  if (response.status !== 200) {
    logError(`[myshows-confirm] watch-history fetch got HTTP ${response.status}, expected 200`)
    return null
  }

  return extractPendingEntries(await response.text())
}

/** 'auth' = token rejected, caller should refresh and retry; 'other' = any other failure. */
type RpcOutcome = { ok: true } | { ok: false; reason: 'auth' | 'other' }

async function callSetStatus(authToken: string, scrobbleId: number): Promise<RpcOutcome> {
  return callRpc(authToken, 'scrobble.SetStatus', { scrobbleId, status: 'approved' })
}

async function callRpc(
  authToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcOutcome> {
  const response = await fetchWithTimeout(`${RPC_URL}?method=${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization2': `Bearer ${authToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

  if (!response.ok) {
    logError(`[myshows-confirm] ${method} HTTP error: ${response.status}`)
    return { ok: false, reason: 'other' }
  }

  const data = (await response.json()) as {
    error?: { code: number; message: string }
    result?: boolean
  }
  if (data.error) {
    logError(
      `[myshows-confirm] ${method} rejected (params=${JSON.stringify(params)}): ${data.error.message}`,
    )
    return { ok: false, reason: data.error.code === 401 ? 'auth' : 'other' }
  }
  return data.result === true ? { ok: true } : { ok: false, reason: 'other' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// MyShows has a replication lag between the system backing the watch-history page and the one
// scrobble.SetStatus reads from: the pending entry (with a valid scrobbleId) is visible in
// watch-history's HTML immediately after /stop, but SetStatus on that same, correct scrobbleId
// can still reply "Not found" — confirmed by retrying the exact same scrobbleId manually
// several seconds (and, once, over a minute) later, which then succeeded. The lag isn't a
// known fixed constant, so this retries the whole find-then-confirm attempt (not just the
// lookup) with a growing backoff over ~2 minutes total before giving up.
const CONFIRM_RETRY_DELAYS_MS = [2000, 3000, 5000, 8000, 13000, 21000, 34000]

/** Result of one find-then-confirm attempt, distinguishing retryable from terminal failure. */
type AttemptResult = 'confirmed' | 'not_found_yet' | 'give_up'

/**
 * One find-then-confirm pass: look up the pending entry, then call scrobble.SetStatus on it.
 * Returns 'not_found_yet' both when no matching entry exists yet in watch-history, and when
 * SetStatus rejects a freshly-found scrobbleId as not found (replication lag between the two
 * — see CONFIRM_RETRY_DELAYS_MS) — both cases are worth retrying. Auth failures refresh the
 * session token once inline and retry immediately (not worth a backoff, it's not a lag issue).
 */
async function attemptConfirm(
  authToken: string,
  refreshToken: string,
  target: ConfirmTarget,
): Promise<AttemptResult> {
  let entries = await fetchPendingEntries(authToken, refreshToken)
  if (entries === null) {
    const newAuthToken = await refreshSessionAuthToken()
    const newRefreshToken = getCurrentRefreshToken()
    if (!newAuthToken || !newRefreshToken) {
      return 'give_up'
    }
    entries = await fetchPendingEntries(newAuthToken, newRefreshToken)
    if (entries === null) {
      logError('[myshows-confirm] watch-history fetch failed even after refreshing the session')
      return 'give_up'
    }
    authToken = newAuthToken
  }

  const match = findMatch(entries, target)
  if (!match) {
    return 'not_found_yet'
  }
  info(`[myshows-confirm] Matched scrobbleId=${match.scrobbleId} for confirmation`)

  let outcome = await callSetStatus(authToken, match.scrobbleId)
  if (!outcome.ok && outcome.reason === 'auth') {
    const newAuthToken = await refreshSessionAuthToken()
    if (!newAuthToken) {
      return 'give_up'
    }
    outcome = await callSetStatus(newAuthToken, match.scrobbleId)
  }

  return outcome.ok ? 'confirmed' : 'not_found_yet'
}

/**
 * Best-effort auto-approve: find the just-created pending entry matching a scrobbled item
 * and mark it watched directly, skipping the scrobble/pending/approve flow entirely.
 * Failures are logged and swallowed — this must never affect the primary scrobble flow
 * (the /stop call already succeeded; this is a bonus convenience layered on top).
 *
 * Retries the whole find-then-confirm pass with a backoff, since MyShows' own replication
 * lag (see CONFIRM_RETRY_DELAYS_MS) means a freshly-found, correct scrobbleId can still be
 * rejected as not-found for the first several seconds after /stop.
 */
export async function autoConfirmScrobble(target: ConfirmTarget, logLabel: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    // Re-read on every attempt: a prior attempt may have rotated the refresh token or cached
    // a new access token, and the next attempt must use those, not a stale closed-over copy.
    const authToken = getCachedAuthToken() ?? (await refreshSessionAuthToken())
    const refreshToken = authToken ? getCurrentRefreshToken() : null
    if (!authToken || !refreshToken) {
      return
    }

    const result = await attemptConfirm(authToken, refreshToken, target)
    if (result === 'confirmed') {
      info(`[myshows-confirm] Auto-confirmed: ${logLabel}`)
      return
    }
    if (result === 'give_up' || attempt >= CONFIRM_RETRY_DELAYS_MS.length) {
      if (result === 'not_found_yet') {
        warn(`[myshows-confirm] Gave up confirming "${logLabel}" after ${attempt + 1} attempts`)
      }
      return
    }
    await sleep(CONFIRM_RETRY_DELAYS_MS[attempt])
  }
}
