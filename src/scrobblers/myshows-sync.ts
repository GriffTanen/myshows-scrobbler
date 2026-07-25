// EXPERIMENTAL, unofficial: one-way history import Jellyfin -> MyShows (Stage 1 of the
// watched-status sync feature). Reads what's already watched in Jellyfin and marks the
// missing entries as watched on MyShows via the same reverse-engineered internal RPC used by
// auto-confirm (see myshows-confirm.ts / myshows-web-auth.ts). Reads never mutate; the only
// writes are manage.CheckEpisode / manage.SetMovieStatus, and only for entries not already
// marked on MyShows (idempotent — a re-run adds nothing).
//
// Verified live against the account: shows.Search {query} -> showId; shows.GetById
// {showId, withEpisodes:true} -> episodes with MyShows epId + season/episode; profile.Episodes
// {showId} -> already-watched episode ids; manage.CheckEpisode {id}; manage.SetMovieStatus
// {id, status}. MyShows uses its own internal show/episode ids, so a mapping step (search by
// original title, disambiguate by year) is required.
import { fetchWithTimeout } from '../http.js'
import { info, warn, error as logError } from '../logger.js'
import {
  getCachedAuthToken,
  getCurrentRefreshToken,
  refreshSessionAuthToken,
} from './myshows-web-auth.js'

const RPC_URL = 'https://myshows.me/v3/rpc/'

/** A watched item read from Jellyfin, normalized for mapping onto MyShows. */
export interface PlayedItem {
  kind: 'movie' | 'episode'
  /** Localized title (episode name for episodes, movie title for movies). */
  title: string
  /** Show title for episodes / movie title for movies — used for shows.Search. */
  searchTitle: string
  /** Original (non-localized) title, preferred for search when present. */
  originalTitle: string | null
  year: number | null
  season: number | null
  episode: number | null
  imdb: string | null
  tmdb: string | null
}

/** One resolved unit of work in a preview. */
export interface PlanEntry {
  kind: 'movie' | 'episode'
  label: string
  /** MyShows internal id to mark (episode id or movie/show id), when resolved. */
  targetId: number | null
  status: 'already' | 'toAdd' | 'unmatched'
  /** Why it couldn't be matched, for the unmatched list. */
  reason?: string
}

export interface SyncPreview {
  foundMovies: number
  foundEpisodes: number
  already: number
  toAdd: number
  unmatched: number
  /** The unmatched entries, for showing the user what will be skipped. */
  unmatchedList: { label: string; reason: string }[]
  /** The concrete units to apply (status === 'toAdd'), carried to /apply. */
  plan: PlanEntry[]
}

export interface ApplyResult {
  added: number
  skipped: number
  failed: number
}

// ── RPC plumbing ────────────────────────────────────────────────────────────

interface RpcResult<T> {
  ok: boolean
  data?: T
  auth?: boolean
}

