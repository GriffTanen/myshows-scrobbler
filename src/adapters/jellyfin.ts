import type { SourceType, NormalizedEvent, PlaybackState, MediaInfo } from '../types.js'
import { BaseAdapter } from './base.js'
import { extractDubTeam } from '../utils/dub-team.js'
import { idsFromProviderIds, legacyIdFields } from './external-ids.js'
import {
  hdrFromText,
  isScrobblableType,
  mediaInfoOrNull,
  resolutionFromDimensions,
} from './media-info.js'
import { languageToIso } from '../utils/audio-track.js'
import { percentFromPosition, ticksToMs, ticksToRuntimeMinutes } from './time.js'
import { fetchWithTimeout } from '../http.js'
import type { PlayedItem } from '../scrobblers/myshows-sync.js'

// ── Jellyfin / Emby shared API types ──

export interface JellyfinProviderIds {
  Imdb?: string
  Tmdb?: string
  Tvdb?: string
}

export interface JellyfinItem {
  Id?: string
  Name?: string
  OriginalTitle?: string
  OfficialRating?: string
  Type?: string // 'Movie' | 'Episode' | 'Series'
  ProductionYear?: number
  SeriesName?: string
  SeriesId?: string
  ParentIndexNumber?: number // season
  IndexNumber?: number // episode
  ProviderIds?: JellyfinProviderIds
  RunTimeTicks?: number
  Width?: number
  Height?: number
  MediaSources?: JellyfinMediaSource[]
  MediaStreams?: JellyfinMediaStream[]
  UserData?: {
    PlaybackPositionTicks?: number
    PlayedPercentage?: number
    Played?: boolean
    IsFavorite?: boolean
    Rating?: number
  }
}

export interface JellyfinMediaStream {
  Codec?: string
  Language?: string
  DisplayTitle?: string
  IsDefault?: boolean
  ChannelLayout?: string
  Channels?: number
  Type?: string
  Width?: number
  Height?: number
  VideoRange?: string
  VideoRangeType?: string
  VideoDoViTitle?: string
  Hdr10PlusPresentFlag?: boolean
}

export interface JellyfinMediaSource {
  Path?: string
  Container?: string
  MediaStreams?: JellyfinMediaStream[]
}

export interface JellyfinSession {
  Id: string
  NowPlayingItem?: JellyfinItem
  PlayState?: {
    PositionTicks?: number
    IsPaused?: boolean
  }
  ApplicationVersion?: string
  UserId?: string
  UserName?: string
}

// ── Helpers ──

/**
 * Hidden per-user filter (config-only `user_filter`). Empty = every viewer counts;
 * otherwise a session counts only if its `UserId` or `UserName` matches an entry
 * (trimmed, case-insensitive). A session with no user info is dropped when a filter is set.
 * Mirrors matchesUserFilter in adapters/plex.ts.
 */
export function matchesUserFilter(
  user: { id?: string; title?: string } | undefined,
  filter: string[],
): boolean {
  const wanted = filter.map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0)
  if (wanted.length === 0) {
    return true
  }
  if (!user) {
    return false
  }
  const id = user.id?.trim().toLowerCase()
  const title = user.title?.trim().toLowerCase()
  return (!!id && wanted.includes(id)) || (!!title && wanted.includes(title))
}

function normalizeType(type?: string): 'movie' | 'episode' {
  if (type?.toLowerCase() === 'episode') {
    return 'episode'
  }
  return 'movie'
}

function stateFromSession(session: JellyfinSession): PlaybackState {
  return session.PlayState?.IsPaused ? 'paused' : 'playing'
}

function buildSessionId(session: JellyfinSession, item: JellyfinItem): string {
  const itemKey = item.Id ?? item.Name ?? 'unknown'
  return `${session.Id}:item:${itemKey}`
}

function getPrimaryMediaSource(item: JellyfinItem): JellyfinMediaSource | null {
  return item.MediaSources?.[0] ?? null
}

