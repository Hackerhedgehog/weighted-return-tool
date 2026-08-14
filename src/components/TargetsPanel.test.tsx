// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TargetsPanel } from './TargetsPanel'
import { DEFAULT_TARGETS } from '../lib/types'
import type { Stats } from '../lib/distribute'

afterEach(cleanup)

const ACHIEVED: Stats = { rtp: 0.95, hitChance: 0.293, winChance: 0.118 }

const renderPanel = (over: Partial<React.ComponentProps<typeof TargetsPanel>> = {}) => {
  const onTargets = vi.fn()
  render(
    <TargetsPanel
      targets={DEFAULT_TARGETS}
      volatility="medium"
      curve={0.09}
      weightStep={1}
      achieved={ACHIEVED}
      warnings={[]}
      bucketCount={30}
      lockedCount={0}
      hasUserCurve={false}
      collapsed={false}
      panelRef={() => {}}
      onCollapsed={() => {}}
      onTargets={onTargets}
      onVolatility={() => {}}
      onCurve={() => {}}
      onAutoDistribute={() => {}}
      {...over}
    />,
  )
  return { onTargets }
}

const hitField = () => screen.getByLabelText('Preferred Hit Chance') as HTMLInputElement

describe('TargetsPanel chance fields', () => {
  it('displays the preferred chances in percent, like the tolerance field', () => {
    renderPanel()
    expect(hitField().value).toBe('30%')
    expect((screen.getByLabelText('Preferred Win Chance') as HTMLInputElement).value).toBe('12%')
    expect((screen.getByLabelText('Chance tolerance percent') as HTMLInputElement).value).toBe(
      '3.5%',
    )
  })

  it('survives the fraction → percent round trip without float noise', () => {
    // 0.07 * 100 is the classic case: naive conversion shows 7.000000000000001.
    renderPanel({ targets: { ...DEFAULT_TARGETS, hitChance: 0.07, winChance: 0.001 } })
    expect(hitField().value).toBe('7%')
    expect((screen.getByLabelText('Preferred Win Chance') as HTMLInputElement).value).toBe('0.1%')
  })

  it('edits as a plain percent number, without the % sign', () => {
    renderPanel()
    fireEvent.focus(hitField())
    expect(hitField().value).toBe('30')
  })

  it('commits a typed percent as a stored fraction', () => {
    const { onTargets } = renderPanel()
    const input = hitField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.blur(input)
    expect(onTargets).toHaveBeenCalledWith({ ...DEFAULT_TARGETS, hitChance: 0.25 })
  })

  it('evaluates arithmetic in percent terms', () => {
    const { onTargets } = renderPanel()
    const input = hitField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '25+5' } })
    fireEvent.blur(input)
    expect(onTargets).toHaveBeenCalledWith({ ...DEFAULT_TARGETS, hitChance: 0.3 })
  })

  it('accepts the whole 0–100 range and nothing outside it', () => {
    const { onTargets } = renderPanel()
    for (const bad of ['150', '-1']) {
      const input = hitField()
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: bad } })
      fireEvent.blur(input)
    }
    expect(onTargets).not.toHaveBeenCalled()

    const input = hitField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.blur(input)
    expect(onTargets).toHaveBeenCalledWith({ ...DEFAULT_TARGETS, hitChance: 1 })
  })

  it('shows the achieved badges in percent', () => {
    renderPanel()
    expect(screen.getByText('29.3%')).toBeDefined()
    expect(screen.getByText('11.8%')).toBeDefined()
  })

  it('copies the achieved fraction into the target from = current', () => {
    const { onTargets } = renderPanel()
    fireEvent.click(screen.getAllByRole('button', { name: '= current' })[0])
    expect(onTargets).toHaveBeenCalledWith({ ...DEFAULT_TARGETS, hitChance: 0.293 })
  })

  it('states the cross-field constraint in percent', () => {
    renderPanel({ targets: { ...DEFAULT_TARGETS, hitChance: 0.1, winChance: 0.2 } })
    expect(
      screen.getByText(/0 ≤ win chance ≤ hit chance ≤ 100%, with tolerance/),
    ).toBeDefined()
  })

  it('reads the collapsed summary badges in percent', () => {
    renderPanel({ collapsed: true })
    const summary = document.querySelector('.targets-summary') as HTMLElement
    expect(within(summary).getByText('29.3%')).toBeDefined()
    expect(within(summary).getByText('11.8%')).toBeDefined()
  })
})

describe('TargetsPanel warnings', () => {
  const WARNINGS = [
    'Hit chance yielded to payout ordering — achieved 0.310 against a target of 0.3.',
    'Volatility flattened (curve 0.32 → 0.265) to keep weights ordered by payout while hitting RTP 0.95.',
    'Achieved win chance 0.100 is outside the ±3.5% band around 0.12.',
  ]

  it('shows every warning under a count line, open by default', () => {
    renderPanel({ warnings: WARNINGS })
    expect(screen.getByRole('button', { name: /3 warnings/ })).toBeDefined()
    expect(document.querySelectorAll('.notice.warn')).toHaveLength(3)
  })

  it('folds the details behind the count and unfolds them again', () => {
    renderPanel({ warnings: WARNINGS })
    const toggle = screen.getByRole('button', { name: /3 warnings/ })

    fireEvent.click(toggle)
    expect(document.querySelectorAll('.notice.warn')).toHaveLength(0)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(document.querySelectorAll('.notice.warn')).toHaveLength(3)
  })

  it('speaks in the singular for one warning', () => {
    renderPanel({ warnings: WARNINGS.slice(0, 1) })
    expect(screen.getByRole('button', { name: /1 warning$/ })).toBeDefined()
  })

  it('shows neither notices nor the count line when there is nothing to say', () => {
    renderPanel()
    expect(document.querySelector('.notice-toggle')).toBeNull()
    expect(document.querySelectorAll('.notice.warn')).toHaveLength(0)
  })

  it('leaves the invalid-targets error outside the fold', () => {
    renderPanel({
      warnings: WARNINGS,
      targets: { ...DEFAULT_TARGETS, hitChance: 0.1, winChance: 0.2 },
    })
    fireEvent.click(screen.getByRole('button', { name: /3 warnings/ }))
    // The error blocks Auto-Distribute, so it can never be folded away.
    expect(document.querySelector('.notice.error')).not.toBeNull()
    expect(document.querySelectorAll('.notice.warn')).toHaveLength(0)
  })
})
