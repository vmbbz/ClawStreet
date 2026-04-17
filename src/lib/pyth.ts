/**
 * Pyth Network integration for ClawStreet
 *
 * Uses the free Hermes REST API (no API key required):
 *   - fetchPythPrice()  — current price for UI display
 *   - fetchPythVAA()    — binary price update for on-chain txns (acceptLoan, etc.)
 *   - fetchPythHistory()— 30-day OHLC for charts (replaces random-walk)
 *   - usePythPrice()    — React hook, auto-refreshes every 30s
 */

const HERMES = 'https://hermes.pyth.network/v2/updates/price/latest';
const BENCHMARKS = 'https://benchmarks.pyth.network/v1/shims/tradingview/history';

export interface PythPrice {
  price: number;
  conf: number;
  publishTime: number;
  feedId: string;
}

export interface PythCandle {
  date: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ─── Core Fetchers ───────────────────────────────────────────────────────────

/**
 * Fetch the latest price for one or more Pyth feed IDs.
 * Returns parsed, human-readable price values.
 */
export async function fetchPythPrice(feedId: string): Promise<PythPrice> {
  const res = await fetch(`${HERMES}?ids[]=${feedId}`);
  if (!res.ok) throw new Error(`Pyth Hermes error: ${res.status}`);
  const data = await res.json();
  const parsed = data.parsed?.[0];
  if (!parsed) throw new Error('No Pyth price data returned');

  const priceData = parsed.price;
  const expo = priceData.expo as number;
  const multiplier = Math.pow(10, expo);

  return {
    price: Number(priceData.price) * multiplier,
    conf: Number(priceData.conf) * multiplier,
    publishTime: priceData.publish_time,
    feedId,
  };
}

/**
 * Fetch binary VAA (price update data) for on-chain submissions.
 * Pass result directly to acceptLoan(id, priceUpdateData) or similar.
 */
export async function fetchPythVAA(feedIds: string[]): Promise<`0x${string}`[]> {
  const params = feedIds.map(id => `ids[]=${id}`).join('&');
  const res = await fetch(`${HERMES}?${params}&encoding=hex`);
  if (!res.ok) throw new Error(`Pyth VAA fetch error: ${res.status}`);
  const data = await res.json();
  return (data.binary?.data ?? []).map((d: string) => `0x${d}` as `0x${string}`);
}

/**
 * Fetch 30-day daily OHLC from Pyth Benchmarks.
 * Used for real chart data in LoanDetails / OptionDetails.
 */
export async function fetchPythHistory(
  feedId: string,
  days = 30
): Promise<PythCandle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;

  // Benchmarks uses ticker symbols — map feed ID to symbol
  const symbolMap: Record<string, string> = {
    '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace': 'Crypto.ETH/USD',
    '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43': 'Crypto.BTC/USD',
    '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221': 'Crypto.LINK/USD',
  };

  const symbol = symbolMap[feedId.toLowerCase()];
  if (!symbol) return [];

  try {
    const url = `${BENCHMARKS}?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${now}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();

    if (!data.t || !data.c) return [];

    return data.t.map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      timestamp: ts,
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
    }));
  } catch {
    return [];
  }
}

// ─── React Hook ───────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';

export function usePythPrice(feedId: string | null): {
  price: number | null;
  conf: number | null;
  publishTime: number | null;
  loading: boolean;
  error: string | null;
} {
  const [price, setPrice] = useState<number | null>(null);
  const [conf, setConf] = useState<number | null>(null);
  const [publishTime, setPublishTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!feedId) return;

    let cancelled = false;

    const fetch_ = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchPythPrice(feedId);
        if (!cancelled) {
          setPrice(result.price);
          setConf(result.conf);
          setPublishTime(result.publishTime);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Pyth fetch failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetch_();
    const interval = setInterval(fetch_, 30_000); // refresh every 30s

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [feedId]);

  return { price, conf, publishTime, loading, error };
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatPrice(price: number, decimals = 2): string {
  if (price >= 10_000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return price.toPrecision(4);
}

export function formatPriceUSD(price: number): string {
  return '$' + formatPrice(price);
}
