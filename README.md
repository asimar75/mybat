# mybat — Home Battery Sizer

A web app that tells you **which home battery size pays for itself**, using your real
hour-by-hour history from Home Assistant: solar production, household consumption and EV
charging.

It simulates a battery for every size from 0 to 25 kWh (configurable) across your history,
then compares the bill savings with what the battery costs.

## Why hourly data and not yearly totals

A battery only helps when solar surplus at noon can be stored and used in the evening. Two homes
with identical yearly totals can need very different batteries. The app therefore needs
hourly data, and Home Assistant's long-term statistics already have it (kept indefinitely,
even though raw history is purged after ~10 days).

## Running it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:8050. Try **Demo data** first to learn the tool.

### Connecting Home Assistant

1. In Home Assistant: click your profile (bottom left) → **Security** → **Long-lived access tokens**
   → **Create token**. Copy it.
2. In the app: **Home Assistant** tab → enter your URL (e.g. `http://homeassistant.local:8123`)
   and the token → **Connect**.
3. The app reads your **Energy dashboard** setup and pre-fills grid, solar and EV charger
   sensors. Check them, then **Load history**.

If your Energy dashboard isn't configured, type the statistic IDs manually (the fields
autocomplete from every energy sensor HA has).

> **https vs http:** a browser won't let an `https://` page talk to an `http://` Home Assistant.
> Run the app locally with `npm run dev` (which is `http://`), or use an `https://` HA URL
> such as Nabu Casa.

### No Home Assistant?

Use the **CSV file** tab. Columns: `timestamp`, `consumption_kwh` (total incl. EV) **or**
`grid_import_kwh` + `grid_export_kwh`, plus optional `solar_kwh` and `ev_kwh`. A template is
downloadable in the app.

## How the simulation works

For every hour:

1. Solar powers the house, then the EV charger.
2. Leftover solar charges the battery (limited by capacity, power and efficiency), the rest is exported.
3. Any shortfall is covered by the battery, then the grid.
   By default the battery **never discharges into the car**. An EV battery is 5–10× larger and
   would empty the home battery every session.
4. Optional (time-of-use tariffs): charge from the grid off-peak, hold the charge for peak hours.

The recommended size is the one with the highest **lifetime net benefit** (savings over the
battery's life, with yearly capacity loss, minus its cost). If none is positive, the app says so.

### Known limits

- **Hourly resolution** misses spikes inside an hour, so savings are slightly underestimated.
- **Less than a year of data** is scaled up, but solar is seasonal. A summer-only sample overstates winter performance.
- Future tariffs, battery prices and degradation are your assumptions.

## Project layout

```
src/engine/   simulation + size sweep (pure TypeScript, unit tested)
src/data/     Home Assistant WebSocket client, CSV parser, demo data
src/ui/       charts and formatting
src/main.ts   page wiring
```

```bash
npm test         # unit tests
npm run build    # type-check + production build into dist/
```

## Roadmap ideas

- Wrap as an iOS/Android app with [Capacitor](https://capacitorjs.com) (same code).
- Model dynamic (hourly spot) tariffs.
- Add backup-power sizing (keep a reserve for outages).
