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
autocomplete from every energy sensor HA has). Your sensor choices are saved in the browser per
Home Assistant address, so the next connect restores them; **Reset to Energy dashboard** undoes that.

### Checking the data

Before the result, step 2 shows what was loaded so you can catch bad input:

- **Automatic checks:** missing hours, solar at night or peaking far from midday (time-zone shift),
  implausible household or EV hours (meter resets, Wh read as kWh), zero-consumption hours.
  Click an example to jump to that day.
- **Charts:** daily energy for the whole period, the average day, and any single day hour by hour.
- **Monthly totals table:** compare it with Home Assistant → Energy → month view.
- **Download all hourly data (CSV)** in the same format the CSV import reads, so you can fix values
  in a spreadsheet and load them back.

If a check fails, the result is flagged until the data is fixed.

> **https vs http:** a browser won't let an `https://` page talk to an `http://` Home Assistant.
> Run the app locally with `npm run dev` (which is `http://`), or use an `https://` HA URL
> such as Nabu Casa.

### Running it permanently on a Raspberry Pi

Works on Raspberry Pi OS, 32-bit or 64-bit (Pi 2 or newer). Not on a Pi Zero/1 (`uname -m` says
`armv6l`), and not on Home Assistant OS, which doesn't allow installing software this way.

```bash
# 1. Node.js 22 (the version in apt is too old for this app)
if ! node -v 2>/dev/null | grep -q '^v22'; then
  if [ "$(uname -m)" = "armv7l" ]; then
    # 32-bit OS: NodeSource doesn't support it, use the official Node.js build
    cd /tmp
    NODE_TAR=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v22[^"]*-linux-armv7l.tar.xz' | head -1)
    curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$NODE_TAR"
    sudo tar -xJf "$NODE_TAR" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
    rm "$NODE_TAR"
    hash -r
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi
sudo apt-get install -y git

# 2. Get and build the app
git clone https://github.com/asimar75/mybat.git ~/mybat
cd ~/mybat
npm ci
npm run build

# 3. Start it on boot as a service
sudo tee /etc/systemd/system/mybat.service >/dev/null <<EOF
[Unit]
Description=mybat battery sizer
After=network-online.target

[Service]
User=$USER
WorkingDirectory=$HOME/mybat
ExecStart=$(command -v npm) run preview
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now mybat
```

If the repository is private, `git clone` asks for a username and password: use your GitHub
username and a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with
read-only *Contents* access to this repository (GitHub no longer accepts account passwords for git).
Run `git config --global credential.helper store` first so later `git pull`s don't ask again.

Open `http://<pi-address>:8050` from any device on your network (find the address with
`hostname -I`). Check it's running with `systemctl status mybat`.

To update later: `cd ~/mybat && git pull && npm ci && npm run build && sudo systemctl restart mybat`.

### Water heater

If your water heater has its own energy meter, pick it under **Water heater (own meter)**; the app
tries to find it automatically. Its use is then shown separately, and **Run water heater on solar
surplus** (Strategy) moves each day's water heating into sunny hours, up to the heater's power,
before the battery gets the surplus. The result always compares both timings, so you can see how
much a timer or solar diverter saves on its own and how it changes the best battery size.

### Meter exports (HomeWizard and similar)

Monitoring apps such as **HomeWizard** export one CSV per meter: the P1 grid meter, kWh meters for
solar, the EV charger, a water heater… In the **CSV files** tab, select all of them at once. The app:

