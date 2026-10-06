'use client'

import useSWR from 'swr'
import type { Vidya5mResponse } from '@/lib/types'

const fetcher = async (url: string): Promise<Vidya5mResponse> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load 5m VIDYA')
  return res.json()
}

/** Native 5m Volumatic VIDYA (bands, trend, volume delta) for the selected symbol — refreshed every 30s. */
export function useVidya5m(symbol?: string) {
  const { data, error, isLoading } = useSWR<Vidya5mResponse>(symbol ? `/api/vidya?symbol=${symbol}` : null, fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: false,
    keepPreviousData: false,
  })
  return { data, isLoading, isError: Boolean(error) }
}
