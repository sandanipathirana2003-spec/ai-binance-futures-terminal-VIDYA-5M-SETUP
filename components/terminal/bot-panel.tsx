'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, BookmarkPlus, Check, ShieldCheck, X, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPrice } from '@/lib/format'
import { useTrades } from '@/hooks/use-trades'
import { useVidya5m } from '@/hooks/use-vidya-5m'
import { VIDYA_SL_BUFFER_ATR, VIDYA_TP_R } from '@/lib/vidya-plan'
import type { BtcTrend, CoinSignal, Timeframe } from '@/lib/types'
import { TIMEFRAMES } from '@/lib/types'

const MIN_CONFIDENCE = 90
const RISK_PCT = 0.01
const WIDE_SCALP_SL_BUFFER = 0.002 // Rule 1: 0.2% below/above the 3-candle low/high
const WIDE_SCALP_BREAKEVEN_PLUS = 0.001 // Rule 3: entry +/- 0.1%
const WIDE_SCALP_EMA_TOLERANCE = 0.005 // Rule 5: within 0.5% of the 15m 20 EMA

type AtrMode = 'scalp' | 'balanced' | 'safe'
type Mode = AtrMode | 'wideScalp' | 'vidya5m'

// Each ATR mode reads ATR from the real timeframe it's meant to trade, and applies
// the multiplier recommended for that horizon — not a single fixed percentage.
const MODE_CONFIG: Record<AtrMode, { label: string; tf: Timeframe; multiplier: number }> = {
  scalp: { label: 'Scalp (1m-5m)', tf: '5m', multiplier: 1.5 },
  balanced: { label: 'Balanced (15m-1H)', tf: '15m', multiplier: 2.0 },
  safe: { label: 'Safe (1H swing)', tf: '1h', multiplier: 2.5 },
}

function Gauge({ score }: { score: number }) {
  const color = score >= 90 ? 'text-bull' : score >= 75 ? 'text-warn' : 'text-muted-foreground'
  const r = 34
  const c = 2 * Math.PI * r
  const offset = c - (score / 100) * c
  return (
    <div className="relative flex size-24 items-center justify-center">
      <svg className="size-24 -rotate-90" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={color}
        />
      </svg>
      <div className="absolute text-center">
        <span className={cn('font-mono text-xl font-bold', color)}>{score}</span>
        <span className="text-muted-foreground block text-[9px] uppercase">score</span>
      </div>
    </div>
  )
}

function Condition({ label, passed }: { label: string; passed: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="text-foreground/90">{label}</span>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold',
          passed ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear',
        )}
      >
        {passed ? <Check className="size-3" /> : <X className="size-3" />}
        {passed ? 'PASS' : 'FAIL'}
      </span>
    </li>
  )
}

