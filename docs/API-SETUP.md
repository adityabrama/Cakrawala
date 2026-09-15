# API and key setup

CAKRAWALA runs with **no keys at all**: Esri satellite basemap, OpenSky /
adsb.lol aircraft, USGS earthquakes, CelesTrak satellites, public CCTV, radio,
bikeshare, Launch Library, and the entire Indonesia intelligence engine
(BMKG, BNPB, PVMBG/MAGMA, GDELT, Open-Meteo, World Bank, ECB rates) plus the
2D GIS map (OpenFreeMap / Esri basemaps) are keyless.

Keys add capabilities. Paste them in the in-app **POWER UP** panel (bottom
right) — it writes `.env` (or `pinokio/ENVIRONMENT` under Pinokio) and
restarts the dev server. Never paste keys into chat, source files, or share
links.

## Key matrix

| Tier | Variable | Unlocks | Where to get it |
| --- | --- | --- | --- |
| 🟢 keyless | — | Everything listed above | — |
| 🟡 free key | `CESIUM_ION_TOKEN` | Google Photorealistic 3D via ion, Bing imagery, world terrain, ion geocoder search | https://ion.cesium.com (client-exposed; restrict the token) |
| 🟡 free key | `FIRMS_MAP_KEY` | NASA FIRMS active fires (also feeds Indonesia fire signals) | https://firms.modaps.eosdis.nasa.gov/api/map_key/ |
| 🟡 free key | `AISSTREAM_API_KEY` | Live vessels (AIS) | https://aisstream.io |
| 🟡 free key | `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | More OpenSky polling credits | https://opensky-network.org |
| 🟡 free key | `TOMTOM_API_KEY` | Live traffic flow speeds | https://developer.tomtom.com |
| 🟡 free key | `RELIEFWEB_APPNAME` | ReliefWeb (UN OCHA) Indonesia disasters in the intelligence engine | https://apidoc.reliefweb.int/parameters#appname |
| 🔴 metered | `GOOGLE_MAPS_API_KEY` | Direct Google 3D tiles + Google place search | https://console.cloud.google.com (client-exposed; restrict by referrer + API) |
| 🔴 metered | `OPENAI_API_KEY` | Voice agent (Realtime API) and HUD summaries | https://platform.openai.com |

Engine switch: `GEV_INTEL_ENABLED=false` turns the intelligence sweeps off
(the `/api/intel/*` endpoints then answer with empty data).

## Windows (PowerShell) setup

```powershell
git clone https://github.com/bilawalsidhu/gods-eye-view.git
cd gods-eye-view
npm ci
Copy-Item .env.example .env      # optional: fill keys, or use POWER UP in the app
npm run dev
```

Open http://localhost:5173 (Vite prints the port). Under Pinokio the launcher
runs the same command on its own port and opens the app for you.

Rebuild the bundled Indonesia data pack (only when the sources changed; needs
network, ~2 minutes):

```powershell
node scripts/build-indonesia-pack.mjs
```

## Costs

Keyless: free. Free-key tiers: free within provider quotas (FIRMS, AISStream,
OpenSky, TomTom free tier, ReliefWeb). Metered: Google Maps Platform and
OpenAI bill per use — set budget alerts in their consoles. The intelligence
engine never calls a metered API.
