import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** A ⚙ button opening a small click-away popover — column toggles, chart options. */
export function GearMenu({
  label,
  icon = '⚙',
  children,
}: {
  label: string
  /** Glyph shown on the trigger button; defaults to the gear. */
  icon?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="gear-menu" ref={ref}>
      <button
        type="button"
        className={`btn gear-btn ${open ? 'primary' : ''}`}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
      </button>
      {open && <div className="gear-pop">{children}</div>}
    </div>
  )
}
