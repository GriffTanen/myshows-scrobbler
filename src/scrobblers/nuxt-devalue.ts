// Shared helper for parsing Nuxt/Vue's `__NUXT_DATA__` SSR payload (devalue-style array),
// used by both myshows-web-auth.ts (auth.token) and myshows-confirm.ts (pending entries).

/**
 * Nuxt/Vue's devalue-style payload wraps reactive values as `["Ref", N]` /
 * `["ShallowReactive", N]` / `["EmptyRef", N]` tuples pointing at another array index holding
 * the actual value, which can itself be another wrapper. Unwrap up to a handful of hops
 * before giving up — a real payload never nests this deep, so a low cap just prevents an
 * infinite loop on a malformed/cyclic array without needing cycle-tracking.
 */
export function resolveNuxtRef(data: unknown[], value: unknown, depth: number): unknown {
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
