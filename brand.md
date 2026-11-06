# Quickdraw brand: Range

Trading-desk precision that plays like a game. Graphite, one amber signal colour, condensed type,
a hairline grid. Amber means "yours / act here"; green means money in; red means money out.
Nothing else gets a colour.

## Colour

| Token    | Dark      | Light     | Use |
|----------|-----------|-----------|-----|
| `bg`     | `#0E0F11` | `#F2EFE8` | page |
| `panel`  | `#15171A` | `#FFFFFF` | cards, dock |
| `board`  | `#111214` | `#FBFAF7` | trading grid |
| `ink`    | `#E8E4DA` | `#16171A` | primary text |
| `mute`   | `#7C7A73` | `#77736A` | labels, axis, low multipliers |
| `line`   | `#24272C` | `#DED9CD` | borders, hairlines |
| `accent` | `#FFB224` | `#D98200` | the signal: bets, selected stake, hover, LIVE |
| `price`  | `#FFB224` | `#16171A` | price line and price tag |
| `win`    | `#3DDC97` | `#0F9D63` | wins, positive P&L |
| `loss`   | `#FF5A4E` | `#D93A2F` | losses, negative P&L |

Dark is the default. Grid lines are `ink` at 6% alpha. Multiplier text blends `mute` → `accent`
on a log scale from 1.1× to 25×, so far boxes glow amber and near boxes stay quiet.

## Type

- **Display / UI:** IBM Plex Sans Condensed 500–700. Wordmark `QUICKDRAW`, uppercase, 0.12em tracking, with a 12px amber square.
- **Numbers / labels:** IBM Plex Mono 400–600, `tabular-nums` everywhere a number changes.
- Labels: mono 11px, uppercase, 0.06em tracking, `mute`.
- Hero price: condensed 500, 46px desktop / 36px mobile.

## Shape and motion

- Radius 2px on controls, 4px on cards. No shadows; separation comes from `line` borders.
- Board: hairline grid, rows are price bands, columns are time windows. "Now" is a dashed vertical
  line at ~34% width (26% on phones); the past scrolls left, the future scrolls in from the right.
- Price line: 2px `price` with a 14% → 0 vertical gradient fill; pulsing dot at the head.
- Bet: solid `accent` block, `bg`-coloured mono label `$5.00 · 3.2x`. Won: solid `win`, `+$16.00`.
  Lost: 16% `loss` tint, `−$5.00`, fades to 25% over 3s.
- Tap feedback: amber ripple expanding from the box, latency badge flashes `tap → ER · 48ms`.
- Win: amber/green square confetti burst, rising `+$X` in mono, 30ms haptic.
- Boxes above 25× show a faint dot and are not tradable. Columns lock 0.8s before they open.
- Respect `prefers-reduced-motion`: no particles, no pulsing.

## Voice

Short, confident, numerical. "Tap a box. If the price touches it before its column closes, you win
the multiplier." No exclamation marks, no emoji in UI chrome (one 🔥 allowed on a 3+ streak).
