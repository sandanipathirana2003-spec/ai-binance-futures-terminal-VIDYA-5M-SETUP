// Shared rules for the "VIDYA 5m" trade plan: stop from the Volumatic VIDYA flip band,
// targets sized as multiples of that stop distance, and the stop ladder that follows the targets.

/** TP1 / TP2 / TP3 as multiples of the stop distance (R). */
export const VIDYA_TP_R = [1.5, 2, 3] as const

/** Extra room beyond the VIDYA band, in 5m ATRs, so a wick through the band doesn't tag the stop. */
export const VIDYA_SL_BUFFER_ATR = 0.1

/**
 * Stop ladder, driven by how far price has moved in our favour (in R):
 *  - reached TP1 (1.5R): stop -> entry (breakeven)
 *  - reached TP2 (2R):   stop -> TP1 (locks +1.5R)
 * Returns null while no ladder step has been reached. The trade closes at TP3 (3R).
 */
export function vidyaLadderStop(side: 'LONG' | 'SHORT', entry: number, oneR: number, favorableMove: number): number | null {
  if (oneR <= 0) return null
  const dir = side === 'LONG' ? 1 : -1
  if (favorableMove >= oneR * VIDYA_TP_R[1]) return entry + dir * oneR * VIDYA_TP_R[0]
  if (favorableMove >= oneR * VIDYA_TP_R[0]) return entry
  return null
}