export function BotPanel({ coin, btc }: { coin?: CoinSignal; btc?: BtcTrend }) {
  const [balance, setBalance] = useState(10000)
  const [leverage, setLeverage] = useState(10)
  const [mode, setMode] = useState<Mode>('vidya5m')
  const [logged, setLogged] = useState(false)
  const { addTrade } = useTrades()
  const { data: vidya5m, isLoading: vidyaLoading } = useVidya5m(coin?.symbol)

  const direction = coin?.trend === 'BULLISH' ? 'LONG' : coin?.trend === 'BEARISH' ? 'SHORT' : 'FLAT'
  const isLong = direction === 'LONG'

  const conditions = useMemo(() => {
    if (!coin || !btc) return []
    const desired = coin.trend === 'BULLISH' ? 'BUY' : coin.trend === 'BEARISH' ? 'SELL' : 'NEUTRAL'
    const tfChecks = TIMEFRAMES.map((t) => ({
      label: `${t} = ${coin.timeframes[t]}`,
      passed: desired !== 'NEUTRAL' && coin.timeframes[t] === desired,
    }))
    return [
      { label: `BTC Master = ${btc.trend}`, passed: btc.trend === coin.trend && coin.trend !== 'NEUTRAL' },
      ...tfChecks,
      { label: `AI Score > ${MIN_CONFIDENCE}%`, passed: coin.score >= MIN_CONFIDENCE },
    ]
  }, [coin, btc])

  const gatePassed = conditions.length > 0 && conditions.every((c) => c.passed)

  const atrSizing = useMemo(() => {
    if (!coin || mode === 'wideScalp' || mode === 'vidya5m') return null
    const cfg = MODE_CONFIG[mode]
    const entry = coin.price
    const atrValue = coin.tfAtr[cfg.tf] || 0

    // ATR-based stop: distance scales with each coin's REAL volatility on the
    // chosen horizon, instead of one fixed percentage for every coin/timeframe.
    const stopDistance = atrValue > 0 ? atrValue * cfg.multiplier : entry * 0.012 // safety fallback if ATR unavailable
    const sl = isLong ? entry - stopDistance : entry + stopDistance
    const riskPerUnit = Math.abs(entry - sl)

    const riskAmount = balance * RISK_PCT
    const qty = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0
    const notional = qty * entry

    // Risk:Reward-based targets, not fixed percentages — always proportional to the actual stop distance.
    const tp1 = isLong ? entry + riskPerUnit * 1.5 : entry - riskPerUnit * 1.5
    const tp2 = isLong ? entry + riskPerUnit * 2.0 : entry - riskPerUnit * 2.0
    const tp3 = isLong ? entry + riskPerUnit * 3.0 : entry - riskPerUnit * 3.0

    const liqDistancePct = (1 / leverage) * 100
    const liqPrice = isLong ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage)

    return { entry, atrValue, multiplier: cfg.multiplier, risk: riskAmount, notional, qty, sl, riskPerUnit, tp1, tp2, tp3, liqPrice, liqDistancePct }
  }, [coin, balance, isLong, mode, leverage])

  /**
   * VIDYA 5m sizing:
   *  - SL = the 5m Volumatic VIDYA flip band on the far side of the trade (lower band for longs, upper band
   *    for shorts) plus a 0.1 x ATR(5m) buffer. A close beyond that band is what flips the VIDYA trend,
   *    so it is the level where the setup is invalidated.
   *  - TP1/TP2/TP3 = 1.5R / 2R / 3R, where R is the entry-to-SL distance — a wider stop gives wider targets.
   *  - The stop follows the targets once logged: TP1 -> entry, TP2 -> TP1, close at TP3 (see useTrades).
   */
  const vidyaSizing = useMemo(() => {
    if (!coin || mode !== 'vidya5m' || direction === 'FLAT' || !vidya5m) return null
    const v = vidya5m.vidya
    const entry = coin.price
    const buffer = vidya5m.atr5m * VIDYA_SL_BUFFER_ATR
    const band = isLong ? v.lowerBand : v.upperBand
    const sl = isLong ? band - buffer : band + buffer
    const slOnCorrectSide = isLong ? sl < entry : sl > entry
    const riskPerUnit = Math.abs(entry - sl)
    if (!slOnCorrectSide || riskPerUnit <= 0) {
      return { invalid: true as const, entry, sl, trendMatches: v.direction === (isLong ? 'UP' : 'DOWN') }
    }

    const dir = isLong ? 1 : -1
    const [r1, r2, r3] = VIDYA_TP_R
    const tp1 = entry + dir * riskPerUnit * r1
    const tp2 = entry + dir * riskPerUnit * r2
    const tp3 = entry + dir * riskPerUnit * r3

    const riskAmount = balance * RISK_PCT
    const qty = riskAmount / riskPerUnit
    const notional = qty * entry
    const liqDistancePct = (1 / leverage) * 100
    const liqPrice = isLong ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage)
    const slDistancePct = (riskPerUnit / entry) * 100
    // Stop must sit well inside the liquidation price, or liquidation hits before the stop does.
    const stopBeyondLiq = slDistancePct >= liqDistancePct * 0.8

    return {
      invalid: false as const,
      entry,
      sl,
      band,
      riskPerUnit,
      slDistancePct,
      tp1,
      tp2,
      tp3,
      risk: riskAmount,
      qty,
      notional,
      liqPrice,
      liqDistancePct,
      stopBeyondLiq,
      atr5m: vidya5m.atr5m,
      vidya: v,
      trendMatches: v.direction === (isLong ? 'UP' : 'DOWN'),
    }
  }, [coin, mode, direction, vidya5m, isLong, balance, leverage])

  /**
   * Wide-Stop Scalp sizing per the 5-rule spec:
   *  1. SL = low (long) / high (short) of the previous 3 real 15m candles, +/- 0.2% buffer.
   *  2/4. TP1 = entry +/- 1x ATR(15m); TP2 = entry +/- 1.5x ATR(15m) — ATR-based (Rule 4),
   *       not the "1.5x SL distance" from Rule 2, since those two methods conflict
   *       whenever SL isn't itself ATR-based (it isn't here — see Rule 1).
   *  3. Breakeven-plus trigger (entry +/- 0.1%) fires at the same 1x-ATR point as TP1;
   *     handled automatically after logging — see useTrades' wideScalp branch.
   *  5. Entry filter: price must be within 0.5% of the 15m 20 EMA — pullback-only, no breakout chasing.
   */
  const wideScalpSizing = useMemo(() => {
    if (!coin || mode !== 'wideScalp' || direction === 'FLAT') return null
    const entry = coin.price
    const w = coin.wideScalp
    const basisPrices = isLong ? w.last3Lows : w.last3Highs
    if (basisPrices.length === 0) return null

    const extreme = isLong ? Math.min(...basisPrices) : Math.max(...basisPrices)
    const sl = isLong ? extreme * (1 - WIDE_SCALP_SL_BUFFER) : extreme * (1 + WIDE_SCALP_SL_BUFFER)
    const riskPerUnit = Math.abs(entry - sl)
    if (riskPerUnit <= 0) return null

    const atrValue = w.atr15m
    const tp1 = isLong ? entry + atrValue * 1 : entry - atrValue * 1
    const tp2 = isLong ? entry + atrValue * 1.5 : entry - atrValue * 1.5
    const impliedRR = riskPerUnit > 0 ? Math.abs(tp1 - entry) / riskPerUnit : 0

    const nearEma = w.ema20_15m > 0 && Math.abs(entry - w.ema20_15m) / entry <= WIDE_SCALP_EMA_TOLERANCE

    const riskAmount = balance * RISK_PCT
    const qty = riskAmount / riskPerUnit
    const notional = qty * entry

    const liqDistancePct = (1 / leverage) * 100
    const liqPrice = isLong ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage)
    const breakevenPlus = isLong ? entry * (1 + WIDE_SCALP_BREAKEVEN_PLUS) : entry * (1 - WIDE_SCALP_BREAKEVEN_PLUS)

    return { entry, sl, riskPerUnit, atrValue, tp1, tp2, impliedRR, nearEma, risk: riskAmount, notional, qty, liqPrice, liqDistancePct, breakevenPlus, basisCount: basisPrices.length }
  }, [coin, mode, balance, isLong, direction, leverage])

  const vidyaReady = Boolean(vidyaSizing && !vidyaSizing.invalid && vidyaSizing.trendMatches && !vidyaSizing.stopBeyondLiq)
  const allPass =
    mode === 'wideScalp' ? gatePassed && Boolean(wideScalpSizing?.nearEma) : mode === 'vidya5m' ? gatePassed && vidyaReady : gatePassed

  // Plain-language recommendation shown prominently.
  const recommendation = useMemo(() => {
    if (!coin) return { action: 'WAIT', detail: 'Select a coin.' }
    if (mode === 'wideScalp' && gatePassed && !wideScalpSizing?.nearEma) {
      return { action: 'WAIT — pullback filter', detail: 'Trend confirmed but price is more than 0.5% from the 15m 20 EMA. No breakout entries in Wide-Stop Scalp.' }
    }
    if (mode === 'vidya5m' && gatePassed && !vidyaReady) {
      return { action: 'WAIT — VIDYA 5m', detail: 'Multi-timeframe gate passed, but the 5m VIDYA trend/stop does not support this entry yet.' }
    }
    if (allPass && isLong) return { action: 'BUY / OPEN LONG', detail: `Enter near $${formatPrice(coin.price)}, take profit at TP1/TP2, stop below.` }
    if (allPass && !isLong) return { action: 'SELL / OPEN SHORT', detail: `Enter near $${formatPrice(coin.price)}, take profit at TP1/TP2, stop above.` }
    if (direction === 'LONG') return { action: 'HOLD — wait for confluence', detail: 'Bias is bullish but not all conditions align yet.' }
    if (direction === 'SHORT') return { action: 'HOLD — wait for confluence', detail: 'Bias is bearish but not all conditions align yet.' }
    return { action: 'NO TRADE', detail: 'Timeframes are mixed. Stay flat.' }
  }, [coin, allPass, isLong, direction, mode, gatePassed, wideScalpSizing, vidyaReady])

  const logDisabled =
    !coin ||
    direction === 'FLAT' ||
    (mode === 'wideScalp' && !wideScalpSizing) ||
    (mode === 'vidya5m' && (!vidyaSizing || vidyaSizing.invalid))

  function logSetup() {
    if (!coin || direction === 'FLAT') return
    if (mode === 'vidya5m') {
      if (!vidyaSizing || vidyaSizing.invalid) return
      addTrade({
        symbol: coin.symbol,
        side: isLong ? 'LONG' : 'SHORT',
        entry: vidyaSizing.entry,
        size: vidyaSizing.notional,
        stop: vidyaSizing.sl,
        target: vidyaSizing.tp3,
        strategy: 'vidya5m',
        atrAtEntry: vidyaSizing.atr5m,
        notes: `${coin.score}% score · VIDYA 5m · SL ${formatPrice(vidyaSizing.sl)} (${vidyaSizing.slDistancePct.toFixed(2)}%) · TP1 ${formatPrice(vidyaSizing.tp1)} / TP2 ${formatPrice(vidyaSizing.tp2)} / TP3 ${formatPrice(vidyaSizing.tp3)} · VIDYA ${vidyaSizing.vidya.direction} Δ${vidyaSizing.vidya.deltaPct.toFixed(0)}% · ${allPass ? 'all conditions passed' : 'manual'}`,
      })
    } else if (mode === 'wideScalp') {
      if (!wideScalpSizing) return
      addTrade({
        symbol: coin.symbol,
        side: isLong ? 'LONG' : 'SHORT',
        entry: wideScalpSizing.entry,
        size: wideScalpSizing.notional,
        stop: wideScalpSizing.sl,
        target: wideScalpSizing.tp2,
        strategy: 'wideScalp',
        atrAtEntry: wideScalpSizing.atrValue,
        notes: `${coin.score}% score · Wide-Stop Scalp · ${allPass ? 'all conditions passed' : 'manual'}`,
      })
    } else {
      if (!atrSizing) return
      addTrade({
        symbol: coin.symbol,
        side: isLong ? 'LONG' : 'SHORT',
        entry: atrSizing.entry,
        size: atrSizing.notional,
        stop: atrSizing.sl,
        target: atrSizing.tp1,
        strategy: 'default',
        notes: `${coin.score}% score · ${MODE_CONFIG[mode].label} · ${allPass ? 'all conditions passed' : 'manual'}`,
      })
    }
    setLogged(true)
    setTimeout(() => setLogged(false), 1800)
  }

  return (
    <aside className="border-border bg-sidebar flex h-full flex-col overflow-y-auto border-l">
      <div className="border-border flex items-center gap-2 border-b p-3">
        <Zap className="text-primary size-4" />
        <h2 className="text-sm font-semibold">AI + Bot Engine</h2>
      </div>

      {/* Signal score */}
      <div className="border-border flex items-center gap-4 border-b p-3">
        <Gauge score={coin?.score ?? 0} />
        <div className="space-y-1">
          <p className="text-muted-foreground text-[11px] uppercase tracking-wide">Direction</p>
          <p
            className={cn(
              'font-mono text-lg font-bold',
              direction === 'LONG' ? 'text-bull' : direction === 'SHORT' ? 'text-bear' : 'text-muted-foreground',
            )}
          >
            {direction}
          </p>
          <p className="text-muted-foreground font-mono text-xs">{coin?.symbol ?? '—'}</p>
        </div>
      </div>

      {/* Recommendation */}
      <div className="border-border border-b p-3">
        <p className="text-muted-foreground mb-1 text-[11px] font-semibold uppercase tracking-wide">Recommendation</p>
        <p
          className={cn(
            'font-mono text-sm font-bold',
            recommendation.action.startsWith('BUY')
              ? 'text-bull'
              : recommendation.action.startsWith('SELL')
                ? 'text-bear'
                : 'text-warn',
          )}
        >
          {recommendation.action}
        </p>
        <p className="text-muted-foreground mt-0.5 text-[11px] leading-relaxed">{recommendation.detail}</p>
      </div>

      {/* Mode selector */}
      <div className="border-border border-b p-3">
        <p className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wide">Strategy / Stop Mode</p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <button
            type="button"
            onClick={() => setMode('vidya5m')}
            className={cn(
              'col-span-2 rounded-md border py-1.5 text-center font-mono text-[10px] font-bold leading-tight sm:col-span-4',
              mode === 'vidya5m' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground',
            )}
          >
            <span className="block">VIDYA 5m</span>
            <span className="text-muted-foreground/70 block font-normal">SL on VIDYA band · TP 1.5R / 2R / 3R</span>
          </button>
          {(Object.keys(MODE_CONFIG) as AtrMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md border py-1.5 text-center font-mono text-[10px] font-bold leading-tight',
                mode === m ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground',
              )}
            >
              <span className="block capitalize">{m}</span>
              <span className="text-muted-foreground/70 block font-normal">ATR x{MODE_CONFIG[m].multiplier}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMode('wideScalp')}
            className={cn(
              'rounded-md border py-1.5 text-center font-mono text-[10px] font-bold leading-tight',
              mode === 'wideScalp' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground',
            )}
          >
            <span className="block">Wide-Stop</span>
            <span className="text-muted-foreground/70 block font-normal">3-candle SL</span>
          </button>
        </div>
      </div>

      {/* Position sizing */}
      <div className="border-border border-b p-3">
        <p className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wide">Trade Setup</p>
        <div className="mb-2 grid grid-cols-2 gap-2 text-xs">
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Account ($)</span>
            <input
              type="number"
              value={balance}
              min={0}
              onChange={(e) => setBalance(Math.max(0, Number(e.target.value)))}
              className="border-border bg-secondary/50 focus:ring-ring w-20 rounded-md border px-2 py-1 text-right font-mono outline-none focus:ring-2"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Leverage</span>
            <input
              type="number"
              value={leverage}
              min={1}
              max={125}
              onChange={(e) => setLeverage(Math.max(1, Number(e.target.value)))}
              className="border-border bg-secondary/50 focus:ring-ring w-20 rounded-md border px-2 py-1 text-right font-mono outline-none focus:ring-2"
            />
          </label>
        </div>

        {mode === 'vidya5m' ? (
          !coin ? (
            <p className="text-muted-foreground text-xs">Select a coin to size a trade.</p>
          ) : direction === 'FLAT' ? (
            <p className="text-muted-foreground text-xs">No directional bias — timeframes are mixed. Stay flat.</p>
          ) : !vidya5m ? (
            <p className="text-muted-foreground text-xs">{vidyaLoading ? 'Loading 5m candles…' : '5m VIDYA unavailable for this coin.'}</p>
          ) : vidyaSizing?.invalid ? (
            <div className="border-warn/30 bg-warn/5 flex items-start gap-1.5 rounded-md border p-2">
              <AlertTriangle className="text-warn mt-0.5 size-3.5 shrink-0" />
              <p className="text-warn text-[10px] leading-relaxed">
                The 5m VIDYA {isLong ? 'lower' : 'upper'} band is on the wrong side of price for a {direction} — the VIDYA
                trend is {vidya5m.vidya.direction}. No valid VIDYA stop; wait for the 5m trend to agree.
              </p>
            </div>
          ) : vidyaSizing ? (
            <>
              <dl className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                <Row label="Entry" value={`$${formatPrice(vidyaSizing.entry)}`} />
                <Row label="VIDYA 5m" value={`${vidyaSizing.vidya.direction} $${formatPrice(vidyaSizing.vidya.value)}`} tone={vidyaSizing.vidya.direction === 'UP' ? 'bull' : 'bear'} />
                <Row label={`VIDYA ${isLong ? 'lower' : 'upper'} band`} value={`$${formatPrice(vidyaSizing.band)}`} />
                <Row label="Stop Loss" value={`$${formatPrice(vidyaSizing.sl)}`} tone="bear" />
                <Row label="SL distance (1R)" value={`${vidyaSizing.slDistancePct.toFixed(2)}%`} />
                <Row label="Vol Δ since flip" value={`${vidyaSizing.vidya.deltaPct >= 0 ? '+' : ''}${vidyaSizing.vidya.deltaPct.toFixed(0)}%`} />
                <Row label={`TP1 (${VIDYA_TP_R[0]}R) → SL to entry`} value={`$${formatPrice(vidyaSizing.tp1)}`} tone="bull" />
                <Row label={`TP2 (${VIDYA_TP_R[1]}R) → SL to TP1`} value={`$${formatPrice(vidyaSizing.tp2)}`} tone="bull" />
                <Row label={`TP3 (${VIDYA_TP_R[2]}R) → close`} value={`$${formatPrice(vidyaSizing.tp3)}`} tone="bull" />
                <Row label="Risk (1%)" value={`$${formatPrice(vidyaSizing.risk)}`} />
                <Row label="Notional" value={`$${formatPrice(vidyaSizing.notional)}`} />
                <Row label="Qty" value={vidyaSizing.qty.toFixed(4)} />
                <Row label="Margin" value={`$${formatPrice(vidyaSizing.notional / leverage)}`} />
              </dl>
              <div className="border-warn/30 bg-warn/5 mt-2 rounded-md border p-2">
                <p className="text-muted-foreground flex items-center justify-between font-mono text-[11px]">
                  <span>Est. Liquidation ({leverage}x)</span>
                  <span className="text-warn font-semibold">${formatPrice(vidyaSizing.liqPrice)}</span>
                </p>
                {vidyaSizing.stopBeyondLiq ? (
                  <p className="text-bear mt-1 text-[10px] leading-relaxed">
                    The VIDYA stop is {vidyaSizing.slDistancePct.toFixed(2)}% away — too close to the ~{vidyaSizing.liqDistancePct.toFixed(1)}%
                    liquidation distance at {leverage}x. Lower the leverage or skip this trade.
                  </p>
                ) : null}
              </div>
              <p className="text-muted-foreground mt-2 text-[10px] leading-relaxed">
                Stop sits on the 5m VIDYA flip band (+0.1 x ATR buffer); targets scale with that stop distance. Once logged,
                the stop moves to entry at TP1, to TP1 at TP2, and the trade closes at TP3 — see Trade Journal.
              </p>
            </>
          ) : null
        ) : mode === 'wideScalp' ? (
          wideScalpSizing ? (
            <>
              <dl className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                <Row label="Entry" value={`$${formatPrice(wideScalpSizing.entry)}`} />
                <Row label="ATR (15m)" value={`$${formatPrice(wideScalpSizing.atrValue)}`} />
                <Row label={`SL (${wideScalpSizing.basisCount}-candle ${isLong ? 'low' : 'high'} -/+0.2%)`} value={`$${formatPrice(wideScalpSizing.sl)}`} tone="bear" />
                <Row label="Risk:Reward @ TP1" value={`1 : ${wideScalpSizing.impliedRR.toFixed(2)}`} />
                <Row label="TP1 (1x ATR, 50%)" value={`$${formatPrice(wideScalpSizing.tp1)}`} tone="bull" />
                <Row label="TP2 (1.5x ATR, 50%)" value={`$${formatPrice(wideScalpSizing.tp2)}`} tone="bull" />
                <Row label="Breakeven+ trigger" value={`$${formatPrice(wideScalpSizing.breakevenPlus)}`} />
                <Row label="Risk (1%)" value={`$${formatPrice(wideScalpSizing.risk)}`} />
                <Row label="Notional" value={`$${formatPrice(wideScalpSizing.notional)}`} />
                <Row label="Qty" value={wideScalpSizing.qty.toFixed(4)} />
                <Row label="Margin" value={`$${formatPrice(wideScalpSizing.notional / leverage)}`} />
                <Row label="Entry Filter (0.5% of EMA20)" value={wideScalpSizing.nearEma ? 'PASS' : 'FAIL'} tone={wideScalpSizing.nearEma ? 'bull' : 'bear'} />
              </dl>
              {!wideScalpSizing.nearEma ? (
                <div className="border-warn/30 bg-warn/5 mt-2 flex items-start gap-1.5 rounded-md border p-2">
                  <AlertTriangle className="text-warn mt-0.5 size-3.5 shrink-0" />
                  <p className="text-warn text-[10px] leading-relaxed">
                    Price is more than 0.5% from the 15m 20 EMA — this is a breakout, not a pullback. Wide-Stop Scalp
                    only logs pullback entries; wait for price to retrace closer to the EMA.
                  </p>
                </div>
              ) : null}
              <p className="text-muted-foreground mt-2 text-[10px] leading-relaxed">
                On log: 50% closes automatically at TP1 (1x ATR), stop moves to entry {isLong ? '+' : '-'}0.1%, and the
                remaining 50% rides to TP2 (1.5x ATR) — see Trade Journal for both legs once they fire.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              {coin ? 'Not enough 15m candle history yet for this coin.' : 'Select a coin to size a trade.'}
            </p>
          )
        ) : atrSizing ? (
          <>
            <dl className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
              <Row label="Entry" value={`$${formatPrice(atrSizing.entry)}`} />
              <Row label={`ATR (${MODE_CONFIG[mode].tf})`} value={atrSizing.atrValue > 0 ? `$${formatPrice(atrSizing.atrValue)}` : 'n/a'} />
              <Row label="ATR Multiplier" value={`x${atrSizing.multiplier}`} />
              <Row label="Risk (1%)" value={`$${formatPrice(atrSizing.risk)}`} />
              <Row label="Stop Loss" value={`$${formatPrice(atrSizing.sl)}`} tone="bear" />
              <Row label="Risk:Reward" value="1 : 1.5 / 2 / 3" />
              <Row label="TP1 (1:1.5)" value={`$${formatPrice(atrSizing.tp1)}`} tone="bull" />
              <Row label="TP2 (1:2)" value={`$${formatPrice(atrSizing.tp2)}`} tone="bull" />
              <Row label="TP3 (1:3)" value={`$${formatPrice(atrSizing.tp3)}`} tone="bull" />
              <Row label="Notional" value={`$${formatPrice(atrSizing.notional)}`} />
              <Row label="Qty" value={atrSizing.qty.toFixed(4)} />
              <Row label="Margin" value={`$${formatPrice(atrSizing.notional / leverage)}`} />
            </dl>
            <div className="border-warn/30 bg-warn/5 mt-2 rounded-md border p-2">
              <p className="text-muted-foreground flex items-center justify-between font-mono text-[11px]">
                <span>Est. Liquidation ({leverage}x)</span>
                <span className="text-warn font-semibold">${formatPrice(atrSizing.liqPrice)}</span>
              </p>
              <p className="text-muted-foreground mt-1 text-[10px] leading-relaxed">
                ~{atrSizing.liqDistancePct.toFixed(1)}% adverse move, isolated margin. Rough approximation only — excludes
                maintenance margin tiers and fees, so real liquidation happens a bit sooner than this.
              </p>
            </div>
            <p className="text-muted-foreground mt-2 text-[10px] leading-relaxed">
              Stop is trailed automatically once a trade is logged: moves to breakeven at +1R, then trails behind
              price by ATR x1.25 (1H) — see Trade Journal.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-xs">Select a coin to size a trade.</p>
        )}
      </div>

      {/* Conditions gate */}
      <div className="border-border border-b p-3">
        <p className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wide">Execution Gate</p>
        <ul className="space-y-1.5">
          {conditions.length > 0 ? (
            <>
              {conditions.map((c) => (
                <Condition key={c.label} label={c.label} passed={c.passed} />
              ))}
              {mode === 'wideScalp' ? <Condition label="Pullback filter (0.5% of 15m EMA20)" passed={Boolean(wideScalpSizing?.nearEma)} /> : null}
              {mode === 'vidya5m' ? (
                <>
                  <Condition
                    label={`VIDYA 5m trend = ${vidya5m ? vidya5m.vidya.direction : '…'}`}
                    passed={Boolean(vidyaSizing && vidyaSizing.trendMatches)}
                  />
                  <Condition label="VIDYA SL valid & inside liquidation" passed={vidyaReady} />
                </>
              ) : null}
            </>
          ) : (
            <li className="text-muted-foreground text-xs">Waiting for signal data…</li>
          )}
        </ul>
      </div>

      {/* Bot action */}
      <div className="p-3">
        <div
          className={cn(
            'rounded-md border p-3 text-center',
            allPass && isLong
              ? 'border-bull/40 bg-bull/10'
              : allPass && !isLong
                ? 'border-bear/40 bg-bear/10'
                : 'border-border bg-secondary/40',
          )}
        >
          <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">Bot Action</p>
          <p
            className={cn(
              'font-mono text-base font-bold',
              allPass && isLong ? 'text-bull' : allPass && !isLong ? 'text-bear' : 'text-muted-foreground',
            )}
          >
            {allPass ? `EXECUTE ${direction}` : 'STAND DOWN'}
          </p>
          <p className="text-muted-foreground font-mono text-xs">{coin ? `${coin.score}% confidence` : '—'}</p>
        </div>

        <button
          type="button"
          disabled={!allPass}
          className={cn(
            'mt-3 flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-semibold transition-colors',
            allPass
              ? isLong
                ? 'bg-bull text-bull-foreground hover:opacity-90'
                : 'bg-bear text-bear-foreground hover:opacity-90'
              : 'bg-secondary text-muted-foreground cursor-not-allowed',
          )}
        >
          <Zap className="size-4" />
          {allPass ? `Send ${direction} to Bot` : 'Conditions Not Met'}
        </button>

        <button
          type="button"
          onClick={logSetup}
          disabled={logDisabled}
          className={cn(
            'mt-2 flex w-full items-center justify-center gap-2 rounded-md border py-2 text-xs font-semibold transition-colors',
            logDisabled
              ? 'border-border text-muted-foreground cursor-not-allowed'
              : 'border-primary/40 text-primary hover:bg-primary/10',
          )}
        >
          <BookmarkPlus className="size-3.5" />
          {logged ? 'Logged to Journal ✓' : 'Log Setup to Journal'}
        </button>

        <p className="text-muted-foreground mt-2 flex items-center justify-center gap-1 text-center text-[10px]">
          <ShieldCheck className="size-3" />
          SAFE MODE — no live orders are placed
        </p>
      </div>
    </aside>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'bull' | 'bear' }) {
  return (
    <div className="bg-secondary/40 flex items-center justify-between rounded px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-semibold', tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-foreground')}>
        {value}
      </span>
    </div>
  )
}
