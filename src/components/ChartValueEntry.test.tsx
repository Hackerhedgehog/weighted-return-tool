// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChartValueEntry } from './ChartValueEntry'

afterEach(cleanup)

const renderEntry = (over: Partial<React.ComponentProps<typeof ChartValueEntry>> = {}) => {
  const onCommit = vi.fn(() => true)
  const onClose = vi.fn()
  render(
    <ChartValueEntry
      target={{ title: 'bonus', uids: ['c', 'd'], current: 200_000, unit: 'weight' }}
      x={200}
      y={80}
      width={900}
      weightStep={1}
      onCommit={onCommit}
      onClose={onClose}
      {...over}
    />,
  )
  return { onCommit, onClose }
}

describe('ChartValueEntry', () => {
  it('names its target and pre-fills the current value', () => {
    renderEntry()
    expect(screen.getByText('bonus')).toBeDefined()
    expect((screen.getByLabelText('Weight') as HTMLInputElement).value).toBe('200000')
  })

  it('commits the typed value on Enter', () => {
    const { onCommit, onClose } = renderEntry()
    const input = screen.getByLabelText('Weight')
    fireEvent.change(input, { target: { value: '250000' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(250_000)
    expect(onClose).toHaveBeenCalled()
  })

  it('commits from the Set button too', () => {
    const { onCommit } = renderEntry()
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '1234' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set' }))
    expect(onCommit).toHaveBeenCalledWith(1234)
  })

  it('evaluates arithmetic the way the grid cells do', () => {
    const { onCommit } = renderEntry()
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '200000+50000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(250_000)
  })

  it('reads and writes percentages in chance mode', () => {
    const { onCommit } = renderEntry({
      target: { title: 'bonus', uids: ['c'], current: 20, unit: '%' },
    })
    const input = screen.getByLabelText('Chance %')
    expect((input as HTMLInputElement).value).toBe('20')
    fireEvent.change(input, { target: { value: '12.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(12.5)
  })

  it('rejects unreadable input without committing or closing', () => {
    const { onCommit, onClose } = renderEntry()
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: 'abc' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open when the commit is blocked by the weight step', () => {
    const onCommit = vi.fn(() => false)
    const onClose = vi.fn()
    renderEntry({ onCommit, onClose })
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '250000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })
    expect(onCommit).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape and on Cancel', () => {
    const { onClose } = renderEntry()
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes when the pointer goes down outside it', () => {
    const { onClose } = renderEntry()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalled()
  })

  it('names the weight step when there is one', () => {
    renderEntry({ weightStep: 10 })
    expect(screen.getByText(/step ×10/)).toBeDefined()
  })

  it('keeps itself inside the container near the right edge', () => {
    renderEntry({ x: 890, width: 900 })
    const box = document.querySelector('.chart-entry') as HTMLElement
    expect(parseFloat(box.style.left)).toBeLessThanOrEqual(900 - 200 - 6)
  })
})
