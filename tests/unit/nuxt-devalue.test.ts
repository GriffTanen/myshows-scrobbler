import { describe, it, expect } from 'vite-plus/test'
import { resolveNuxtRef } from '../../src/scrobblers/nuxt-devalue.js'

describe('resolveNuxtRef', () => {
  it('returns a plain (non-ref) value unchanged', () => {
    expect(resolveNuxtRef([], 'hello', 0)).toBe('hello')
    expect(resolveNuxtRef([], 42, 0)).toBe(42)
    expect(resolveNuxtRef([], null, 0)).toBe(null)
  })

  it('dereferences a single ["Ref", N] tuple to the value at index N', () => {
    const data = ['unused', 'target']
    expect(resolveNuxtRef(data, ['Ref', 1], 0)).toBe('target')
  })

  it('follows a chain of nested refs', () => {
    // index 3 -> ref to 2 -> ref to 1 -> final value at 0
    const data: unknown[] = ['final', ['Ref', 0], ['ShallowRef', 1], ['Ref', 2]]
    expect(resolveNuxtRef(data, data[3], 0)).toBe('final')
  })

  it('stops after the depth cap and returns the wrapper as-is', () => {
    // A cycle would loop forever without the cap; the cap returns whatever it lands on.
    const data: unknown[] = [
      ['Ref', 1],
      ['Ref', 0],
    ] // 0 <-> 1 cycle
    const result = resolveNuxtRef(data, data[0], 0)
    // Never throws / hangs; lands on one of the two wrapper tuples.
    expect(Array.isArray(result)).toBe(true)
  })

  it('does not treat a 2-element array with wrong element types as a ref', () => {
    // [string, string] is not [string, number] -> not a ref wrapper.
    expect(resolveNuxtRef(['x'], ['Ref', 'notIndex'], 0)).toEqual(['Ref', 'notIndex'])
    // 3-element array is not a ref wrapper either.
    expect(resolveNuxtRef(['x'], ['Ref', 0, 0], 0)).toEqual(['Ref', 0, 0])
  })
})
