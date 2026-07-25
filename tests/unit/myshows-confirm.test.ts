import { describe, it, expect } from 'vite-plus/test'
import {
  extractPendingEntries,
  findMatch,
  type PendingEntry,
  type ConfirmTarget,
} from '../../src/scrobblers/myshows-confirm.js'

/**
 * Build a minimal `__NUXT_DATA__` HTML page matching the site's devalue-style index scheme:
 * a flat array where `"pending":N` points at an array of entry indices, and every field on
 * an entry object is itself an index into the same array (Nuxt interns primitives), including
 * `id` — the scrobbleId. Regression guard: taking `entry.id` as the raw index instead of
 * dereferencing it was a real bug.
 */
function nuxtPage(data: unknown[], pendingIndex: number): string {
  const json = JSON.stringify(data)
  return `<html><body>...<script type="application/json" id="__NUXT_DATA__">${json}</script>...{"pending":${pendingIndex}}...</body></html>`
}

describe('extractPendingEntries', () => {
  it('resolves an episode entry, dereferencing every field including the scrobbleId', () => {
    // indices: 0 = pending list, 1 = entry object, 2.. = interned field values
    const data: unknown[] = [
      [1], // 0: pending -> [entry@1]
      { id: 2, objectType: 3, title: 4, originalTitle: 5, season: 6, episode: 7 }, // 1: entry
      900123, // 2: id (scrobbleId)
      'episode', // 3: objectType
      'Breaking Bad', // 4: title
      'Breaking Bad', // 5: originalTitle
      5, // 6: season
      8, // 7: episode
    ]
    const entries = extractPendingEntries(nuxtPage(data, 0))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      scrobbleId: 900123,
      objectType: 'episode',
      title: 'Breaking Bad',
      originalTitle: 'Breaking Bad',
      season: 5,
      episode: 8,
    })
  })

  it('skips an entry whose id does not resolve to a number', () => {
    const data: unknown[] = [
      [1],
      { id: 2, objectType: 3, title: 4 },
      'not-a-number', // 2: id resolves to a string -> entry skipped
      'episode',
      'Show',
    ]
    expect(extractPendingEntries(nuxtPage(data, 0))).toEqual([])
  })

  it('returns [] when the pending key is absent', () => {
    const json = JSON.stringify([[], {}])
    const html = `<html><script id="__NUXT_DATA__">${json}</script></html>`
    expect(extractPendingEntries(html)).toEqual([])
  })

  it('returns [] on malformed __NUXT_DATA__ JSON', () => {
    const html = `<html><script id="__NUXT_DATA__">{not valid json,,}</script>{"pending":0}</html>`
    expect(extractPendingEntries(html)).toEqual([])
  })

  it('returns [] when the script tag is missing entirely', () => {
    expect(extractPendingEntries('<html><body>no payload</body></html>')).toEqual([])
  })
})

describe('findMatch', () => {
  const episode: PendingEntry = {
    scrobbleId: 1,
    objectType: 'episode',
    title: 'Breaking Bad',
    originalTitle: 'Breaking Bad',
    season: 5,
    episode: 8,
  }
  const movie: PendingEntry = {
    scrobbleId: 2,
    objectType: 'movie',
    title: 'Inception',
    originalTitle: 'Inception',
    season: null,
    episode: null,
  }

  it('matches an episode on show title + season + episode', () => {
    const target: ConfirmTarget = {
      type: 'episode',
      title: 'Ozymandias',
      originalTitle: 'Ozymandias',
      showTitle: 'Breaking Bad',
      showOriginalTitle: null,
      season: 5,
      episode: 8,
    }
    expect(findMatch([episode], target)?.scrobbleId).toBe(1)
  })

  it('matches an episode via the original show title when the localized title differs', () => {
    const target: ConfirmTarget = {
      type: 'episode',
      title: '',
      originalTitle: null,
      showTitle: 'Во все тяжкие',
      showOriginalTitle: 'Breaking Bad',
      season: 5,
      episode: 8,
    }
    expect(findMatch([episode], target)?.scrobbleId).toBe(1)
  })

  it('does not match an episode when season/episode differ', () => {
    const target: ConfirmTarget = {
      type: 'episode',
      title: '',
      originalTitle: null,
      showTitle: 'Breaking Bad',
      showOriginalTitle: 'Breaking Bad',
      season: 5,
      episode: 9,
    }
    expect(findMatch([episode], target)).toBeNull()
  })

  it('matches a movie on title alone', () => {
    const target: ConfirmTarget = {
      type: 'movie',
      title: 'Inception',
      originalTitle: null,
      showTitle: null,
      showOriginalTitle: null,
      season: null,
      episode: null,
    }
    expect(findMatch([movie], target)?.scrobbleId).toBe(2)
  })

  it('does not cross object types', () => {
    const target: ConfirmTarget = {
      type: 'movie',
      title: 'Breaking Bad',
      originalTitle: 'Breaking Bad',
      showTitle: null,
      showOriginalTitle: null,
      season: null,
      episode: null,
    }
    expect(findMatch([episode], target)).toBeNull()
  })
})
