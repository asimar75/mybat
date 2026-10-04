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

### No Home Assistant?

Use the **CSV file** tab. Columns: `timestamp`, `consumption_kwh` (total incl. EV) **or**
`grid_import_kwh` + `grid_export_kwh`, plus optional `solar_kwh` and `ev_kwh`. A template is
downloadable in the app.

## Results, what-ifs and saving

- **What if:** in *Assumptions*, change household use or EV charging by a percentage. Every hour
  is scaled equally, so your daily and seasonal pattern stays as measured: good for "use 10 %
  less" or "a second car with the same habits", not for a heat pump (which adds mostly winter
  load). A banner on the result shows the scenario next to your measured numbers.
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
