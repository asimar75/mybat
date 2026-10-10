# mybat — home battery sizer

Web app that sizes a home battery from a household's own hourly energy data: grid import/export,
solar, EV charger and a heat-pump water heater. It runs on the owner's Raspberry Pi (32-bit armhf,
Raspberry Pi OS) as a systemd service and is opened from a laptop or phone on the home network.
The owner is learning to build apps with Claude; explain decisions plainly.

## Commands

```sh
npm ci                                 # install (Node 22; same as CI)
npm run dev                            # http://localhost:8050 (also on the LAN), with the Pi store API
npm test                               # vitest, all tests
TZ=Europe/Amsterdam npm test           # again with daylight saving: CI runs both
npm run build                          # tsc --noEmit + vite build → dist/
npm run preview                        # serves dist/ on 8050 with the store API (what the Pi runs)
```

Before every push: `npm test`, `TZ=Europe/Amsterdam npm test` and `npm run build` must all pass.

## Stack

Vite 8 + TypeScript 5.9, vanilla DOM (no framework), Chart.js 4, write-excel-file (lazy-loaded),
vitest. No backend besides a Vite plugin (below). Port 8050 (`strictPort`, `host: true`,
`allowedHosts: true`, see `vite.config.ts`).

## Layout

- `src/engine/` — pure, unit-tested model
  - `types.ts` — `HourSample { t, house, ev, solar, wh?, rate?, gridIn?, gridOut? }` (kWh per hour;
    `house` excludes EV and water heater; `rate` = T1/T2 tariff register; `gridIn/Out` = measured by
    the meter, not netted), `Tariff`, `Economics`, `BatterySpec`, `SimResult`
  - `simulate.ts` — hour-by-hour battery simulation (`prepare`, `simulate`, optional trace)
  - `sweep.ts` — runs all sizes; `lifecycle()`: wear = calendar loss + 30 % × cycles/rated cycles,
    replaced at 70 % capacity (`END_OF_LIFE`), replacement at a share of today's price, straight-line
    leftover value, discounting (real rate), discounted payback; `best` = highest net benefit,
    `knee` = smallest size with ≥ 90 % of the max saving
  - `scenario.ts` (what-if %, water heater and EV on solar surplus), `reimbursement.ts` (employer EV
    reimbursement per month; never part of battery savings)
- `src/data/`
  - `meters.ts` — HomeWizard per-meter CSV import (cumulative 15-min registers, T1/T2, DST, gaps,
    evenly-spread outage detection); `combineMeters` (period set by grid/consumption/solar only;
    short EV/water-heater files zero-filled)
  - `csv.ts` — the app's own CSV format (round-trips everything `toCsv` writes)
  - `homeassistant.ts` (WebSocket client), `derive.ts` (HA statistics → samples)
  - `merge.ts` — `appendHistory`: add Home Assistant hours after a CSV history, overlap check,
    T1/T2 pattern fill
  - `validate.ts` — checks, monthly/daily totals, period helpers (last 12 months, 12-month windows)
  - `persist.ts` — compact dataset encoding, localStorage, and the client for the Pi store
- `src/ui/` — `charts.ts`, `excel.ts`, `format.ts` (dates are DD/MMM/YYYY everywhere)
- `src/main.ts` — all page wiring; `index.html` — markup (side panel of assumptions + steps)
- `server/dataset-store.ts` — Vite plugin middleware: `/api/dataset` and `/api/settings`, JSON files
  in `data/` (or `MYBAT_DATA_DIR`), previous version kept as `*.prev.json`, 409 on a stale
  `X-Base-Saved-At`. Shared settings = `mybat.settings`, `mybat.period`, `mybat.reimbMonths`
  (newest wins); HA URL/token and UI conveniences stay per browser.

## Rules

- **Never commit personal data.** `*.csv`, `*.xlsx`, `/data/` are git-ignored; check
  `git diff --cached --name-only` before committing. Real-data checks go in a temporary test or a
  scratch script outside the repo, deleted before committing. The repo is public.
- Never store the Home Assistant token on the server.
- Keep the engine pure and tested; every bug fix gets a test. Tests must pass in UTC and in
  Europe/Amsterdam.
- Match the surrounding style: short comments that say *why*, plain-language UI text (the owner and
  their family read it), DD/MMM/YYYY dates, € amounts via `money()`.
- Explain results honestly: say when a number depends on placeholder assumptions (prices, battery
  quote, export price after net metering ends in the Netherlands on 1 Jan 2027).

## Git workflow

- `main` is protected: changes go through a pull request, and the `build` check must pass before
  merging. Squash-merge. Work on a branch; keep each PR to one change.
- Commit messages: imperative summary line, then what changed and why.

## Deploying to the Pi

The Pi runs `npm run preview` from `~/mybat` as the `mybat` systemd service; history and settings
live in `~/mybat/data/`. After a merge, on the Pi:

```sh
cd ~/mybat && git pull && npm ci && npm run build && sudo systemctl restart mybat
```

Browsers keep running the old version until the page is reloaded.
