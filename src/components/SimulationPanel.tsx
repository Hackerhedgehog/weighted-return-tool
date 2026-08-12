import type { BankrollConfig, BucketRow, SimMode } from '../lib/types'
import { BankrollSim, type BankrollWorkerLike } from './BankrollSim'
import { ConvergenceSim, type SimWorkerLike } from './ConvergenceSim'

/**
 * The simulation panel's shell: a mode toggle over two independent panels.
 *
 * The two modes answer different questions — "what does this table converge
 * to" and "how long does a player last on it" — and share almost nothing but
 * the chart slot, so each owns its own controls, worker and chart rather than
 * one component branching throughout.
 */

interface SimulationPanelProps {
  mode: SimMode
  onMode: (m: SimMode) => void
  rows: BucketRow[]
  totalWeight: number
  /** The table's weighted return right now. */
  expectedRtp: number
  spins: number
  onSpins: (n: number) => void
  bankroll: BankrollConfig
  onBankroll: (c: BankrollConfig) => void
  /** Shared by both modes — one chart slot, one remembered height. */
  chartHeight: number
  onChartHeight: (h: number) => void
  /** Independent per mode — each chart keeps its own zoom. */
  simYZoom: number
  onSimYZoom: (z: number) => void
  simYPan: number
  onSimYPan: (p: number) => void
  simXZoom: number
  onSimXZoom: (z: number) => void
  simXPan: number
  onSimXPan: (p: number) => void
  bankrollYZoom: number
  onBankrollYZoom: (z: number) => void
  bankrollYPan: number
  onBankrollYPan: (p: number) => void
  bankrollXZoom: number
  onBankrollXZoom: (z: number) => void
  bankrollXPan: number
  onBankrollXPan: (p: number) => void
  createWorker?: () => SimWorkerLike
  createBankrollWorker?: () => BankrollWorkerLike
}

const MODES: { id: SimMode; label: string; title: string }[] = [
  { id: 'convergence', label: 'Convergence', title: 'Spin the table and watch its RTP settle' },
  { id: 'bankroll', label: 'Bankroll', title: 'Play the table with a balance until it runs out' },
]

export function SimulationPanel({
  mode,
  onMode,
  rows,
  totalWeight,
  expectedRtp,
  spins,
  onSpins,
  bankroll,
  onBankroll,
  chartHeight,
  onChartHeight,
  simYZoom,
  onSimYZoom,
  simYPan,
  onSimYPan,
  simXZoom,
  onSimXZoom,
  simXPan,
  onSimXPan,
  bankrollYZoom,
  onBankrollYZoom,
  bankrollYPan,
  onBankrollYPan,
  bankrollXZoom,
  onBankrollXZoom,
  bankrollXPan,
  onBankrollXPan,
  createWorker,
  createBankrollWorker,
}: SimulationPanelProps) {
  return (
    <>
      <div className="sim-modes" role="group" aria-label="Simulation mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`btn ${mode === m.id ? 'primary' : ''}`}
            aria-pressed={mode === m.id}
            title={m.title}
            onClick={() => onMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'convergence' ? (
        <ConvergenceSim
          rows={rows}
          totalWeight={totalWeight}
          expectedRtp={expectedRtp}
          spins={spins}
          onSpins={onSpins}
          chartHeight={chartHeight}
          onChartHeight={onChartHeight}
          yZoom={simYZoom}
          onYZoom={onSimYZoom}
          yPan={simYPan}
          onYPan={onSimYPan}
          xZoom={simXZoom}
          onXZoom={onSimXZoom}
          xPan={simXPan}
          onXPan={onSimXPan}
          createWorker={createWorker}
        />
      ) : (
        <BankrollSim
          rows={rows}
          totalWeight={totalWeight}
          tableRtp={expectedRtp}
          config={bankroll}
          onConfig={onBankroll}
          chartHeight={chartHeight}
          onChartHeight={onChartHeight}
          yZoom={bankrollYZoom}
          onYZoom={onBankrollYZoom}
          yPan={bankrollYPan}
          onYPan={onBankrollYPan}
          xZoom={bankrollXZoom}
          onXZoom={onBankrollXZoom}
          xPan={bankrollXPan}
          onXPan={onBankrollXPan}
          createWorker={createBankrollWorker}
        />
      )}
    </>
  )
}
