'use client'

import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPrice } from '@/lib/format'
import { useSetup } from '@/hooks/use-setup'
import type { CoinSignal } from '@/lib/types'
import type { SetupState, TfMa } from '@/lib/mtf-setup'

const STATE_STYLE: Record<SetupState, string> = {
  'BUY SETUP': 'border-bull/50 bg-bull/10 text-bull',
  'SELL SETUP': 'border-bear/50 bg-bear/10 text-bear',
  WAIT: 'border-warn/50 bg-warn/10 text-warn',
  'NO TRADE': 'border-border bg-secondary/40 text-muted-foreground',
}

function TfCard({ label, role, ma }: { label: string; role: string; ma: TfMa }) {
  const bull = ma.bias === 'BULLISH'
  return (
    <div className="border-border bg-sidebar rounded-lg border p-3">
      <p className="text-muted-foreground font-mono text-[10px] uppercase">
        {label} · {role}
      </p>
      <p className={cn('mt-1 font-mono text-lg font-bold', bull ? 'text-bull' : 'text-bear')}>{ma.bias}</p>
      <p className="text-muted-foreground font-mono text-[11px]">
        EMA9 {formatPrice(ma.fast)} {bull ? '>' : '<'} EMA21 {formatPrice(ma.slow)}
      </p>
      <p className="text-muted-foreground font-mono text-[11px]">
        {ma.barsSinceCross >= 0 ? `crossed ${ma.barsSinceCross} candle(s) ago` : 'no cross in window'}
      </p>
    </div>
  )
}

export function SetupPanel({ coins, selected, onSelect }: { coins: CoinSignal[]; selected: string; onSelect: (s: string) => void }) {
  const { data, isLoading, isError } = useSetup(selected)
  const a = data?.analysis

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Multi-Timeframe Setup · MA 9/21 + Volumatic VIDYA</h2>
          <p className="text-muted-foreground text-[11px]">1H = trend · 15M = confirmation · 5M = entry. Signals use closed candles only.</p>
        </div>
        <select
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          className="border-border bg-secondary/50 rounded-md border px-2 py-1.5 font-mono text-xs"
        >
          {(coins.some((c) => c.symbol === selected) ? coins : [{ symbol: selected } as CoinSignal, ...coins]).map((c) => (
            <option key={c.symbol} value={c.symbol}>
              {c.symbol}
            </option>
          ))}
        </select>
      </div>

      {!a ? (
        <p className="text-muted-foreground p-8 text-center font-mono text-sm">
          {isError ? 'Could not load candles for this symbol — retrying…' : isLoading ? 'Loading 1H / 15M / 5M candles…' : 'No data.'}
        </p>
      ) : (
        <>
          <div className={cn('rounded-lg border p-4 text-center', STATE_STYLE[a.state])}>
            <p className="font-mono text-3xl font-bold tracking-wide">{a.state}</p>
            <p className="mt-1 text-xs opacity-90">{a.headline}</p>
            {a.reasons.map((r) => (
              <p key={r} className="mt-1 text-[11px] opacity-80">
                {r}
              </p>
            ))}
            <p className="mt-2 font-mono text-[10px] opacity-70">
              {data.symbol} ${formatPrice(a.price)} · next 5M close in {Math.floor(a.candle.formingClosesInSec / 60)}:
              {String(a.candle.formingClosesInSec % 60).padStart(2, '0')}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TfCard label="1H" role="overall trend" ma={a.h1} />
            <TfCard label="15M" role="confirmation" ma={a.m15} />
            <TfCard label="5M" role="entry" ma={a.m5} />
          </div>

          <div className="border-border bg-sidebar rounded-lg border p-3">
            <p className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wide">
              Volumatic VIDYA (5M) ·{' '}
              <span className={a.vidya.direction === 'UP' ? 'text-bull' : 'text-bear'}>{a.vidya.direction}</span> ·{' '}
              <span className="text-foreground">{a.vidya.strength}</span>
            </p>
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {a.checks.map((c) => (
                <li key={c.label} className="bg-secondary/40 flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs">
                  <span>
                    <span className="block">{c.label}</span>
                    <span className="text-muted-foreground block font-mono text-[10px]">{c.detail}</span>
                  </span>
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold',
                      c.passed ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear',
                    )}
                  >
                    {c.passed ? <Check className="size-3" /> : <X className="size-3" />}
                    {c.passed ? 'OK' : 'NO'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
