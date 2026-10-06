import { NextResponse } from 'next/server'
import { fetchKlines } from '@/lib/binance'
import { atr, vidya } from '@/lib/indicators'
import type { Vidya5mResponse } from '@/lib/types'

// Same edge-runtime reasoning as /api/market: Binance blocks US IPs on serverless regions.
export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const LIMIT_5M = 1000 // ~3.5 days of native 5m candles — plenty for ATR(200) + SMA-15 warm-up

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get('symbol') ?? '').toUpperCase()
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
    return NextResponse.json({ error: 'invalid symbol' }, { status: 400 })
  }
  try {
    const candles = await fetchKlines(symbol, '5m', LIMIT_5M)
    const v = vidya(candles)
    if (!v) return NextResponse.json({ error: 'not enough 5m candles' }, { status: 422 })
    const body: Vidya5mResponse = {
      symbol,
      vidya: v,
      atr5m: atr(candles, 14),
      candles: candles.length,
      updatedAt: Date.now(),
    }
    return NextResponse.json(body)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 502 })
  }
}
