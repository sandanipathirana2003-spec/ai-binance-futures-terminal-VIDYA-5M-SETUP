// Multi-timeframe setup engine: 1H trend -> 15M confirmation -> 5M entry (MA 9/21 cross + Volumatic VIDYA).
// Pure functions only — the /api/setup route feeds them candles and the Setup tab renders the result.

import type { Candle } from './binance'
import { atr, emaSeries, vidya, vidyaLine } from './indicators'

// ---- Tunable rules ---------------------------------------------------------------------------
export const MTF_FAST = 9
export const MTF_SLOW = 21
/** VIDYA line change over 3 candles, in 5m ATRs. Below WEAK = "only a very small initial movement". */
export const VIDYA_WEAK_SLOPE_ATR = 0.1
/** At or above this (and accelerating, with rising volume) the VIDYA move counts as strong. */
export const VIDYA_STRONG_SLOPE_ATR = 0.25
/** The VIDYA line must have moved the same way for at least this many closed candles. */
export const VIDYA_MIN_RUN = 3
/** Avg volume of the last 3 closed candles vs the 10 before them. */
export const VOLUME_RISE_RATIO = 1.1
/** 5m MA cross within this many closed candles is reported as a fresh cross. */
export const RECENT_CROSS_BARS = 3
/** 5m is "choppy" with this many MA crosses in the lookback, or when the MAs are nearly on top of each other. */
export const CHOP_CROSSES = 3
export const CHOP_LOOKBACK = 24
export const CHOP_SPREAD_ATR = 0.15

const MS = { '1h': 3_600_000, '15m': 900_000, '5m': 300_000 } as const

export type SetupState = 'BUY SETUP' | 'SELL SETUP' | 'WAIT' | 'NO TRADE'
export type Bias = 'BULLISH' | 'BEARISH'
export type VidyaStrength = 'STRONG' | 'BUILDING' | 'WEAK' | 'OPPOSITE'

export interface SetupCheck {
  label: string
  passed: boolean
  detail: string
}

export interface TfMa {
  bias: Bias
  fast: number
  slow: number
  /** Closed candles since the last fast/slow cross, or -1 if none in the window. */
  barsSinceCross: number
  spreadPct: number
}

export interface SetupAnalysis {
  state: SetupState
  side: 'LONG' | 'SHORT' | null
  headline: string
  reasons: string[]
  checks: SetupCheck[]
  h1: TfMa
  m15: TfMa
  m5: TfMa & { crossesInLookback: number; spreadAtr: number; choppy: boolean; crossFormingNow: boolean }
  vidya: {
    direction: 'UP' | 'DOWN'
    strength: VidyaStrength
    value: number
    slopeAtr: number
    prevSlopeAtr: number
    runBars: number
    accelerating: boolean
    volRatio: number
    deltaPct: number
  }
  candle: { open: number; close: number; confirms: boolean; formingClosesInSec: number }
  price: number
}

function closedOnly(candles: Candle[], intervalMs: number, now: number): Candle[] {
  const last = candles.at(-1)
  return last && last.openTime + intervalMs > now ? candles.slice(0, -1) : candles
}

function maInfo(closes: number[]): { ma: TfMa; crosses: number } {
  const f = emaSeries(closes, MTF_FAST)
  const s = emaSeries(closes, MTF_SLOW)
  const n = closes.length
  const bull = (i: number) => f[i] > s[i]
  let barsSinceCross = -1
  let crosses = 0
  for (let i = n - 1; i >= MTF_SLOW; i--) {
    if (bull(i) !== bull(i - 1)) {
      if (barsSinceCross === -1) barsSinceCross = n - 1 - i
      if (n - 1 - i < CHOP_LOOKBACK) crosses++
    }
  }
  const fast = f[n - 1]
  const slow = s[n - 1]
  return { ma: { bias: fast > slow ? 'BULLISH' : 'BEARISH', fast, slow, barsSinceCross, spreadPct: ((fast - slow) / slow) * 100 }, crosses }
}