function getMediaStreams(item: JellyfinItem): JellyfinMediaStream[] {
  const fromSource = getPrimaryMediaSource(item)?.MediaStreams
  if (fromSource?.length) {
    return fromSource
  }
  return item.MediaStreams ?? []
}

function extractHdr(stream?: JellyfinMediaStream): string | null {
  if (!stream) {
    return null
  }

  const hdr = hdrFromText(stream.VideoDoViTitle, stream.VideoRangeType)
  if (hdr) {
    return hdr
  }

  if (stream.Hdr10PlusPresentFlag) {
    return 'hdr10_plus'
  }

  return hdrFromText(stream.VideoRange)
}

function extractMediaInfo(item: JellyfinItem): MediaInfo | null {
  const mediaSource = getPrimaryMediaSource(item)
  const streams = getMediaStreams(item)
  const videoStream = streams.find((stream) => stream.Type === 'Video')
  const audioStream =
    streams.find((stream) => stream.Type === 'Audio' && stream.IsDefault) ??
    streams.find((stream) => stream.Type === 'Audio')

  const info: MediaInfo = {
    resolution: resolutionFromDimensions(
      videoStream?.Width ?? item.Width,
      videoStream?.Height ?? item.Height,
    ),
    hdr: extractHdr(videoStream),
    audioCodec: audioStream?.Codec ?? null,
    audioChannels: audioStream?.Channels ?? null,
    // Jellyfin/Emby report ISO 639-2 ("rus"); the DTO wants 639-1 ("ru").
    audioLanguage: languageToIso(audioStream?.Language),
    container: mediaSource?.Container ?? null,
  }

  return mediaInfoOrNull(info)
}

export function sessionToEvent(
  session: JellyfinSession,
  source: SourceType,
  action: 'progress' | 'stopped',
  showItem?: JellyfinItem | null,
): NormalizedEvent {
  const item = session.NowPlayingItem ?? {}
  const position = session.PlayState?.PositionTicks
  const type = normalizeType(item.Type)
  const idsSource =
    type === 'episode' ? (showItem?.ProviderIds ?? item.ProviderIds) : item.ProviderIds
  const ids = idsFromProviderIds(idsSource)
  const episodeIds = type === 'episode' ? idsFromProviderIds(item.ProviderIds) : null
  const legacyIds = legacyIdFields(ids)
  const legacyEpisodeIds = legacyIdFields(episodeIds ?? {})

  return {
    type,
    sessionId: buildSessionId(session, item),
    ids,
    imdbId: legacyIds.imdbId,
    tmdbId: legacyIds.tmdbId,
    tvdbId: legacyIds.tvdbId,
    episodeIds: episodeIds ?? {},
    episodeImdbId: legacyEpisodeIds.imdbId,
    episodeTmdbId: legacyEpisodeIds.tmdbId,
    episodeTvdbId: legacyEpisodeIds.tvdbId,
    title: item.Name ?? '',
    originalTitle: item.OriginalTitle ?? null,
    year: item.ProductionYear ?? null,
    showTitle: item.SeriesName ?? null,
    showOriginalTitle: type === 'episode' ? (showItem?.OriginalTitle ?? null) : null,
    season: item.ParentIndexNumber ?? null,
    episode: item.IndexNumber ?? null,
    userRating: item.UserData?.Rating ?? null,
    contentRating:
      type === 'episode'
        ? (showItem?.OfficialRating ?? item.OfficialRating ?? null)
        : (item.OfficialRating ?? null),
    runtimeMinutes: ticksToRuntimeMinutes(item.RunTimeTicks),
    duration: ticksToMs(item.RunTimeTicks),
    viewOffset: ticksToMs(position ?? item.UserData?.PlaybackPositionTicks),
    source,
    action,
    state: stateFromSession(session),
    appVersion: session.ApplicationVersion ?? null,
    media: extractMediaInfo(item),
    dubTeam: extractDubTeam(getPrimaryMediaSource(item)?.Path),
  }
}

