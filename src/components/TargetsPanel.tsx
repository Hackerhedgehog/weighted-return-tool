import { useState } from 'react'
import { evaluateExpression } from '../lib/expr'
import { fmtFixed3, fmtPct, fmtRtp } from '../lib/format'
import {
  CURVE_PRESETS,
  VOLATILITY_STEPS,
  WEIGHT_STEPS,
  type Targets,
  type Volatility,
  type WeightStep,
} from '../lib/types'
import type { Stats } from '../lib/distribute'
import { RtpGauge } from './RtpGauge'
import { remapNumpadComma } from './numpadDecimal'

interface TargetsPanelProps {
  targets: Targets
  volatility: Volatility
  curve: number
  weightStep: WeightStep
  achieved: Stats
  warnings: string[]
  bucketCount: number
  lockedCount: number
  canUndo: boolean
  canRedo: boolean
  onTargets: (t: Targets) => void
  onVolatility: (v: Exclude<Volatility, 'custom'>) => void
  onCurve: (c: number) => void
  onWeightStep: (s: WeightStep) => void
  onAutoDistribute: () => void
  onUndo: () => void
  onRedo: () => void
}

/** Small numeric field that also accepts arithmetic, like the grid cells do. */
function PanelNumber({
  display,
  raw,
  onCommit,
  validate,
  className,
  title,
  ariaLabel,
}: {
  display: string
  raw: string
  onCommit: (n: number) => void
  validate?: (n: number) => boolean
  className?: string
  title?: string
  ariaLabel: string
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const n = evaluateExpression(draft)
    setDraft(null)
    if (n !== null && (!validate || validate(n))) onCommit(n)
  }

  return (
    <input
      className={`panel-num ${className ?? ''}`}
      value={draft ?? display}
      title={title}
      aria-label={ariaLabel}
      spellCheck={false}
      onFocus={(e) => {
        setDraft(raw)
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (remapNumpadComma(e)) {
          setDraft(e.currentTarget.value)
          return
        }
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setDraft(null)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

function ChanceTarget({
  label,
  preferred,
  achieved,
  tolerance,
  onChange,
  onUseCurrent,
}: {
  label: string
  preferred: number
  achieved: number
  tolerance: number
  onChange: (n: number) => void
  onUseCurrent: () => void
}) {
  const tau = tolerance / 100
  const lo = preferred * (1 - tau)
  const hi = preferred * (1 + tau)
  const inBand =
    !Number.isFinite(achieved) || (achieved >= lo - 1e-9 && achieved <= hi + 1e-9)

  return (
    <div className="target-field">
      <label className="field-label">{label}</label>
      <PanelNumber
        display={String(preferred)}
        raw={String(preferred)}
        ariaLabel={label}
        validate={(n) => n >= 0 && n <= 1}
        onCommit={onChange}
      />
      {/* The band lives in the badge's tooltip: the row has six fields to fit
          now, and it is reference detail rather than something to watch. */}
      <div className="field-meta">
        <span
          className={`badge ${inBand ? 'ok' : 'warn'}`}
          title={`${inBand ? 'Within' : 'Outside'} tolerance · ${fmtPct(achieved, 2)} · band ${fmtFixed3(lo)}–${fmtFixed3(hi)}`}
        >
          {fmtFixed3(achieved)}
        </span>
        <button type="button" className="link-btn" onClick={onUseCurrent} title="Copy the achieved value into the target">
          = current
        </button>
      </div>
    </div>
  )
}

export function TargetsPanel(props: TargetsPanelProps) {
  const {
    targets,
    volatility,
    curve,
    weightStep,
    achieved,
    warnings,
    bucketCount,
    lockedCount,
    canUndo,
    canRedo,
    onTargets,
    onVolatility,
    onCurve,
    onWeightStep,
    onAutoDistribute,
    onUndo,
    onRedo,
  } = props

  const invalid =
    !(targets.rtp > 0) ||
    !(targets.winChance >= 0) ||
    targets.winChance > targets.hitChance ||
    targets.hitChance > 1 ||
    targets.tolerance < 0 ||
    targets.tolerance > 50

  const rtpDelta = achieved.rtp - targets.rtp

  return (
    <section className="targets">
      <div className="targets-row">
        <div className="target-field rtp">
          <label className="field-label">Target RTP</label>
          <PanelNumber
            display={String(targets.rtp)}
            raw={String(targets.rtp)}
            ariaLabel="Target RTP"
            validate={(n) => n > 0}
            onCommit={(n) => onTargets({ ...targets, rtp: n })}
          />
          <div className="field-meta">
            <span
              className={`badge ${Math.abs(rtpDelta) < 1e-6 ? 'ok' : 'warn'}`}
              title={
                Number.isFinite(rtpDelta) && Math.abs(rtpDelta) >= 1e-6
                  ? `off by ${rtpDelta > 0 ? '+' : ''}${rtpDelta.toFixed(6)}`
                  : 'on target'
              }
            >
              {fmtRtp(achieved.rtp)}
            </span>
            <span className="field-hint">{fmtPct(achieved.rtp, 2)}</span>
          </div>
          <RtpGauge rtp={achieved.rtp} target={targets.rtp} />
        </div>

        <ChanceTarget
          label="Preferred Hit Chance"
          preferred={targets.hitChance}
          achieved={achieved.hitChance}
          tolerance={targets.tolerance}
          onChange={(n) => onTargets({ ...targets, hitChance: n })}
          onUseCurrent={() =>
            Number.isFinite(achieved.hitChance) &&
            onTargets({ ...targets, hitChance: Number(achieved.hitChance.toFixed(6)) })
          }
        />

        <ChanceTarget
          label="Preferred Win Chance"
          preferred={targets.winChance}
          achieved={achieved.winChance}
          tolerance={targets.tolerance}
          onChange={(n) => onTargets({ ...targets, winChance: n })}
          onUseCurrent={() =>
            Number.isFinite(achieved.winChance) &&
            onTargets({ ...targets, winChance: Number(achieved.winChance.toFixed(6)) })
          }
        />

        <div className="target-field">
          <label className="field-label">Chance tolerance</label>
          <PanelNumber
            display={`${targets.tolerance}%`}
            raw={String(targets.tolerance)}
            ariaLabel="Chance tolerance percent"
            title="Relative band on hit and win chance — spent only when RTP is otherwise out of reach"
            validate={(n) => n >= 0 && n <= 50}
            onCommit={(n) => onTargets({ ...targets, tolerance: n })}
          />
          <div className="field-meta">
            <span className="field-hint">relative</span>
          </div>
        </div>

        <div className="target-field">
          <label className="field-label">Volatility</label>
          <div className="seg small">
            {VOLATILITY_STEPS.map((v) => (
              <button
                key={v}
                type="button"
                className={`seg-btn ${volatility === v ? 'active' : ''}`}
                onClick={() => onVolatility(v)}
                title={`curve c = ${CURVE_PRESETS[v]}`}
              >
                {v}
              </button>
            ))}
            <span className={`seg-btn custom ${volatility === 'custom' ? 'active' : ''}`}>custom</span>
          </div>
        </div>

        <div className="target-field">
          <label className="field-label">Curve c</label>
          <PanelNumber
            display={String(curve)}
            raw={String(curve)}
            ariaLabel="Curve curvature"
            title="0 = straight line on a log-log chart · higher bends the tail down"
            validate={(n) => n >= 0 && n <= 2}
            onCommit={onCurve}
          />
        </div>
      </div>

      <div className="targets-row">
        <div className="target-field">
          <label className="field-label">Weight step</label>
          <div className="seg small">
            {WEIGHT_STEPS.map((s) => (
              <button
                key={s}
                type="button"
                className={`seg-btn ${weightStep === s ? 'active' : ''}`}
                onClick={() => onWeightStep(s)}
                title={s === 1 ? 'Weights land on any integer' : `Distributed weights land on multiples of ${s}`}
              >
                {s === 1 ? 'free' : `×${s}`}
              </button>
            ))}
          </div>
          <div className="field-meta">
            <span className="field-hint">granularity of distributed weights — typed cells are never snapped</span>
          </div>
        </div>

        <div className="target-field actions">
          <button
            type="button"
            className="btn primary"
            onClick={onAutoDistribute}
            disabled={invalid || bucketCount === 0}
            title={invalid ? 'Fix the targets first' : 'Redistribute unlocked weights to hit these targets'}
          >
            Auto-Distribute
          </button>
          <div className="btn-row">
            <button type="button" className="btn" onClick={onUndo} disabled={!canUndo} title="Ctrl+Z">
              ↶ Undo
            </button>
            <button type="button" className="btn" onClick={onRedo} disabled={!canRedo} title="Ctrl+Y">
              ↷ Redo
            </button>
          </div>
          <span className="field-hint">
            {bucketCount} buckets{lockedCount > 0 && <> · {lockedCount} locked</>}
          </span>
        </div>
      </div>

      {invalid && (
        <p className="notice error">
          Targets must satisfy RTP &gt; 0 and 0 ≤ win chance ≤ hit chance ≤ 1, with tolerance
          between 0 and 50%.
        </p>
      )}

      {warnings.map((w) => (
        <p className="notice warn" key={w}>
          {w}
        </p>
      ))}
    </section>
  )
}