export function analyzeSetup(h1Raw: Candle[], m15Raw: Candle[], m5Raw: Candle[], now = Date.now()): SetupAnalysis | null {
  const h1 = closedOnly(h1Raw, MS['1h'], now)
  const m15 = closedOnly(m15Raw, MS['15m'], now)
  const m5 = closedOnly(m5Raw, MS['5m'], now)
  if (h1.length < 60 || m15.length < 60 || m5.length < 60) return null

  const h1Ma = maInfo(h1.map((c) => c.close)).ma
  const m15Ma = maInfo(m15.map((c) => c.close)).ma
  const { ma: m5Ma, crosses } = maInfo(m5.map((c) => c.close))
  const liveMa = maInfo(m5Raw.map((c) => c.close)).ma // includes the still-forming 5m candle

  const side: 'LONG' | 'SHORT' | null =
    h1Ma.bias === 'BULLISH' && m15Ma.bias === 'BULLISH' ? 'LONG' : h1Ma.bias === 'BEARISH' && m15Ma.bias === 'BEARISH' ? 'SHORT' : null
  const ref: 'LONG' | 'SHORT' = side ?? (h1Ma.bias === 'BULLISH' ? 'LONG' : 'SHORT')
  const wantUp = ref === 'LONG'
  const wantBias: Bias = wantUp ? 'BULLISH' : 'BEARISH'
  const word = wantUp ? 'above' : 'below'

  // ---- 5m VIDYA ----
  const cl5 = m5.map((c) => c.close)
  const n = cl5.length
  const line = vidyaLine(cl5)
  const atr5 = Math.max(atr(m5, 14), 1e-12)
  const slopeAtr = (line[n - 1] - line[n - 4]) / atr5
  const prevSlopeAtr = (line[n - 4] - line[n - 7]) / atr5
  const dirUp = slopeAtr > 0
  const lastDiffUp = line[n - 1] - line[n - 2] > 0
  let runBars = 0
  for (let i = n - 1; i >= 1; i--) {
    if (line[i] - line[i - 1] > 0 === lastDiffUp) runBars++
    else break
  }
  const accelerating = wantUp ? slopeAtr > prevSlopeAtr && slopeAtr > 0 : slopeAtr < prevSlopeAtr && slopeAtr < 0
  const avg = (xs: Candle[]) => xs.reduce((a, c) => a + c.volume, 0) / Math.max(1, xs.length)
  const volRatio = avg(m5.slice(-3)) / Math.max(avg(m5.slice(-13, -3)), 1e-12)
  const deltaPct = vidya(m5)?.deltaPct ?? 0

  const vidyaAligned = dirUp === wantUp
  const deltaAligned = wantUp ? deltaPct > 0 : deltaPct < 0
  const absSlope = Math.abs(slopeAtr)
  const justStarted = runBars < VIDYA_MIN_RUN || absSlope < VIDYA_WEAK_SLOPE_ATR
  let strength: VidyaStrength
  if (!vidyaAligned) strength = 'OPPOSITE'
  else if (absSlope >= VIDYA_STRONG_SLOPE_ATR && accelerating && volRatio >= VOLUME_RISE_RATIO && deltaAligned && runBars >= VIDYA_MIN_RUN) strength = 'STRONG'
  else if (justStarted) strength = 'WEAK'
  else strength = 'BUILDING'

  // ---- 5m candle confirmation (last CLOSED candle) ----
  const lastClosed = m5[n - 1]
  const confirms = wantUp ? lastClosed.close > lastClosed.open && lastClosed.close > m5Ma.fast : lastClosed.close < lastClosed.open && lastClosed.close < m5Ma.fast
  const forming = m5Raw.at(-1)!
  const formingClosesInSec = forming.openTime + MS['5m'] > now ? Math.max(0, Math.round((forming.openTime + MS['5m'] - now) / 1000)) : 0

  const spreadAtr = Math.abs(m5Ma.fast - m5Ma.slow) / atr5
  const choppy = crosses >= CHOP_CROSSES || spreadAtr < CHOP_SPREAD_ATR
  const maAligned = m5Ma.bias === wantBias
  const crossFormingNow = liveMa.bias !== m5Ma.bias

  // ---- state ----
  const reasons: string[] = []
  let state: SetupState
  const setup: SetupState = wantUp ? 'BUY SETUP' : 'SELL SETUP'
  const dirWord = wantUp ? 'bullish' : 'bearish'

  if (side === null) {
    state = 'NO TRADE'
    reasons.push(`1H is ${h1Ma.bias.toLowerCase()} but 15M is ${m15Ma.bias.toLowerCase()} — higher timeframes disagree.`)
  } else if (!maAligned && liveMa.bias === wantBias) {
    state = 'WAIT'
    reasons.push(`5M MA cross is forming ${word} but the candle has not closed yet (${formingClosesInSec}s left).`)
  } else if (!maAligned) {
    state = 'NO TRADE'
    reasons.push(`5M fast MA is ${m5Ma.bias === 'BULLISH' ? 'above' : 'below'} slow — conflicts with the 1H/15M ${dirWord} trend.`)
  } else if (choppy) {
    state = 'NO TRADE'
    reasons.push(
      crosses >= CHOP_CROSSES
        ? `5M is choppy: ${crosses} MA crosses in the last ${CHOP_LOOKBACK} candles.`
        : `5M is sideways: fast and slow MA are only ${spreadAtr.toFixed(2)} ATR apart.`,
    )
  } else if (strength === 'OPPOSITE') {
    state = 'NO TRADE'
    reasons.push(`VIDYA is moving ${dirUp ? 'up' : 'down'} against the ${dirWord} trend.`)
  } else if (crossFormingNow) {
    state = 'WAIT'
    reasons.push('The forming 5M candle is crossing the MAs back — wait for it to close.')
  } else if (strength === 'WEAK') {
    state = 'WAIT'
    reasons.push(
      absSlope < VIDYA_WEAK_SLOPE_ATR
        ? `VIDYA has only moved ${absSlope.toFixed(2)} ATR over 3 candles — too small an initial move.`
        : `VIDYA only turned ${runBars} candle${runBars === 1 ? '' : 's'} ago — it has just started moving.`,
    )
  } else if (strength === 'BUILDING') {
    state = 'WAIT'
    const missing = [!accelerating && 'not accelerating', volRatio < VOLUME_RISE_RATIO && 'volume not rising', !deltaAligned && 'volume delta not aligned', absSlope < VIDYA_STRONG_SLOPE_ATR && 'slope below strong level'].filter(Boolean)
    reasons.push(`Trend is aligned but VIDYA momentum is not strong yet (${missing.join(', ')}).`)
  } else if (!confirms) {
    state = 'WAIT'
    reasons.push(`Momentum is strong — waiting for a ${dirWord} 5M candle close ${word} the fast MA.`)
  } else {
    state = setup
    reasons.push(`1H and 15M ${dirWord}, 5M MA ${word} slow, VIDYA momentum strong, 5M candle closed ${dirWord}.`)
  }

  const headline =
    state === setup
      ? `${wantUp ? 'LONG' : 'SHORT'} setup confirmed on the last closed 5M candle`
      : state === 'WAIT'
        ? 'Trend aligned — not ready to enter yet'
        : 'Stay out'

  const checks: SetupCheck[] = [
    { label: `1H fast MA ${word} slow`, passed: h1Ma.bias === wantBias, detail: `EMA${MTF_FAST}/${MTF_SLOW} spread ${h1Ma.spreadPct.toFixed(2)}%` },
    { label: `15M fast MA ${word} slow`, passed: m15Ma.bias === wantBias, detail: `EMA${MTF_FAST}/${MTF_SLOW} spread ${m15Ma.spreadPct.toFixed(2)}%` },
    {
      label: `5M fast MA ${word} slow`,
      passed: maAligned,
      detail: m5Ma.barsSinceCross >= 0 && m5Ma.barsSinceCross <= RECENT_CROSS_BARS ? `crossed ${m5Ma.barsSinceCross} candle(s) ago` : maAligned ? 'already in position' : 'against trend',
    },
    { label: '5M not choppy', passed: !choppy, detail: `${crosses} crosses / ${CHOP_LOOKBACK} candles · spread ${spreadAtr.toFixed(2)} ATR` },
    { label: `VIDYA turning ${wantUp ? 'up' : 'down'}`, passed: vidyaAligned, detail: `${slopeAtr >= 0 ? '+' : ''}${slopeAtr.toFixed(2)} ATR / 3 candles` },
    { label: 'VIDYA not a weak start', passed: !justStarted, detail: `moving ${runBars} candle(s) · min ${VIDYA_MIN_RUN} & ${VIDYA_WEAK_SLOPE_ATR} ATR` },
    { label: 'VIDYA momentum increasing', passed: accelerating, detail: `now ${slopeAtr.toFixed(2)} vs prior ${prevSlopeAtr.toFixed(2)} ATR` },
    { label: 'Volume rising', passed: volRatio >= VOLUME_RISE_RATIO, detail: `last 3 candles = ${volRatio.toFixed(2)}x prior 10` },
    { label: 'VIDYA volume delta aligned', passed: deltaAligned, detail: `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}% since trend start` },
    { label: `5M candle closed ${dirWord}`, passed: confirms, detail: `last close ${lastClosed.close} vs open ${lastClosed.open}` },
  ]

  const v = vidya(m5)
  return {
    state,
    side,
    headline,
    reasons,
    checks,
    h1: h1Ma,
    m15: m15Ma,
    m5: { ...m5Ma, crossesInLookback: crosses, spreadAtr, choppy, crossFormingNow },
    vidya: { direction: dirUp ? 'UP' : 'DOWN', strength, value: v?.value ?? line[n - 1], slopeAtr, prevSlopeAtr, runBars, accelerating, volRatio, deltaPct },
    candle: { open: lastClosed.open, close: lastClosed.close, confirms, formingClosesInSec },
    price: forming.close,
  }
}
