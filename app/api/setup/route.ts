import { NextResponse } from 'next/server'
import { fetchKlines } from '@/lib/binance'
import { analyzeSetup } from '@/lib/mtf-setup'

// Edge runtime for the same reason as /api/market (Binance blocks US serverless regions).
export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get('symbol') ?? '').toUpperCase()
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return NextResponse.json({ error: 'invalid symbol' }, { status: 400 })
  try {
    const [h1, m15, m5] = await Promise.all([fetchKlines(symbol, '1h', 300), fetchKlines(symbol, '15m', 300), fetchKlines(symbol, '5m', 1000)])
    const analysis = analyzeSetup(h1, m15, m5, Date.now())
    if (!analysis) return NextResponse.json({ error: 'not enough candle history' }, { status: 422 })
    return NextResponse.json({ symbol, analysis, updatedAt: Date.now() })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 502 })
  }
}