- detects running meter totals (HomeWizard's format) vs. energy per interval, any interval length
- adds up registers such as `Import T1 kWh` + `Import T2 kWh`, and ignores power columns (`L1 max W`)
- handles local timestamps with daylight-saving changes, gaps, and small counter glitches
- proposes what each file is from its energy flows and name (a file that both imports and exports
  is the grid meter, whatever it's called), shown in a table where you confirm or change it;
  your choices are remembered by file name
- uses the period the grid (or consumption) and solar files all cover, and says which is shorter; a
  shorter EV or water-heater file never cuts it: its missing hours count as 0 (e.g. a charger
  switched off), so total use stays right

If the grid meter has **T1/T2 registers**, each hour is priced as peak or off-peak from the register
it was counted on (Assumptions → Tariff → time-of-use). That follows schedule changes during the
year, which a fixed peak window can't. The register that counts weekday daytime is preselected as
peak, since conventions differ by country (in the Netherlands T1 is usually the cheap one).

**Why the totals can differ from the HomeWizard app.** The summary and the monthly table show the
grid meter's own import and export, which match the app. The simulation works hour by hour, so
import and export within the same hour (a cloud passing, the kettle while the panels export) net out.
The app reports how many kWh that is; typically 2–4 % of import. Consumption is
`import − export + solar`, so **load the solar meter too**: without it, consumption comes out far
too low (the app warns when the grid meter exports but no solar file is assigned).

**More than a year of data** (e.g. two HomeWizard downloads, since 15-minute data is kept for one
year): the app uses the last 12 months by default so each season counts once. In the summary you can
switch to any 12 calendar months, e.g. Aug–Jul to match the HomeWizard year view exactly, or to the
whole period. Download every meter for the same period, or the shortest file sets the range.

### CSV history + Home Assistant updates

Load the HomeWizard CSV history once, then use **Load history** in the Home Assistant tab with
**Add to the data already loaded** ticked (the default once data is loaded). It fetches from a week
before the end of what's loaded until now and adds only the new hours; the loaded hours are kept.
The overlapping week is compared, and a note warns if Home Assistant reads more than 5 % differently
(different sensors?). Added hours get the T1/T2 register your meter used at that hour on similar
recent days, and keep Home Assistant's grid import/export. Repeat it whenever you want to bring the
data up to date.

The data is kept **in this browser only**, not on the Raspberry Pi: another device or browser starts
empty, and clearing the browser's site data erases it. As a backup, use **Download all hourly data
(CSV)**; that file loads back in the CSV files tab with everything (registers and grid totals included).

### No Home Assistant?

Use the **CSV files** tab with one file in this app's own format. Columns: `timestamp`, `consumption_kwh` (total incl. EV) **or**
`grid_import_kwh` + `grid_export_kwh`, plus optional `solar_kwh`, `ev_kwh` and `water_heater_kwh`. A template is
downloadable in the app.

## Results, what-ifs and saving

- **Assumptions panel:** all inputs live in a panel on the left (a drawer at the bottom on phones)
  that stays in place while you scroll the charts. Its header shows the live result (best size,
  payback, saving, net benefit), so every change is visible immediately.

- **What if:** in *Assumptions*, change household use or EV charging by a percentage. Every hour
  is scaled equally, so your daily and seasonal pattern stays as measured: good for "use 10 %
  less" or "a second car with the same habits", not for a heat pump (which adds mostly winter
  load). A banner on the result shows the scenario next to your measured numbers.
- **EV reimbursement:** if your employer pays you per kWh charged at home, tick it under
  *Assumptions → EV reimbursement*, set a default price and, under *Price per month*, the price
  for each month (empty months use the default). The result shows the yearly reimbursement and
  your net electricity cost after it, with and without the battery, and the Excel file adds it per
  month. It is deliberately **not** added to the battery's saving: it's paid on every EV kWh
  whether it came from the grid, solar or the battery, so it is the same for every battery size.
- **Hour by hour with a battery:** under the result, pick any tested size, a start date, 1–14 days
  and whether the battery may charge the car. One chart shows the energy stored; the other shows
  each hour's charging (from solar or grid, above zero) and discharging (to the house or the EV,
  below zero), with solar and home use for context. It opens on a recent sunny spell.
- **Download results (Excel):** one `.xlsx` with a *Summary* (recommendation, data, scenario and
  every assumption), *All sizes*, *Monthly* totals and the *Hourly data* used.
- **Data survives a refresh:** the last loaded dataset is kept in this browser until you load
  new data or click *Forget saved data*. Settings and sensor choices are kept too.

## How the simulation works

For every hour:

1. Solar powers the house, then the EV charger.
2. Leftover solar charges the battery (limited by capacity, power and efficiency), the rest is exported.
3. Any shortfall is covered by the battery, then the grid.
   By default the battery **never discharges into the car**. An EV battery is 5–10× larger and
   would empty the home battery every session.
4. Optional (time-of-use tariffs): charge from the grid off-peak, hold the charge for peak hours.

The recommended size is the one with the highest **net benefit** over the period you compare
(10, 20, 30 or 40 years): savings, minus the purchase, minus replacements, plus the value of the
life left in the last battery at the end (straight-line), all in today's money: later amounts are
discounted at a rate above inflation (default 2 %; set 0 to switch it off). If none is positive,
the app says so. Next to the simple payback (price ÷ first-year saving) it shows the **discounted
payback**: when the discounted, fading savings have repaid the purchase and any replacement bought
before then (leftover value isn't counted, so it's the stricter of the two).

**Wear and replacement.** A battery loses capacity from age (default 1 % a year) and from cycling:
its rated cycles (LFP: about 6,000) use up the 30 % down to 70 % capacity, when it's replaced at a
share of today's price (default 70 %, since prices keep falling). The simulation counts each size's
cycles from your data, so a bigger battery, cycling less, lasts longer. As it fades, a battery saves
what a smaller new one would, so an oversized battery hardly notices its wear.

### Known limits

- **Hourly resolution** misses spikes inside an hour and nets import against export within each hour, so savings are slightly underestimated.
- **Less than a year of data** is scaled up, but solar is seasonal. A summer-only sample overstates winter performance.
- Future tariffs, battery prices and degradation are your assumptions.
- Prices stay at today's level for the whole period; the discount rate (default 2 % above inflation)
  is the only adjustment for time. A higher rate shrinks long-period results the most.

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

## License

MIT, see [LICENSE](LICENSE). `.gitignore` blocks CSV/Excel exports and `.env` files so personal
energy data and secrets aren't committed by accident.