// ── Jellyfin Adapter ──

export class JellyfinAdapter extends BaseAdapter {
  protected previousSessions = new Map<string, JellyfinSession>()

  get name(): SourceType {
    return 'jellyfin'
  }

  protected getHeaders(): Record<string, string> {
    return {
      'X-MediaBrowser-Token': this.config.token,
      'Accept': 'application/json',
    }
  }

  async checkConnection(): Promise<boolean> {
    try {
      this.clearConnectionError()
      const url = `${this.config.url}/System/Info`
      const response = await fetchWithTimeout(url, { headers: this.getHeaders() })
      if (!response.ok) {
        const message = `${this.name} API error: ${response.status}`
        this.setConnectionError(message)
        return false
      }
      return true
    } catch (err) {
      const message = (err as Error).message
      this.setConnectionError(message)
      this.log('error', `Connection check failed: ${message}`)
      return false
    }
  }

  protected override resetState(): void {
    this.previousSessions.clear()
  }

  protected async fetchItem(itemId: string, userId?: string): Promise<JellyfinItem | null> {
    const base = userId
      ? `${this.config.url}/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}`
      : `${this.config.url}/Items/${encodeURIComponent(itemId)}`
    const response = await fetchWithTimeout(base, { headers: this.getHeaders() })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as JellyfinItem
  }

  protected async enrichSession(
    session: JellyfinSession,
  ): Promise<{ session: JellyfinSession; showItem: JellyfinItem | null }> {
    const currentItem = session.NowPlayingItem
    if (!currentItem?.Id) {
      return { session, showItem: null }
    }

    const fullItem = await this.fetchItem(currentItem.Id, session.UserId)
    const mergedItem = fullItem ? { ...currentItem, ...fullItem } : currentItem

    let showItem: JellyfinItem | null = null
    if (mergedItem.Type?.toLowerCase() === 'episode' && mergedItem.SeriesId) {
      showItem = await this.fetchItem(mergedItem.SeriesId, session.UserId)
    }

    return {
      session: {
        ...session,
        NowPlayingItem: mergedItem,
      },
      showItem,
    }
  }

  protected async poll(): Promise<void> {
    if (!this.running) {
      return
    }

    try {
      // Apply the hidden `user_filter` here (not in fetchSessions) so both the Jellyfin and
      // the Emby adapter get it from one place — Emby overrides fetchSessions and would
      // otherwise silently skip the filter.
      const sessions = (await this.fetchSessions()).filter((s) =>
        matchesUserFilter({ id: s.UserId, title: s.UserName }, this.config.userFilter),
      )
      const currentIds = new Set(sessions.map((s) => s.Id))
      const nextPrevious = new Map<string, JellyfinSession>()

      this.log(
        'debug',
        `Active sessions: ${sessions.length}, previous: ${this.previousSessions.size}`,
      )

      for (const s of sessions) {
        const prev = this.previousSessions.get(s.Id)
        const changed =
          !prev ||
          prev.PlayState?.PositionTicks !== s.PlayState?.PositionTicks ||
          prev.PlayState?.IsPaused !== s.PlayState?.IsPaused

        if (changed && s.NowPlayingItem) {
          const enriched = await this.enrichSession(s)
          await this.emitScrobble(
            sessionToEvent(enriched.session, this.name, 'progress', enriched.showItem),
          )
          nextPrevious.set(s.Id, enriched.session)
          continue
        }

        nextPrevious.set(s.Id, prev ?? s)
      }

      for (const [id, prev] of this.previousSessions) {
        if (currentIds.has(id)) {
          continue
        }
        if (!prev.NowPlayingItem) {
          continue
        }

        const item = prev.NowPlayingItem
        const duration = item.RunTimeTicks ?? 0
        const position = prev.PlayState?.PositionTicks ?? 0
        const percent = percentFromPosition(position, duration)
        this.log('info', `Session ended: ${item.Name} (${percent.toFixed(1)}%)`)

        const showItem =
          item.Type?.toLowerCase() === 'episode' && item.SeriesId
            ? await this.fetchItem(item.SeriesId, prev.UserId)
            : null
        await this.emitScrobble(sessionToEvent(prev, this.name, 'stopped', showItem))
      }

      this.previousSessions = nextPrevious
    } catch (err) {
      this.log('error', `Poll error: ${(err as Error).message}`)
    }
  }

