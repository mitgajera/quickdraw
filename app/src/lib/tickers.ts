"use client";

// Latest oracle price for every market (one rollup read every 2 seconds) and its one-minute change,
// for the market tabs.
import { useEffect, useState } from "react";
import { decodeOracle, marketKeys, type Symbol } from "@quickdraw/sdk";
import { er } from "./chain";

export interface Ticker { price: number; change: number | null }
const SYMBOLS: Symbol[] = ["SOL", "BTC", "ETH"];

export function useTickers(): Partial<Record<Symbol, Ticker>> {
  const [tickers, setTickers] = useState<Partial<Record<Symbol, Ticker>>>({});
  useEffect(() => {
    const history: Record<string, { t: number; p: number }[]> = {};
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      const infos = await er.getMultipleAccountsInfo(SYMBOLS.map((s) => marketKeys(s).oracle)).catch(() => null);
      if (!infos || stopped) return;
      const now = Date.now() / 1000, next: Partial<Record<Symbol, Ticker>> = {};
      SYMBOLS.forEach((s, i) => {
        const info = infos[i];
        if (!info) return;
        const p = Number(decodeOracle(info.data).price) / 1e8;
        const h = (history[s] ??= []);
        h.push({ t: now, p });
        while (h.length > 2 && h[0]!.t < now - 70) h.shift();
        const old = h.find((x) => x.t >= now - 60);
        next[s] = { price: p, change: old && now - h[0]!.t > 20 ? ((p - old.p) / old.p) * 100 : null };
      });
      setTickers(next);
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => { stopped = true; clearInterval(id); };
  }, []);
  return tickers;
}
