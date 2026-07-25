import { describe, it, expect } from 'vite-plus/test'
import {
  pickShow,
  findEpisodeId,
  groupEpisodesByShow,
  type PlayedItem,
} from '../../src/scrobblers/myshows-sync.js'

function ep(overrides: Partial<PlayedItem> = {}): PlayedItem {
  return {
    kind: 'episode',
    title: 'An episode',
    searchTitle: 'A Show',
    originalTitle: null,
    year: null,
    season: 1,
    episode: 1,
    imdb: null,
    tmdb: null,
    ...overrides,
  }
}

describe('pickShow', () => {
  const a = { id: 1, title: 'X', titleOriginal: 'X', year: 2001 }
  const b = { id: 2, title: 'X', titleOriginal: 'X', year: 2019 }

  it('returns the only candidate', () => {
    expect(pickShow([a], null)?.id).toBe(1)
  })

  it('disambiguates multiple candidates by exact year', () => {
    expect(pickShow([a, b], 2019)?.id).toBe(2)
  })

  it('refuses to guess when multiple candidates and no year match', () => {
    expect(pickShow([a, b], 1990)).toBeNull()
    expect(pickShow([a, b], null)).toBeNull()
  })

  it('returns null for no candidates', () => {
    expect(pickShow([], 2000)).toBeNull()
  })
})

describe('findEpisodeId', () => {
  const episodes = [
    { id: 100, seasonNumber: 1, episodeNumber: 1 },
    { id: 101, seasonNumber: 1, episodeNumber: 2 },
    { id: 200, seasonNumber: 2, episodeNumber: 1 },
  ]

  it('maps (season, episode) to the MyShows episode id', () => {
    expect(findEpisodeId(episodes, 1, 2)).toBe(101)
    expect(findEpisodeId(episodes, 2, 1)).toBe(200)
  })

  it('returns null when the episode is absent', () => {
    expect(findEpisodeId(episodes, 3, 1)).toBeNull()
    expect(findEpisodeId([], 1, 1)).toBeNull()
  })
})

describe('groupEpisodesByShow', () => {
  it('groups episodes by original title (case/space-insensitive), ignoring movies', () => {
    const items: PlayedItem[] = [
      ep({ originalTitle: 'Breaking Bad', season: 1, episode: 1 }),
      ep({ originalTitle: ' breaking bad ', season: 1, episode: 2 }),
      ep({ originalTitle: 'The Wire', season: 1, episode: 1 }),
      { ...ep(), kind: 'movie', originalTitle: 'Inception' },
    ]
    const groups = groupEpisodesByShow(items)
    expect(groups.size).toBe(2)
    expect(groups.get('breaking bad')?.length).toBe(2)
    expect(groups.get('the wire')?.length).toBe(1)
  })

  it('falls back to searchTitle when originalTitle is absent', () => {
    const items = [ep({ originalTitle: null, searchTitle: 'Fargo' })]
    const groups = groupEpisodesByShow(items)
    expect(groups.get('fargo')?.length).toBe(1)
  })
})
