// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GearMenu } from './GearMenu'

describe('GearMenu', () => {
  afterEach(cleanup)

  it('opens on click, closes on outside pointerdown and Escape', () => {
    render(
      <div>
        <GearMenu label="Table settings">
          <span>Inside</span>
        </GearMenu>
        <button>outside</button>
      </div>,
    )
    expect(screen.queryByText('Inside')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Table settings' }))
    expect(screen.getByText('Inside')).toBeTruthy()
    fireEvent.pointerDown(screen.getByText('outside'))
    expect(screen.queryByText('Inside')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Table settings' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Inside')).toBeNull()
  })

  it('stays open on pointerdown inside the popover', () => {
    render(
      <GearMenu label="Table settings">
        <span>Inside</span>
      </GearMenu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Table settings' }))
    fireEvent.pointerDown(screen.getByText('Inside'))
    expect(screen.getByText('Inside')).toBeTruthy()
  })
})