  protected async fetchSessions(): Promise<JellyfinSession[]> {
    const url = `${this.config.url}/Sessions`
    const response = await fetchWithTimeout(url, { headers: this.getHeaders() })

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`)
    }

    const sessions = (await response.json()) as JellyfinSession[]
    // `user_filter` is applied in poll() (shared with the Emby adapter), not here.
    return sessions.filter((s) => s.NowPlayingItem && isScrobblableType(s.NowPlayingItem.Type))
  }

  // ── Watched-history import (Jellyfin -> MyShows sync, Stage 1) ──

  /**
   * Resolve which Jellyfin user's watch history to import: the first entry of `user_filter`
   * if set (matched against /Users by id or name), otherwise the first server user. Returns
   * null if the server has no users or the request fails.
   */
  async resolveUserId(): Promise<string | null> {
    let users: Array<{ Id?: string; Name?: string }>
    try {
      const res = await fetchWithTimeout(`${this.config.url}/Users`, { headers: this.getHeaders() })
      if (!res.ok) {
        return null
      }
      users = (await res.json()) as Array<{ Id?: string; Name?: string }>
    } catch (err) {
      this.log('error', `resolveUserId failed: ${(err as Error).message}`)
      return null
    }
    if (users.length === 0) {
      return null
    }
    const wanted = this.config.userFilter.map((v) => v.trim().toLowerCase()).filter(Boolean)
    if (wanted.length > 0) {
      const match = users.find(
        (u) =>
          (u.Id && wanted.includes(u.Id.toLowerCase())) ||
          (u.Name && wanted.includes(u.Name.toLowerCase())),
      )
      if (match?.Id) {
        return match.Id
      }
    }
    return users[0].Id ?? null
  }

  /**
   * Read everything a user has marked watched (IsPlayed=true), paged, normalized to PlayedItem
   * for the MyShows mapping. Read-only.
   */
  async fetchPlayedItems(userId: string): Promise<PlayedItem[]> {
    const movies = await this.fetchPlayedOfType(userId, 'Movie')
    const episodes = await this.fetchPlayedOfType(userId, 'Episode')
    return [...movies, ...episodes]
  }

  private async fetchPlayedOfType(
    userId: string,
    itemType: 'Movie' | 'Episode',
  ): Promise<PlayedItem[]> {
    const pageSize = 200
    const out: PlayedItem[] = []
    for (let start = 0; ; start += pageSize) {
      const params = new URLSearchParams({
        IsPlayed: 'true',
        Recursive: 'true',
        IncludeItemTypes: itemType,
        Fields: 'ProviderIds,UserData,SeriesName,OriginalTitle,ProductionYear',
        StartIndex: String(start),
        Limit: String(pageSize),
      })
      const url = `${this.config.url}/Users/${encodeURIComponent(userId)}/Items?${params}`
      const res = await fetchWithTimeout(url, { headers: this.getHeaders() })
      if (!res.ok) {
        throw new Error(`Jellyfin played-items API error: ${res.status}`)
      }
      const body = (await res.json()) as { Items?: JellyfinItem[]; TotalRecordCount?: number }
      const items = body.Items ?? []
      for (const it of items) {
        out.push(toPlayedItem(it, itemType))
      }
      if (items.length < pageSize) {
        break
      }
    }
    return out
  }

  // ── Reverse import (MyShows -> Jellyfin, Stage 2) ──

  /**
   * Every Series in the library, indexed by lowercased IMDb id (`tt…`) → Jellyfin series id.
   * Built once and reused: this Jellyfin version's AnyProviderIdEquals filter doesn't actually
   * filter, so we match on our side. Series without an IMDb ProviderId are skipped (can't map).
   */
  async fetchSeriesImdbIndex(userId: string): Promise<Map<string, string>> {
    const index = new Map<string, string>()
    const params = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Series',
      Fields: 'ProviderIds',
      Limit: '2000',
    })
    const url = `${this.config.url}/Users/${encodeURIComponent(userId)}/Items?${params}`
    const res = await fetchWithTimeout(url, { headers: this.getHeaders() })
    if (!res.ok) {
      throw new Error(`Jellyfin series list API error: ${res.status}`)
    }
    const body = (await res.json()) as { Items?: JellyfinItem[] }
    for (const item of body.Items ?? []) {
      const imdb = item.ProviderIds?.Imdb
      if (imdb && item.Id) {
        index.set(imdb.toLowerCase(), item.Id)
      }
    }
    return index
  }

  /**
   * A series' episodes with their play state, keyed by `season:episode` → { itemId, played }.
   * Uses /Shows/{id}/Episodes which returns per-user UserData.
   */
  async fetchSeriesEpisodeStates(
    seriesId: string,
    userId: string,
  ): Promise<Map<string, { itemId: string; played: boolean }>> {
    const params = new URLSearchParams({ userId, Fields: 'UserData' })
    const url = `${this.config.url}/Shows/${encodeURIComponent(seriesId)}/Episodes?${params}`
    const res = await fetchWithTimeout(url, { headers: this.getHeaders() })
    if (!res.ok) {
      throw new Error(`Jellyfin episodes API error: ${res.status}`)
    }
    const body = (await res.json()) as { Items?: JellyfinItem[] }
    const map = new Map<string, { itemId: string; played: boolean }>()
    for (const ep of body.Items ?? []) {
      if (ep.ParentIndexNumber == null || ep.IndexNumber == null || !ep.Id) {
        continue
      }
      map.set(`${ep.ParentIndexNumber}:${ep.IndexNumber}`, {
        itemId: ep.Id,
        played: ep.UserData?.Played === true,
      })
    }
    return map
  }

  /** Mark an item (episode) played for a user. Reversible via DELETE. Returns success. */
  async markPlayed(userId: string, itemId: string): Promise<boolean> {
    const url = `${this.config.url}/Users/${encodeURIComponent(userId)}/PlayedItems/${encodeURIComponent(itemId)}`
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', headers: this.getHeaders() })
      return res.ok
    } catch (err) {
      this.log('error', `markPlayed failed: ${(err as Error).message}`)
      return false
    }
  }
}

function toPlayedItem(item: JellyfinItem, itemType: 'Movie' | 'Episode'): PlayedItem {
  const ids = item.ProviderIds ?? {}
  if (itemType === 'Episode') {
    return {
      kind: 'episode',
      title: item.Name ?? '',
      searchTitle: item.SeriesName ?? '',
      originalTitle: null,
      year: item.ProductionYear ?? null,
      season: item.ParentIndexNumber ?? null,
      episode: item.IndexNumber ?? null,
      imdb: ids.Imdb ?? null,
      tmdb: ids.Tmdb ?? null,
    }
  }
  return {
    kind: 'movie',
    title: item.Name ?? '',
    searchTitle: item.Name ?? '',
    originalTitle: item.OriginalTitle ?? null,
    year: item.ProductionYear ?? null,
    season: null,
    episode: null,
    imdb: ids.Imdb ?? null,
    tmdb: ids.Tmdb ?? null,
  }
}
