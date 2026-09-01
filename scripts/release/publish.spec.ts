import { describe, expect, it } from 'vitest'
import { parseRegistryIntegrity } from './publish.ts'

describe('registry integrity parsing', () => {
  it.each([
    ['sha512-string', 'sha512-string'],
    [['sha512-array'], 'sha512-array'],
  ])('accepts one integrity value from npm JSON output: %j', (value, expected) => {
    expect(parseRegistryIntegrity(value)).toBe(expected)
  })

  it.each([
    undefined,
    null,
    '',
    [],
    [''],
    ['sha512-first', 'sha512-second'],
    { integrity: 'sha512-nested' },
  ])('rejects missing or ambiguous output: %j', (value) => {
    expect(parseRegistryIntegrity(value)).toBeUndefined()
  })
})
