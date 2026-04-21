import { describe, expect, it } from 'vitest'

import { compareCalver, formatVersionLabel } from './calver'

describe('calver', () => {
  it('orders same-day release ordinals after the stable date tag', () => {
    expect(compareCalver('2026.4.21-1', '2026.4.21')).toBe(1)
    expect(compareCalver('2026.4.21-3', '2026.4.21-1')).toBe(1)
  })

  it('orders prereleases before the stable date tag', () => {
    expect(compareCalver('2026.4.21-beta.1', '2026.4.21')).toBe(-1)
  })

  it('formats labels without double-prefixing a version', () => {
    expect(formatVersionLabel('2026.4.21-1')).toBe('v2026.4.21-1')
    expect(formatVersionLabel('v2026.4.21-1')).toBe('v2026.4.21-1')
  })
})