async function rpcCall<T>(
  authToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResult<T>> {
  let response: Response
  try {
    response = await fetchWithTimeout(`${RPC_URL}?method=${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization2': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch (err) {
    logError(`[myshows-sync] ${method} request failed: ${(err as Error).message}`)
    return { ok: false }
  }

  if (!response.ok) {
    logError(`[myshows-sync] ${method} HTTP ${response.status}`)
    return { ok: false }
  }

  const body = (await response.json()) as {
    error?: { code: number; message: string }
    result?: T
  }
  if (body.error) {
    return { ok: false, auth: body.error.code === 401 }
  }
  return { ok: true, data: body.result }
}

/** Obtain a usable session auth token, refreshing once if needed. Null = no session. */
async function ensureAuthToken(): Promise<string | null> {
  const cached = getCachedAuthToken()
  if (cached) {
    return cached
  }
  const refreshed = await refreshSessionAuthToken()
  return refreshed
}

/** Run an RPC, refreshing the session token once on a 401 and retrying. */
async function rpcWithRefresh<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T | null> {
  let token = await ensureAuthToken()
  if (!token || !getCurrentRefreshToken()) {
    return null
  }
  let res = await rpcCall<T>(token, method, params)
  if (!res.ok && res.auth) {
    const fresh = await refreshSessionAuthToken()
    if (!fresh) {
      return null
    }
    token = fresh
    res = await rpcCall<T>(token, method, params)
  }
  return res.ok ? (res.data ?? null) : null
}

// ── MyShows RPC shapes (only the fields we use) ──────────────────────────────

interface SearchShow {
  id: number
  title: string
  titleOriginal: string
  year: number | null
}
interface ShowEpisode {
  id: number
  seasonNumber: number
  episodeNumber: number
}
interface ShowWithEpisodes {
  id: number
  episodes?: ShowEpisode[]
}
interface ProfileEpisode {
  id: number
}
interface CatalogMovie {
  id: number
  title: string
  titleOriginal: string
  year: number | null
}
interface ProfileMovie {
  watchStatus: string | null
}

async function searchShow(query: string): Promise<SearchShow[]> {
  return (await rpcWithRefresh<SearchShow[]>('shows.Search', { query })) ?? []
}
async function getShowEpisodes(showId: number): Promise<ShowEpisode[]> {
  const show = await rpcWithRefresh<ShowWithEpisodes>('shows.GetById', {
    showId,
    withEpisodes: true,
  })
  return show?.episodes ?? []
}
async function getProfileWatchedEpisodeIds(showId: number): Promise<Set<number>> {
  const list = (await rpcWithRefresh<ProfileEpisode[]>('profile.Episodes', { showId })) ?? []
  return new Set(list.map((e) => e.id))
}
async function checkEpisode(episodeId: number): Promise<boolean> {
  const res = await rpcWithRefresh<unknown>('manage.CheckEpisode', { id: episodeId })
  return res !== null
}
async function searchMovie(query: string): Promise<CatalogMovie[]> {
  const rows =
    (await rpcWithRefresh<{ movie: CatalogMovie }[]>('movies.GetCatalog', {
      search: { query },
      page: 0,
      pageSize: 10,
    })) ?? []
  return rows.map((r) => r.movie).filter((m): m is CatalogMovie => !!m && typeof m.id === 'number')
}
/** true = already marked watched on MyShows, false = not, null = lookup failed. */
async function isMovieWatched(movieId: number): Promise<boolean | null> {
  const res = await rpcWithRefresh<ProfileMovie>('profile.Movie', { movieId })
  if (res === null) {
    return null
  }
  return res.watchStatus !== null
}
async function setMovieFinished(movieId: number): Promise<boolean> {
  // Note: the movie variant takes `movieId` (the episode variant takes `id`); passing `id` here
  // silently resolves to movieId=0 and 404s.
  const res = await rpcWithRefresh<unknown>('manage.SetMovieStatus', {
    movieId,
    status: 'finished',
  })
  return res !== null
}
// ── Pure mapping helpers (unit-tested) ───────────────────────────────────────

/**
 * Choose the best MyShows candidate for a Jellyfin title: the sole candidate, else the one whose
 * year matches exactly. Ambiguous with no year tiebreak → null (don't guess). Shared by shows
 * and movies since both carry a `year`.
 */
export function pickByYear<T extends { year: number | null }>(
  candidates: T[],
  year: number | null,
): T | null {
  if (candidates.length === 0) {
    return null
  }
  if (candidates.length === 1) {
    return candidates[0]
  }
  if (year !== null) {
    const exact = candidates.find((c) => c.year === year)
    if (exact) {
      return exact
    }
  }
  return null
}

/** Convenience wrappers so call sites and tests read naturally. */
export function pickShow(candidates: SearchShow[], year: number | null): SearchShow | null {
  return pickByYear(candidates, year)
}
export function pickMovie(candidates: CatalogMovie[], year: number | null): CatalogMovie | null {
  return pickByYear(candidates, year)
}

/** Map (season, episode) to a MyShows episode id from a show's episode list. */
export function findEpisodeId(
  episodes: ShowEpisode[],
  season: number,
  episode: number,
): number | null {
  const match = episodes.find((e) => e.seasonNumber === season && e.episodeNumber === episode)
  return match ? match.id : null
}

/** Group played episodes by their show search key so each show is resolved once. */
export function groupEpisodesByShow(items: PlayedItem[]): Map<string, PlayedItem[]> {
  const groups = new Map<string, PlayedItem[]>()
  for (const item of items) {
    if (item.kind !== 'episode') {
      continue
    }
    const key = (item.originalTitle ?? item.searchTitle).trim().toLowerCase()
    const list = groups.get(key)
    if (list) {
      list.push(item)
    } else {
      groups.set(key, [item])
    }
  }
  return groups
}

// ── Preview + apply ──────────────────────────────────────────────────────────

export type ProgressFn = (done: number, total: number) => void

/**
 * Resolve every played item against MyShows without writing anything: search the show, map
 * episodes to ids, and diff against what's already marked as watched. Movies are reported as
 * unmatched-for-now (see note) so Stage 1 ships episode import — the common, high-volume case —
 * without risking wrong movie writes.
 */
export async function buildPreview(
  items: PlayedItem[],
  onProgress?: ProgressFn,
): Promise<SyncPreview> {
  const foundMovies = items.filter((i) => i.kind === 'movie').length
  const foundEpisodes = items.filter((i) => i.kind === 'episode').length

  const plan: PlanEntry[] = []
  const groups = groupEpisodesByShow(items)
  const movies = items.filter((i) => i.kind === 'movie')
  let processed = 0
  const total = groups.size + movies.length

  for (const [, episodes] of groups) {
    processed += 1
    onProgress?.(processed, total)

    const first = episodes[0]
    const query = first.originalTitle ?? first.searchTitle
    const candidates = await searchShow(query)
    const show = pickShow(candidates, first.year)
    if (!show) {
      for (const ep of episodes) {
        plan.push({
          kind: 'episode',
          label: episodeLabel(ep),
          targetId: null,
          status: 'unmatched',
          reason:
            candidates.length === 0 ? 'сериал не найден в MyShows' : 'неоднозначное совпадение',
        })
      }
      continue
    }

    const showEpisodes = await getShowEpisodes(show.id)
    const alreadyWatched = await getProfileWatchedEpisodeIds(show.id)

    for (const ep of episodes) {
      if (ep.season === null || ep.episode === null) {
        plan.push({
          kind: 'episode',
          label: episodeLabel(ep),
          targetId: null,
          status: 'unmatched',
          reason: 'нет номера сезона/эпизода',
        })
        continue
      }
      const epId = findEpisodeId(showEpisodes, ep.season, ep.episode)
      if (epId === null) {
        plan.push({
          kind: 'episode',
          label: episodeLabel(ep),
          targetId: null,
          status: 'unmatched',
          reason: 'эпизод не найден в MyShows',
        })
        continue
      }
      plan.push({
        kind: 'episode',
        label: episodeLabel(ep),
        targetId: epId,
        status: alreadyWatched.has(epId) ? 'already' : 'toAdd',
      })
    }
  }

  // Movies: search the catalog, disambiguate by year, diff against the profile's watch status.
  for (const movie of movies) {
    processed += 1
    onProgress?.(processed, total)

    const label = `${movie.title}${movie.year ? ` (${movie.year})` : ''}`
    const query = movie.originalTitle ?? movie.searchTitle
    const candidates = await searchMovie(query)
    const match = pickMovie(candidates, movie.year)
    if (!match) {
      plan.push({
        kind: 'movie',
        label,
        targetId: null,
        status: 'unmatched',
        reason: candidates.length === 0 ? 'фильм не найден в MyShows' : 'неоднозначное совпадение',
      })
      continue
    }
    const watched = await isMovieWatched(match.id)
    if (watched === null) {
      plan.push({
        kind: 'movie',
        label,
        targetId: null,
        status: 'unmatched',
        reason: 'не удалось проверить статус',
      })
      continue
    }
    plan.push({
      kind: 'movie',
      label,
      targetId: match.id,
      status: watched ? 'already' : 'toAdd',
    })
  }

  const already = plan.filter((p) => p.status === 'already').length
  const toAdd = plan.filter((p) => p.status === 'toAdd').length
  const unmatchedEntries = plan.filter((p) => p.status === 'unmatched')

  return {
    foundMovies,
    foundEpisodes,
    already,
    toAdd,
    unmatched: unmatchedEntries.length,
    unmatchedList: unmatchedEntries.slice(0, 100).map((p) => ({
      label: p.label,
      reason: p.reason ?? '',
    })),
    plan,
  }
}

function episodeLabel(item: PlayedItem): string {
  const show = item.searchTitle
  const se =
    item.season !== null && item.episode !== null ? ` · S${item.season}E${item.episode}` : ''
  return `${show}${se}`
}

/**
 * Apply a preview's toAdd episodes: mark each as watched on MyShows. Sequential (one RPC at a
 * time) so the session token is never hit concurrently — same reasoning as auto-confirm's mutex.
 */
export async function applyImport(
  plan: PlanEntry[],
  onProgress?: ProgressFn,
): Promise<ApplyResult> {
  const toAdd = plan.filter((p) => p.status === 'toAdd' && p.targetId !== null)
  let added = 0
  let failed = 0

  for (let i = 0; i < toAdd.length; i++) {
    const entry = toAdd[i]
    const ok =
      entry.kind === 'episode'
        ? await checkEpisode(entry.targetId as number)
        : await setMovieFinished(entry.targetId as number)
    if (ok) {
      added += 1
    } else {
      failed += 1
    }
    onProgress?.(i + 1, toAdd.length)
  }

  const skipped = plan.filter((p) => p.status !== 'toAdd').length
  if (failed > 0) {
    warn(`[myshows-sync] Import finished with ${failed} failures (added ${added})`)
  } else {
    info(`[myshows-sync] Import complete: added ${added}, skipped ${skipped}`)
  }
  return { added, skipped, failed }
}
