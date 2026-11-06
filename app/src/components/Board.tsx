"use client";

import { useEffect, useRef } from "react";
import { boxAt, quoteBox, sigmaFor } from "@quickdraw/sdk";
import type { LiveModel, Result } from "@/lib/live";

interface Tokens { bg: string; board: string; ink: string; mute: string; accent: string; price: string; win: string; loss: string }

const readTokens = (): Tokens => {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(`--${n}`).trim() || "#888888";
  return { bg: v("bg"), board: v("board"), ink: v("ink"), mute: v("mute"), accent: v("accent"), price: v("price"), win: v("win"), loss: v("loss") };
};
const hexRgb = (h: string) => { const x = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
const rgba = (h: string, a: number) => { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; };
const mix = (a: string, b: string, t: number) => { const A = hexRgb(a), B = hexRgb(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i]! - v) * t)).join(",")})`; };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
const fmtMult = (bps: number) => { const m = bps / 1e4; return `${m < 10 ? m.toFixed(1) : Math.round(m)}x`; };
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0) / 4294967295; };

interface Props {
  model: LiveModel;
  stake: number;
  canTap: boolean;
  onTap: (bandIndex: bigint, column: number, multBps: number) => void;
}

export function Board({ model, stake, canTap, onTap }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const props = useRef({ stake, canTap, onTap });
  props.current = { stake, canTap, onTap };

  useEffect(() => {
    const cvs = canvas.current!;
    const ctx = cvs.getContext("2d")!;
    let T = readTokens();
    let W = 0, H = 0;
    const resize = () => {
      const r = cvs.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
      W = r.width; H = r.height; cvs.width = W * dpr; cvs.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize); ro.observe(cvs); resize();
    const themeTimer = setInterval(() => { T = readTokens(); }, 500);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    let camP = 0, headP = 0, hover: { k: number; j: number } | null = null;
    const parts: { x: number; y: number; vx: number; vy: number; life: number; r: number; vr: number; c: string }[] = [];
    const floats: { x: number; y: number; txt: string; age: number }[] = [];
    const ripples: { k: number; j: number; age: number }[] = [];

    // layout (recomputed every frame)
    let L = { rt: 0, nowX: 0, colPx: 0, rowPx: 0, pps: 0, band: 1, col: 4, AX: 0 };
    const xOf = (t: number) => L.nowX + (t - L.rt) * L.pps;
    const yOf = (p: number) => H / 2 - ((p - camP) / L.band) * L.rowPx;
    const pOfY = (y: number) => camP + ((H / 2 - y) / L.rowPx) * L.band;

    const cellAt = (x: number, y: number) => {
      if (x <= L.nowX || x > L.AX) return null;
      const t = L.rt + (x - L.nowX) / L.pps;
      return { k: Math.floor(t / L.col), j: Math.floor(pOfY(y) / L.band) };
    };
    const quoteAt = (k: number, j: number) => {
      const { market, book, price, publishTime, candles } = model;
      if (!market || !book || price === null) return null;
      return quoteBox(book, boxAt(market, BigInt(j), k), price, publishTime, sigmaFor(market, candles, publishTime));
    };

    const offResult = model.onResult((r: Result) => {
      if (r.outcome !== "win") return;
      const k = r.tap.start / L.col, j = Number(r.tap.lo / BigInt(Math.round(L.band * 1e8)));
      const x = xOf(k * L.col) + L.colPx / 2, y = yOf((j + 1) * L.band) + L.rowPx / 2;
      floats.push({ x, y, txt: "+" + money(Number(r.payout) / 1e6), age: 0 });
      if (navigator.vibrate) navigator.vibrate(30);
      if (reduced) return;
      for (let i = 0; i < 34; i++) {
        const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 220;
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 90, life: 1 + Math.random() * 0.4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 12, c: i % 2 ? T.accent : T.win });
      }
    });

    const onMove = (e: PointerEvent) => { const r = cvs.getBoundingClientRect(); hover = cellAt(e.clientX - r.left, e.clientY - r.top); };
    const onLeave = () => { hover = null; };
    const onDown = (e: PointerEvent) => {
      const r = cvs.getBoundingClientRect(), c = cellAt(e.clientX - r.left, e.clientY - r.top);
      if (!c || !props.current.canTap) return;
      const q = quoteAt(c.k, c.j);
      if (!q?.ok) return;
      ripples.push({ k: c.k, j: c.j, age: 0 });
      props.current.onTap(BigInt(c.j), c.k, q.multBps);
    };
    cvs.addEventListener("pointermove", onMove);
    cvs.addEventListener("pointerleave", onLeave);
    cvs.addEventListener("pointerdown", onDown);

    const drawBlock = (x: number, y: number, w: number, h: number, fill: string, text: string, textColor: string, alpha = 1) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill; ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
      ctx.fillStyle = textColor; ctx.font = `600 12px ${monoFont}`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
      ctx.globalAlpha = 1;
    };

    const mono = () => getComputedStyle(document.body).getPropertyValue("--font-mono").split(",")[0] || "monospace";
    let monoFont = mono();
    const fontTimer = setInterval(() => { monoFont = mono(); }, 2000);

    let last = performance.now(), raf = 0;
    const frame = (nowMs: number) => {
      const dt = Math.min(0.1, (nowMs - last) / 1000); last = nowMs;
      raf = requestAnimationFrame(frame);
      if (!W) return;
      const { market, book, price, hist } = model;
      ctx.fillStyle = T.board; ctx.fillRect(0, 0, W, H);
      if (!market || !book || price === null || hist.length === 0) {
        ctx.fillStyle = T.mute; ctx.font = `500 13px ${monoFont}`; ctx.textAlign = "center";
        ctx.fillText(model.erOk ? "Connecting to the rollup…" : "Rollup unreachable — retrying", W / 2, H / 2);
        return;
      }

      const band = Number(market.band) / 1e8, col = market.colSecs;
      const rt = Date.now() / 1000 - model.clockOffset;
      const nowX = W * (W < 600 ? 0.24 : 0.3), AX = W - 52;
      const colPx = clamp((AX - nowX) / 5, 70, 150), rowPx = clamp(H / 11, 36, 54);
      L = { rt, nowX, colPx, rowPx, pps: colPx / col, band, col, AX };
      const latest = Number(price) / 1e8;
      if (!camP) { camP = latest; headP = latest; }
      headP += (latest - headP) * Math.min(1, dt * 10);
      camP += (headP - camP) * Math.min(1, dt * 1.6);

      const jMin = Math.floor(pOfY(H) / band) - 1, jMax = Math.floor(pOfY(0) / band) + 1;
      const kNow = Math.floor(rt / col), kMax = Math.ceil((rt + (AX - nowX) / L.pps) / col);
      const kMin = Math.floor((rt - nowX / L.pps) / col);

      // grid
      ctx.lineWidth = 1; ctx.strokeStyle = rgba(T.ink, 0.06);
      for (let j = jMin; j <= jMax; j++) { const y = Math.round(yOf(j * band)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(AX, y); ctx.stroke(); }
      for (let k = kMin; k <= kMax + 1; k++) { const x = Math.round(xOf(k * col)) + 0.5; if (x > AX) break; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }

      // future cells with live on-chain odds
      const sigma = sigmaFor(market, model.candles, model.publishTime);
      ctx.save(); ctx.beginPath(); ctx.rect(nowX, 0, AX - nowX, H); ctx.clip();
      const heat = new Map<string, number>();
      for (const o of model.others) for (const t of o.taps) {
        const key = `${t.start / col}:${Number(t.lo / market.band)}`; heat.set(key, (heat.get(key) ?? 0) + 1);
      }
      const fs = clamp(rowPx * 0.3, 11, 14);
      ctx.font = `500 ${fs}px ${monoFont}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let k = kNow; k <= kMax; k++) {
        const x0 = Math.max(xOf(k * col), nowX), x1 = xOf((k + 1) * col);
        if (x1 <= nowX) continue;
        for (let j = jMin; j <= jMax; j++) {
          const y0 = yOf((j + 1) * band), y1 = yOf(j * band), w = x1 - x0, h = y1 - y0;
          const q = quoteBox(book, boxAt(market, BigInt(j), k), price, model.publishTime, sigma);
          const n = heat.get(`${k}:${j}`) ?? 0;
          if (n) { ctx.fillStyle = rgba(T.accent, Math.min(0.16, n * 0.04)); ctx.fillRect(x0, y0, w, h); }
          if (!q.ok) {
            if (q.reason === "locked") { ctx.fillStyle = rgba(T.ink, 0.025); ctx.fillRect(x0, y0, w, h); }
            ctx.fillStyle = rgba(T.mute, 0.35); ctx.beginPath(); ctx.arc(x0 + w / 2, y0 + h / 2, 1.5, 0, Math.PI * 2); ctx.fill();
            continue;
          }
          const isHover = hover && hover.k === k && hover.j === j;
          if (isHover) {
            ctx.fillStyle = rgba(T.accent, 0.14); ctx.fillRect(x0, y0, w, h);
            ctx.strokeStyle = T.accent; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 0.75, y0 + 0.75, w - 1.5, h - 1.5);
          }
          const t = clamp(Math.log(q.multBps / 11_000) / Math.log(250_000 / 11_000), 0, 1);
          ctx.fillStyle = mix(T.mute, T.accent, t);
          ctx.fillText(fmtMult(q.multBps), x0 + w / 2, y0 + h / 2 + 0.5);
        }
      }
      ctx.restore();

      // past shading
      ctx.fillStyle = rgba(T.ink, 0.018); ctx.fillRect(0, 0, nowX, H);

      // bets: mine (open, pending, settled) and everyone else's
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, AX, H); ctx.clip();
      const cellRect = (start: number, lo: bigint) => {
        const j = Number(lo / market.band);
        return { x: xOf(start), y: yOf((j + 1) * band), w: colPx, h: rowPx };
      };
      for (const r of model.results) {
        const c = cellRect(r.tap.start, r.tap.lo);
        if (c.x + c.w < 0) continue;
        if (r.outcome === "win") drawBlock(c.x, c.y, c.w, c.h, T.win, "+" + money(Number(r.payout) / 1e6), T.bg);
        else if (r.outcome === "lose") drawBlock(c.x, c.y, c.w, c.h, rgba(T.loss, 0.16), money(-Number(r.tap.stake) / 1e6), T.loss, clamp(1 - (Date.now() / 1000 - r.at) / 3, 0.25, 1));
        else drawBlock(c.x, c.y, c.w, c.h, rgba(T.ink, 0.08), "refund", T.mute);
      }
      for (const t of model.player?.taps ?? []) {
        if (!t.open || !t.market.equals(model.keys.market)) continue;
        const c = cellRect(t.start, t.lo);
        drawBlock(c.x, c.y, c.w, c.h, T.accent, `${money(Number(t.stake) / 1e6)} · ${fmtMult(t.multBps)}`, T.bg);
      }
      for (const p of model.pending) {
        const c = cellRect(p.column * col, p.bandIndex * market.band);
        drawBlock(c.x, c.y, c.w, c.h, rgba(T.accent, 0.45), `${money(Number(p.stake) / 1e6)} · ${fmtMult(p.multBps)}`, T.bg, 0.6 + 0.3 * Math.sin(nowMs / 120));
      }
      for (const o of model.others) {
        const h = hash(o.owner.toBase58());
        for (const t of o.taps) {
          const c = cellRect(t.start, t.lo);
          ctx.fillStyle = [T.accent, T.win, T.ink, T.mute][Math.floor(h * 4)]!;
          ctx.globalAlpha = 0.85;
          ctx.beginPath(); ctx.arc(c.x + 8 + h * (c.w - 16), c.y + 7 + ((h * 7) % 1) * (c.h - 14), 3.2, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();

      // price line: oracle updates arrive as steps, so filter them in time (EMA, tau 0.35s) and
      // draw a Catmull-Rom curve through the result, ending at the eased head
      const pts = hist.filter((h) => xOf(h.t) > -40);
      if (pts.length > 1) {
        const path: [number, number][] = [];
        let s = pts[0]!.p, prevT = pts[0]!.t;
        for (const h of pts) {
          s += (h.p - s) * (1 - Math.exp(-(h.t - prevT) / 0.35));
          prevT = h.t;
          path.push([xOf(h.t), yOf(s)]);
        }
        // the head continues the same filter up to "now", so the dot sits on the curve
        headP = s + (latest - s) * (1 - Math.exp(-Math.max(0, rt - prevT) / 0.35));
        path.push([nowX, yOf(headP)]);
        const trace = () => {
          ctx.beginPath(); ctx.moveTo(path[0]![0], path[0]![1]);
          for (let i = 0; i < path.length - 1; i++) {
            const p0 = path[Math.max(0, i - 1)]!, p1 = path[i]!, p2 = path[i + 1]!, p3 = path[Math.min(path.length - 1, i + 2)]!;
            ctx.bezierCurveTo(
              p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
              p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
              p2[0], p2[1],
            );
          }
        };
        const g = ctx.createLinearGradient(0, 0, 0, H);
        // a dark price colour (light theme) needs a much lighter fill to stay subtle
        const lum = hexRgb(T.price).reduce((a, v) => a + v, 0) / 765;
        g.addColorStop(0, rgba(T.price, lum < 0.4 ? 0.05 : 0.14)); g.addColorStop(1, rgba(T.price, 0));
        trace(); ctx.lineTo(nowX, H); ctx.lineTo(path[0]![0], H); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
        trace(); ctx.strokeStyle = T.price; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      }
      const hy = yOf(headP);
      ctx.strokeStyle = rgba(T.ink, 0.35); ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(nowX + 0.5, 0); ctx.lineTo(nowX + 0.5, H); ctx.stroke();
      ctx.strokeStyle = rgba(T.price, 0.5); ctx.beginPath(); ctx.moveTo(nowX, hy); ctx.lineTo(AX, hy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = rgba(T.price, 0.2); ctx.beginPath(); ctx.arc(nowX, hy, reduced ? 9 : 9 + Math.sin(nowMs / 200) * 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = T.price; ctx.beginPath(); ctx.arc(nowX, hy, 4, 0, Math.PI * 2); ctx.fill();

      // price axis + tag
      ctx.fillStyle = T.board; ctx.fillRect(AX, 0, W - AX, H);
      ctx.strokeStyle = rgba(T.ink, 0.08); ctx.beginPath(); ctx.moveTo(AX + 0.5, 0); ctx.lineTo(AX + 0.5, H); ctx.stroke();
      const decimals = band >= 1 ? 0 : 2;
      ctx.font = `500 10.5px ${monoFont}`; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = T.mute;
      for (let j = jMin; j <= jMax; j += 2) ctx.fillText((j * band).toFixed(decimals), AX + 5, yOf(j * band));
      const tagH = 20, ty = clamp(hy - tagH / 2, 2, H - tagH - 2);
      ctx.fillStyle = T.price; ctx.fillRect(AX + 1, ty, W - AX - 2, tagH);
      ctx.fillStyle = T.bg; ctx.font = `600 10.5px ${monoFont}`;
      ctx.fillText(latest.toFixed(decimals), AX + 5, ty + tagH / 2 + 0.5);

      // column countdowns
      ctx.fillStyle = T.board; ctx.fillRect(nowX + 1, 0, AX - nowX - 1, 22);
      ctx.strokeStyle = rgba(T.ink, 0.08); ctx.beginPath(); ctx.moveTo(nowX, 22.5); ctx.lineTo(AX, 22.5); ctx.stroke();
      ctx.font = `500 10px ${monoFont}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (let k = kNow; k <= kMax; k++) {
        const x0 = Math.max(xOf(k * col), nowX), x1 = Math.min(xOf((k + 1) * col), AX);
        if (x1 - x0 < 30) continue;
        const lead = k * col - rt;
        ctx.fillStyle = lead <= 0 ? T.accent : T.mute;
        ctx.fillText(lead <= 0 ? "LIVE" : `${Math.ceil(lead)}s`, (x0 + x1) / 2, 7);
      }

      // effects
      for (const r of ripples) {
        r.age += dt;
        const a = 1 - r.age / 0.5; if (a <= 0) continue;
        const x = xOf(r.k * col), y = yOf((r.j + 1) * band), g = r.age * 30;
        ctx.strokeStyle = rgba(T.accent, a); ctx.lineWidth = 2; ctx.strokeRect(x - g, y - g, colPx + 2 * g, rowPx + 2 * g);
      }
      while (ripples.length && ripples[0]!.age > 0.5) ripples.shift();
      for (const p of parts) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 420 * dt; p.vx *= 0.985; p.r += p.vr * dt; p.life -= dt * 0.9;
        ctx.globalAlpha = clamp(p.life, 0, 1); ctx.fillStyle = p.c;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillRect(-2, -2, 4, 4); ctx.restore();
      }
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.life <= 0) parts.splice(i, 1);
      for (const f of floats) {
        f.age += dt;
        ctx.globalAlpha = clamp(1.4 - f.age, 0, 1); ctx.fillStyle = T.win; ctx.textAlign = "center";
        ctx.font = `600 20px ${monoFont}`; ctx.fillText(f.txt, f.x, f.y - f.age * 46);
      }
      while (floats.length && floats[0]!.age > 1.5) floats.shift();
      ctx.globalAlpha = 1;

      // payout preview
      if (hover) {
        const q = quoteAt(hover.k, hover.j);
        if (q?.ok) {
          const s = props.current.stake;
          const txt = `$${s.toFixed(2)} → ${money((s * q.multBps) / 1e4)}`;
          ctx.font = `600 11px ${monoFont}`;
          const tw = ctx.measureText(txt).width + 14;
          const x = xOf(hover.k * col) + colPx / 2, y = yOf((hover.j + 1) * band) - 8;
          const bx = clamp(x - tw / 2, nowX + 2, AX - tw - 2), by = Math.max(24, y - 22);
          ctx.fillStyle = T.ink; ctx.fillRect(bx, by, tw, 20);
          ctx.fillStyle = T.bg; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(txt, bx + 7, by + 10.5);
        }
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); clearInterval(themeTimer); clearInterval(fontTimer);
      cvs.removeEventListener("pointermove", onMove); cvs.removeEventListener("pointerleave", onLeave);
      cvs.removeEventListener("pointerdown", onDown);
      offResult();
    };
  }, [model]);

  return <canvas ref={canvas} aria-label="Trading grid: tap a box to place a bet" />;
}
