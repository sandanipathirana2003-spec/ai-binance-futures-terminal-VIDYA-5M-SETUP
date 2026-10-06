# VIDYA 5m stop-loss, TP ladder, trade-log export, MTF Setup tab

- **VIDYA 5m mode (Bot panel, default):** SL = 5m Volumatic VIDYA flip band (lower for longs, upper for shorts) + 0.1 x ATR(5m). TP1/TP2/TP3 = 1.5R / 2R / 3R of that SL distance. Native 5m candles come from the new `/api/vidya` route (`hooks/use-vidya-5m.ts`). Gate adds "VIDYA 5m trend agrees" and "SL valid & inside liquidation".
- **Stop follows the targets** (`lib/vidya-plan.ts`, `hooks/use-trades.ts`): TP1 hit -> SL to entry, TP2 hit -> SL to TP1, close at TP3. Logged with strategy `vidya5m`; the note stores SL/TP1/TP2/TP3 and VIDYA state.
- **Trade log:** "Log Setup to Journal" saves the VIDYA plan; the Trade Journal has a new "Export trade log (CSV)" button.
- **MTF Setup tab** (`lib/mtf-setup.ts`, `/api/setup`, `components/terminal/setup-panel.tsx`): 1H trend -> 15M confirmation -> 5M entry with EMA 9/21 + VIDYA. States BUY SETUP / SELL SETUP / WAIT / NO TRADE, closed candles only. All thresholds are constants at the top of `lib/mtf-setup.ts`.
- `lib/indicators.ts`: `vidyaLine()` extracted from `vidya()` (no behaviour change).

---

# Supertrend replaced by Volumatic VIDYA + MA Cross (9/21/50/200)

- `lib/indicators.ts`: `supertrend()` removed. New `vidya()` (CMO-adaptive VIDYA 10/20, SMA-15 smoothing, ATR(200) x 2 flip bands, buy/sell volume + delta % per trend leg) and `maCross()` (EMA 9/21/50/200, state + candles-since-cross for 9/21, 21/50, 50/200).
- `lib/signals.ts`: bucket vote = VIDYA direction + at least 2 of 3 confirmations (RSI, MACD, MA cross alignment; `MIN_CONFIRMATIONS`). Score budget stays 100: VIDYA maturity 10 + MA cross alignment 5 (was Supertrend maturity 15).
- Types/UI: `supertrend` field replaced by `vidya` and `maCross` on CoinSignal/BtcTrend; sidebar shows VIDYA, MA Cross and VIDYA volume delta; coin header shows VIDYA and MA Cross chips.
- The 1H confluence gate (EMA200, EMA stack, SMA50/200, MACD, Ribbon) is unchanged.

---

# What was actually wrong, and what changed

## Root causes found
1. **Not using Binance at all.** `/api/market` was pulling from CoinGecko (spot market, top 100 by market cap), not Binance Futures.
2. **No real Supertrend.** The "Supertrend" was actually EMA+RSI+slope voting on fake mini price windows — never an ATR-based Supertrend. That's why it looked frozen: it wasn't a real indicator to begin with.
3. **Fake timeframes.** CoinGecko only gives 7-day hourly data, but the code sliced it into tiny windows and labeled them "1M/3M/5M" as if they were 1-minute candles. Completely mislabeled.
4. **Silent fake data fallback.** If CoinGecko failed or rate-limited, the app quietly generated randomized synthetic prices and displayed them as if real (`live:false` flag existed but wasn't obvious in the UI).
5. **Broken repo structure** (in the *other* repo you first sent me) — files were flat when imports expected `app/`, `lib/`, `components/` folders. That repo would fail to build from a fresh clone.
6. **No trade-freeze / auto SL-TP.** This specific repo (`new-project-my`) didn't have the auto-close-on-SL/TP feature yet — I ported it over from your other repo, where it did already work correctly.

## What's fixed now
- **Real Binance USDT-M Futures data**: `lib/binance.ts` pulls the full list of live PERPETUAL/USDT contracts (250-300+, exceeds your "100+" ask) plus real 1H candles.
- **Real ATR-based Supertrend**: `lib/indicators.ts` implements the actual algorithm (period 10, multiplier 3) with proper band-flip logic — verified with a runtime test that it correctly flips direction when price action actually reverses.
- **Honest timeframes**: relabeled to `4H / 12H / 1D / 2D`, built by resampling real 1H candles (not fake slices).
- **No more fake data**: if Binance is unreachable, the UI now says so explicitly ("DATA UNAVAILABLE") instead of quietly showing synthetic numbers.
- **Trade freeze + live PnL**: entry/stop/target lock the moment you log a trade; only price and P&L update live every 15s (unchanged behavior, now fed by real Binance prices).
- **Rate-limit safe**: signal/Supertrend recompute is cached for 3 minutes (klines are heavy); price ticks refresh every 15s via one cheap bulk endpoint.
- **PWA / mobile install**: added `manifest.json`, a minimal service worker, and app icons so you can "Add to Home Screen" on iOS/Android and it opens like a native app.

## Honest limitation
"Accurate signals only" isn't something any system can promise — I tightened the confluence logic (Supertrend + RSI + MACD must agree, and 3-of-4 timeframes must align) so it should throw fewer, higher-quality signals, but losses will still happen. Treat the score as a filter, not a guarantee.
