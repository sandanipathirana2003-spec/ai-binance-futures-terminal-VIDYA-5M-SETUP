'use client'

import useSWR from 'swr'
import type { SetupAnalysis } from '@/lib/mtf-setup'

export interface SetupResponse {
  symbol: string
  analysis: SetupAnalysis
  updatedAt: number
}

const fetcher = async (url: string): Promise<SetupResponse> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load setup')
  return res.json()
}

/** Multi-timeframe setup state for one symbol, refreshed every 10s (5M candle closes are picked up within seconds). */
export function useSetup(symbol?: string) {
  const { data, error, isLoading } = useSWR<SetupResponse>(symbol ? `/api/setup?symbol=${symbol}` : null, fetcher, {
    refreshInterval: 10000,
    revalidateOnFocus: false,
  })
  return { data, isLoading, isError: Boolean(error) }
}
