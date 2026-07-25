import { describe, it, expect } from 'vite-plus/test'
import {
  pickShow,
  pickMovie,
  findEpisodeId,
  groupEpisodesByShow,
  imdbFromMyShows,
  imdbMatches,
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

describe('pickMovie', () => {
  const a = { id: 10, title: 'M', titleOriginal: 'M', year: 2000 }
  const b = { id: 11, title: 'M', titleOriginal: 'M', year: 2019 }

  it('returns the only candidate', () => {
    expect(pickMovie([a], null)?.id).toBe(10)
  })

  it('disambiguates by exact year', () => {
    expect(pickMovie([a, b], 2019)?.id).toBe(11)
  })

  it('refuses to guess when ambiguous with no year match', () => {
    expect(pickMovie([a, b], 1990)).toBeNull()
    expect(pickMovie([a, b], null)).toBeNull()
  })

  it('returns null for no candidates', () => {
    expect(pickMovie([], 2000)).toBeNull()
  })
})

describe('imdbFromMyShows', () => {
  it('zero-pads short ids to the tt####### form', () => {
    expect(imdbFromMyShows(149460)).toBe('tt0149460')
    expect(imdbFromMyShows(1)).toBe('tt0000001')
  })

  it('keeps longer ids at their natural length', () => {
    expect(imdbFromMyShows(13443470)).toBe('tt13443470')
  })
})

describe('imdbMatches', () => {
  it('matches equal ids ignoring case/whitespace', () => {
    expect(imdbMatches('tt0144084', 'TT0144084')).toBe(true)
    expect(imdbMatches(' tt0144084 ', 'tt0144084')).toBe(true)
  })

  it('does not match different ids', () => {
    expect(imdbMatches('tt0144084', 'tt0111161')).toBe(false)
  })

  it('never matches when either side is null', () => {
    expect(imdbMatches(null, 'tt1')).toBe(false)
    expect(imdbMatches('tt1', null)).toBe(false)
    expect(imdbMatches(null, null)).toBe(false)
  })
})
