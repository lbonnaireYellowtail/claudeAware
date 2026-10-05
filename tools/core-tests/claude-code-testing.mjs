// The part of `claude-code/testing` the pure tests use (describe, test, expect),
// over node:test. Jest-style semantics: toEqual ignores undefined properties,
// toMatchObject checks a subset, toBe is Object.is.

import { strict as assert } from 'node:assert'
import { describe as nodeDescribe, test as nodeTest } from 'node:test'
import { inspect } from 'node:util'

export const describe = (name, fn) => nodeDescribe(name, fn)

/** test(name, fn) or test(name, options, fn); the pure tests take no arguments. */
export const test = (name, ...rest) => {
  const fn = rest.at(-1)
  nodeTest(name, () => fn())
}

const isObject = v => typeof v === 'object' && v !== null

function equals(a, b) {
  if (Object.is(a, b)) return true
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => equals(v, b[i]))
  const keys = o => Object.keys(o).filter(k => o[k] !== undefined)
  const [ka, kb] = [keys(a), keys(b)]
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && equals(a[k], b[k]))
}

function matchesObject(actual, expected) {
  if (!isObject(expected)) return equals(actual, expected)
  if (!isObject(actual)) return false
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matchesObject(actual[i], v))
  }
  return Object.keys(expected).every(k => matchesObject(actual[k], expected[k]))
}

export function expect(actual) {
  const matchers = isNot => {
    const check = (pass, what, ...expected) => {
      if (pass !== isNot) return
      const tail = expected.length ? ` ${inspect(expected[0], { depth: 6 })}` : ''
      assert.fail(`expected ${inspect(actual, { depth: 6 })} ${isNot ? 'not ' : ''}${what}${tail}`)
    }
    return {
      toBe: e => check(Object.is(actual, e), 'to be', e),
      toEqual: e => check(equals(actual, e), 'to equal', e),
      toMatchObject: e => check(matchesObject(actual, e), 'to match object', e),
      toMatch: e => check(typeof actual === 'string' && (typeof e === 'string' ? actual.includes(e) : e.test(actual)), 'to match', e),
      toBeNull: () => check(actual === null, 'to be null'),
      toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    }
  }
  return { ...matchers(false), not: matchers(true) }
}
