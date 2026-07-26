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
  /** The user's own rating, 0 (unrated) to 5. */
  rating?: number | null
}
interface ProfileShow {
  show: { id: number; title: string; titleOriginal: string }
  /** The user's own rating for the show, 0 (unrated) to 5 (top-level, not the show's avg). */
  rating?: number | null
}
interface ShowWithImdb {
  id: number
  title: string
  titleOriginal: string
  imdbId: number | null
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
/** MyShows movie's imdb id (already the tt… form), or null. Used to cross-check a title match. */
async function getMovieImdb(movieId: number): Promise<string | null> {
  const res = await rpcWithRefresh<{ imdbId: string | null }>('movies.GetById', { movieId })
  return res?.imdbId ?? null
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

// ── MyShows rating read/write (rating sync) ──────────────────────────────────

/** The user's rating for a movie on MyShows (0.5–5 half-star), or null when unrated / lookup failed. */
async function getMovieRating(movieId: number): Promise<number | null> {
  const res = await rpcWithRefresh<ProfileMovie>('profile.Movie', { movieId })
  const r = res?.rating
  return typeof r === 'number' && r > 0 ? r : null
}
/** Set (0.5–5 half-star) or clear (0) the user's rating for a movie. Returns success. */
async function rateMovie(movieId: number, rating: number): Promise<boolean> {
  const res = await rpcWithRefresh<unknown>('manage.RateMovie', { movieId, rating })
  return res !== null
}
/** Set (0.5–5 half-star) or clear (0) the user's rating for a show. Note: the param key is `id`, not `showId`. */
async function rateShow(showId: number, rating: number): Promise<boolean> {
  const res = await rpcWithRefresh<unknown>('manage.RateShow', { id: showId, rating })
  return res !== null
}

// ── MyShows read-side (reverse import: MyShows -> Jellyfin) ──

/** The user's shows on MyShows (id + titles). */
async function getProfileShows(): Promise<{ id: number; title: string; titleOriginal: string }[]> {
  const list = (await rpcWithRefresh<ProfileShow[]>('profile.Shows', {})) ?? []
  return list.map((r) => r.show).filter((sh) => !!sh && typeof sh.id === 'number')
}

/** The user's shows on MyShows with their own rating (0.5–5 half-star, or null when unrated), for rating sync. */
async function getProfileShowsWithRating(): Promise<
  { id: number; title: string; titleOriginal: string; rating: number | null }[]
> {
  const list = (await rpcWithRefresh<ProfileShow[]>('profile.Shows', {})) ?? []
  return list
    .filter((r) => !!r.show && typeof r.show.id === 'number')
    .map((r) => ({
      id: r.show.id,
      title: r.show.title,
      titleOriginal: r.show.titleOriginal,
      rating: typeof r.rating === 'number' && r.rating > 0 ? r.rating : null,
    }))
}

/** MyShows show's imdb id as the full `tt…` form, or null when the show has none. */
async function getShowImdb(showId: number): Promise<string | null> {
  const show = await rpcWithRefresh<ShowWithImdb>('shows.GetById', { showId, withEpisodes: false })
  return show?.imdbId != null ? imdbFromMyShows(show.imdbId) : null
}

/**
 * MyShows stores the imdb id as a bare number (e.g. 149460 for Futurama); IMDb ids are `tt` +
 * a zero-padded (min 7) digit string (tt0149460). Longer ids keep their length (tt13443470).
 */
export function imdbFromMyShows(id: number): string {
  return 'tt' + String(id).padStart(7, '0')
}

// ── Rating scale conversion ──────────────────────────────────────────────────
// MyShows rates 0–5 in half-star steps (0, 0.5, 1, … 5) — the internal RPC accepts and reports
// fractional values and rejects anything > 5 ("invalid rating"). Jellyfin rates 0–10. The two are
// the same 10-notch scale at a ×2 offset, so conversion is exact in both directions.

/**
 * MyShows rating (0–5, half-star) → Jellyfin rating (0–10). Exact ×2 (3.5★→7, 5★→10).
 * Null/0 (unrated) stays null.
 */
export function myshowsToJellyfinRating(ms: number | null): number | null {
  if (ms == null || ms <= 0) {
    return null
  }
  return Math.min(10, ms * 2)
}

/**
 * Jellyfin rating (0–10) → MyShows rating (0.5–5, half-star). Round to the nearest whole Jellyfin
 * point, then halve — so 7→3.5, 5→2.5, 1→0.5 — landing exactly on a valid MyShows half-star and
 * never dropping a real rating to "unrated". Null/0 stays null. Exact inverse of the ×2 above for
 * whole-point Jellyfin ratings, which keeps re-preview idempotent.
 */
export function jellyfinToMyshowsRating(jf: number | null): number | null {
  if (jf == null || jf <= 0) {
    return null
  }
  return Math.min(5, Math.max(0.5, Math.round(jf) / 2))
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

// ── Reverse import: MyShows -> Jellyfin (Stage 2, shows only) ────────────────

/** Narrow view of the Jellyfin adapter the reverse import needs (keeps this module decoupled). */
/** A movie read from Jellyfin for the reverse import (status + mapping fields). */
export interface JellyfinMovie {
  itemId: string
  title: string
  originalTitle: string | null
  year: number | null
  imdb: string | null
  played: boolean
  /** The user's Jellyfin rating, 0–10 or null when unrated (for rating sync). */
  rating: number | null
}

/** A series read from Jellyfin for rating sync: item id, imdb (for the MyShows match), rating. */
export interface JellyfinSeries {
  itemId: string
  imdb: string
  rating: number | null
}

export interface JellyfinReverseTarget {
  resolveUserId(): Promise<string | null>
  fetchSeriesImdbIndex(userId: string): Promise<Map<string, string>>
  fetchSeriesEpisodeStates(
    seriesId: string,
    userId: string,
  ): Promise<Map<string, { itemId: string; played: boolean }>>
  fetchAllMovies(userId: string): Promise<JellyfinMovie[]>
  markPlayed(userId: string, itemId: string): Promise<boolean>
  fetchAllSeries(userId: string): Promise<JellyfinSeries[]>
  setRating(userId: string, itemId: string, rating: number | null): Promise<boolean>
}

/** One reverse unit of work: a Jellyfin episode item to mark played. */
export interface ReversePlanEntry {
  label: string
  targetItemId: string | null
  status: 'already' | 'toAdd' | 'unmatched'
  reason?: string
}

export interface ReversePreview {
  foundShows: number
  foundMovies: number
  already: number
  toAdd: number
  unmatched: number
  unmatchedList: { label: string; reason: string }[]
  plan: ReversePlanEntry[]
}

/**
 * Plan the reverse import (no writes): for each MyShows show, find the Jellyfin series by IMDb id,
 * then for every episode watched on MyShows decide already-played / to-add / unmatched against
 * Jellyfin's state. Shows/episodes missing from Jellyfin are reported, never guessed.
 */
/** Case-insensitive IMDb id equality, tolerating null/absent on either side (→ no match). */
export function imdbMatches(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
}

export async function buildReversePreview(
  jf: JellyfinReverseTarget,
  userId: string,
  onProgress?: ProgressFn,
): Promise<ReversePreview> {
  const shows = await getProfileShows()
  const imdbIndex = await jf.fetchSeriesImdbIndex(userId)
  const movies = await jf.fetchAllMovies(userId)
  const plan: ReversePlanEntry[] = []
  let processed = 0
  const total = shows.length + movies.length

  for (const show of shows) {
    processed += 1
    onProgress?.(processed, total)

    const imdb = await getShowImdb(show.id)
    const seriesId = imdb ? imdbIndex.get(imdb.toLowerCase()) : undefined
    if (!seriesId) {
      plan.push({
        label: show.titleOriginal || show.title,
        targetItemId: null,
        status: 'unmatched',
        reason: imdb ? 'сериал не найден в Jellyfin' : 'нет IMDb id у сериала',
      })
      continue
    }

    // (season,episode) pairs watched on MyShows: intersect watched epIds with the episode list.
    const watchedIds = await getProfileWatchedEpisodeIds(show.id)
    const episodes = await getShowEpisodes(show.id)
    const watchedPairs = episodes
      .filter((e) => watchedIds.has(e.id))
      .map((e) => `${e.seasonNumber}:${e.episodeNumber}`)

    const jfStates = await jf.fetchSeriesEpisodeStates(seriesId, userId)
    for (const pair of watchedPairs) {
      const label = `${show.titleOriginal || show.title} · ${pair.replace(':', 'x')}`
      const jfEp = jfStates.get(pair)
      if (!jfEp) {
        plan.push({
          label,
          targetItemId: null,
          status: 'unmatched',
          reason: 'эпизода нет в Jellyfin',
        })
        continue
      }
      plan.push({
        label,
        targetItemId: jfEp.itemId,
        status: jfEp.played ? 'already' : 'toAdd',
      })
    }
  }

  // Movies: for each Jellyfin movie, find it on MyShows (search by title, disambiguate by year,
  // cross-check imdb), read its watch status, and queue the ones watched on MyShows but not yet
  // played in Jellyfin. Movies not watched on MyShows are simply skipped (not our case).
  for (const movie of movies) {
    processed += 1
    onProgress?.(processed, total)

    const label = `${movie.title}${movie.year ? ` (${movie.year})` : ''}`
    const query = movie.originalTitle ?? movie.title
    const candidates = await searchMovie(query)
    const match = pickMovie(candidates, movie.year)
    if (!match) {
      // No confident MyShows match — can't check status. Skip silently unless the movie isn't
      // played in Jellyfin (then it's worth reporting as unmatched so the user sees the gap).
      if (!movie.played) {
        plan.push({
          label,
          targetItemId: null,
          status: 'unmatched',
          reason:
            candidates.length === 0 ? 'фильм не найден в MyShows' : 'неоднозначное совпадение',
        })
      }
      continue
    }
    // Cross-check imdb when both sides have it; a mismatch means the title search hit the wrong film.
    const msImdb = await getMovieImdb(match.id)
    if (movie.imdb && msImdb && !imdbMatches(movie.imdb, msImdb)) {
      if (!movie.played) {
        plan.push({
          label,
          targetItemId: null,
          status: 'unmatched',
          reason: 'неоднозначное совпадение',
        })
      }
      continue
    }
    const watched = await isMovieWatched(match.id)
    if (watched !== true) {
      // Not watched on MyShows (or lookup failed) → nothing to bring over. Skip.
      continue
    }
    plan.push({
      label,
      targetItemId: movie.itemId,
      status: movie.played ? 'already' : 'toAdd',
    })
  }

  const already = plan.filter((p) => p.status === 'already').length
  const toAdd = plan.filter((p) => p.status === 'toAdd').length
  const unmatchedEntries = plan.filter((p) => p.status === 'unmatched')
  return {
    foundShows: shows.length,
    foundMovies: movies.length,
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

/** Apply a reverse preview: mark the toAdd episodes played in Jellyfin, one at a time. */
export async function applyReverse(
  jf: JellyfinReverseTarget,
  userId: string,
  plan: ReversePlanEntry[],
  onProgress?: ProgressFn,
): Promise<ApplyResult> {
  const toAdd = plan.filter((p) => p.status === 'toAdd' && p.targetItemId !== null)
  let added = 0
  let failed = 0
  for (let i = 0; i < toAdd.length; i++) {
    const ok = await jf.markPlayed(userId, toAdd[i].targetItemId as string)
    if (ok) {
      added += 1
    } else {
      failed += 1
    }
    onProgress?.(i + 1, toAdd.length)
  }
  const skipped = plan.filter((p) => p.status !== 'toAdd').length
  if (failed > 0) {
    warn(`[myshows-sync] Reverse import finished with ${failed} failures (added ${added})`)
  } else {
    info(`[myshows-sync] Reverse import complete: added ${added}, skipped ${skipped}`)
  }
  return { added, skipped, failed }
}

// ── Rating sync (movies + shows, both directions) ────────────────────────────

export type SyncDirection = 'jellyfinToMyshows' | 'myshowsToJellyfin'

/** One rating unit of work, side-agnostic: write `targetRating` for one item on the receiver. */
export interface RatingPlanEntry {
  kind: 'movie' | 'show'
  label: string
  /** MyShows id (movie/show) when the receiver is MyShows, else null. */
  myshowsId: number | null
  /** Jellyfin item id when the receiver is Jellyfin, else null. */
  jellyfinItemId: string | null
  /** The rating to write on the receiver, on the receiver's own scale. */
  targetRating: number | null
  status: 'already' | 'toAdd' | 'conflict'
}

export interface RatingPreview {
  /** Items rated on the source side that we tried to map (the universe we care about). */
  found: number
  /** Source & receiver already agree (after scale conversion). */
  already: number
  /** Source is rated, receiver is unrated → we'd write it. */
  toAdd: number
  /** Both sides rated differently → skipped (never overwrite blindly). */
  conflict: number
  plan: RatingPlanEntry[]
}

type RatingStatus = 'already' | 'toAdd' | 'conflict' | 'skip'

/**
 * Decide what to do for one item given the source's rating and the receiver's current rating,
 * both already normalized to the RECEIVER's scale. Pure — unit-tested.
 * - source unrated → nothing to bring over (skip)
 * - receiver unrated → write it (toAdd)
 * - equal → already
 * - different → conflict (never overwrite the receiver's own rating blindly)
 */
export function diffRating(
  sourceOnReceiverScale: number | null,
  receiverCurrent: number | null,
): RatingStatus {
  if (sourceOnReceiverScale == null) {
    return 'skip'
  }
  if (receiverCurrent == null) {
    return 'toAdd'
  }
  return receiverCurrent === sourceOnReceiverScale ? 'already' : 'conflict'
}

/**
 * Plan rating sync (no writes) for movies and shows in one direction. Only items rated on the
 * SOURCE side are considered (that's all we could ever bring over), which also keeps the RPC
 * volume down. Mapping reuses the same title/imdb logic as the watched sync.
 */
export async function buildRatingPreview(
  jf: JellyfinReverseTarget,
  userId: string,
  direction: SyncDirection,
  onProgress?: ProgressFn,
): Promise<RatingPreview> {
  const plan: RatingPlanEntry[] = []
  const jfMovies = await jf.fetchAllMovies(userId)
  const jfSeries = await jf.fetchAllSeries(userId)
  const msShows = await getProfileShowsWithRating()

  if (direction === 'myshowsToJellyfin') {
    // Source = MyShows, receiver = Jellyfin. Consider only MyShows-rated shows/movies.
    const ratedShows = msShows.filter((s) => s.rating != null)
    const jfSeriesByImdb = new Map(jfSeries.map((s) => [s.imdb.toLowerCase(), s]))
    // Movies rated on MyShows aren't listable directly; walk Jellyfin movies and query each film's
    // MyShows rating (same shape as the reverse watched import).
    const total = ratedShows.length + jfMovies.length
    let processed = 0

    for (const show of ratedShows) {
      processed += 1
      onProgress?.(processed, total)
      const imdb = await getShowImdb(show.id)
      const jfS = imdb ? jfSeriesByImdb.get(imdb.toLowerCase()) : undefined
      if (!jfS) {
        continue // no Jellyfin series to write onto — skip silently
      }
      const target = myshowsToJellyfinRating(show.rating)
      const status = diffRating(target, jfS.rating)
      if (status === 'skip') {
        continue
      }
      plan.push({
        kind: 'show',
        label: show.titleOriginal || show.title,
        myshowsId: null,
        jellyfinItemId: jfS.itemId,
        targetRating: target,
        status,
      })
    }

    for (const movie of jfMovies) {
      processed += 1
      onProgress?.(processed, total)
      const query = movie.originalTitle ?? movie.title
      const match = pickMovie(await searchMovie(query), movie.year)
      if (!match) {
        continue
      }
      const msImdb = await getMovieImdb(match.id)
      if (movie.imdb && msImdb && !imdbMatches(movie.imdb, msImdb)) {
        continue // wrong film matched by title
      }
      const msRating = await getMovieRating(match.id)
      if (msRating == null) {
        continue // not rated on MyShows → nothing to bring over
      }
      const target = myshowsToJellyfinRating(msRating)
      const status = diffRating(target, movie.rating)
      if (status === 'skip') {
        continue
      }
      plan.push({
        kind: 'movie',
        label: `${movie.title}${movie.year ? ` (${movie.year})` : ''}`,
        myshowsId: null,
        jellyfinItemId: movie.itemId,
        targetRating: target,
        status,
      })
    }
  } else {
    // Source = Jellyfin, receiver = MyShows. Consider only Jellyfin-rated shows/movies.
    const ratedSeries = jfSeries.filter((s) => s.rating != null)
    const ratedMovies = jfMovies.filter((m) => m.rating != null)
    const showByImdb = new Map<string, (typeof msShows)[number]>()
    // Build an imdb→MyShows-show map once (one shows.GetById per profile show).
    const total = ratedSeries.length + ratedMovies.length
    let processed = 0

    for (const series of ratedSeries) {
      processed += 1
      onProgress?.(processed, total)
      // Find the MyShows show whose imdb matches this Jellyfin series.
      let msShow = showByImdb.get(series.imdb.toLowerCase())
      if (!msShow) {
        for (const s of msShows) {
          const imdb = await getShowImdb(s.id)
          if (imdb && imdbMatches(imdb, series.imdb)) {
            showByImdb.set(series.imdb.toLowerCase(), s)
            msShow = s
            break
          }
        }
      }
      if (!msShow) {
        continue
      }
      const target = jellyfinToMyshowsRating(series.rating)
      const status = diffRating(target, msShow.rating)
      if (status === 'skip') {
        continue
      }
      plan.push({
        kind: 'show',
        label: msShow.titleOriginal || msShow.title,
        myshowsId: msShow.id,
        jellyfinItemId: null,
        targetRating: target,
        status,
      })
    }

    for (const movie of ratedMovies) {
      processed += 1
      onProgress?.(processed, total)
      const query = movie.originalTitle ?? movie.title
      const match = pickMovie(await searchMovie(query), movie.year)
      if (!match) {
        continue
      }
      const msImdb = await getMovieImdb(match.id)
      if (movie.imdb && msImdb && !imdbMatches(movie.imdb, msImdb)) {
        continue
      }
      const msRating = await getMovieRating(match.id)
      const target = jellyfinToMyshowsRating(movie.rating)
      const status = diffRating(target, msRating)
      if (status === 'skip') {
        continue
      }
      plan.push({
        kind: 'movie',
        label: `${movie.title}${movie.year ? ` (${movie.year})` : ''}`,
        myshowsId: match.id,
        jellyfinItemId: null,
        targetRating: target,
        status,
      })
    }
  }

  return {
    found: plan.length,
    already: plan.filter((p) => p.status === 'already').length,
    toAdd: plan.filter((p) => p.status === 'toAdd').length,
    conflict: plan.filter((p) => p.status === 'conflict').length,
    plan,
  }
}

/**
 * Apply a rating preview's toAdd entries: write each rating on the receiver, one at a time (shared
 * token mutex reasoning as the watched sync). Conflicts are never written. Reversible either way.
 */
export async function applyRatings(
  jf: JellyfinReverseTarget,
  userId: string,
  direction: SyncDirection,
  plan: RatingPlanEntry[],
  onProgress?: ProgressFn,
): Promise<ApplyResult> {
  const toAdd = plan.filter((p) => p.status === 'toAdd' && p.targetRating != null)
  let added = 0
  let failed = 0
  for (let i = 0; i < toAdd.length; i++) {
    const entry = toAdd[i]
    let ok = false
    if (direction === 'myshowsToJellyfin' && entry.jellyfinItemId) {
      ok = await jf.setRating(userId, entry.jellyfinItemId, entry.targetRating)
    } else if (direction === 'jellyfinToMyshows' && entry.myshowsId != null) {
      ok =
        entry.kind === 'movie'
          ? await rateMovie(entry.myshowsId, entry.targetRating as number)
          : await rateShow(entry.myshowsId, entry.targetRating as number)
    }
    if (ok) {
      added += 1
    } else {
      failed += 1
    }
    onProgress?.(i + 1, toAdd.length)
  }
  const skipped = plan.filter((p) => p.status !== 'toAdd').length
  if (failed > 0) {
    warn(`[myshows-sync] Rating sync finished with ${failed} failures (added ${added})`)
  } else {
    info(`[myshows-sync] Rating sync complete: added ${added}, skipped ${skipped}`)
  }
  return { added, skipped, failed }
}
