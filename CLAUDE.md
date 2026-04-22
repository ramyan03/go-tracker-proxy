# GO Tracker Proxy

Express API server that wraps Metrolinx Open Data APIs and GTFS static data for the GO Tracker mobile app.

## Dev

```bash
npm run dev      # ts-node-dev with hot reload, port 3000
npm run build    # tsc → dist/
npm start        # run compiled dist/index.js
```

Health check: `GET /health` — returns `metrolinx_key` and `upstash_redis` booleans.

Local dev uses pre-downloaded GTFS files — set in `.env`:
```
GTFS_DATA_DIR=C:/Users/Ramyan Chelva/workspace/data
METROLINX_API_KEY=...
```

No Upstash Redis locally — falls back to in-memory cache (fine for dev).

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| GET | `/health` | Status + feature flags |
| GET | `/v1/departures` | `stop_id`, `limit`, `window_hours` — GTFS static + GTFS-RT merge |
| GET | `/v1/realtime/trips` | GTFS-RT trip updates (30s cache) |
| GET | `/v1/realtime/alerts` | GTFS-RT service alerts (60s cache) |
| GET | `/v1/gtfs/version` | GTFS zip Last-Modified/ETag |
| GET | `/v1/gtfs/download` | Streams GTFS zip |
| GET | `/v1/gtfs/status` | Internal GTFS static cache state |
| GET | `/v1/routes` | `type=train\|bus` — deduplicated by route_short_name |
| GET | `/v1/routes/:short_name/stops` | Ordered stops + lat/lon for both directions |
| GET | `/v1/stops` | `query=X` — stop search |
| GET | `/v1/stops/:id` | Single stop by stop_id or stop_code |
| GET | `/v1/fleet/consist` | Live consist data |
| GET | `/v1/compare` | `stop_ids=A,B`, `limit`, `drive_seconds` |
| GET | `/v1/guarantee` | `trip_id` — service guarantee eligibility |
| GET | `/v1/schedule/station` | `stop_id`, `date=YYYYMMDD`, `limit` |
| GET | `/v1/schedule/journey` | `from`, `to`, `date`, `time=HH:MM`, `limit` |

## Cache TTLs

| Data | TTL |
|------|-----|
| Departures | 30s |
| GTFS-RT trips | 30s |
| GTFS-RT alerts | 60s |
| Fleet consist | 60s |
| GTFS version | 1h |
| GTFS static | 6h |

## GTFS quirks — DO NOT work around these

**No `calendar.txt`** — GO Transit uses `calendar_dates.txt` only. `service_id = YYYYMMDD` date string.

**`route_id` has a date prefix** — e.g. `01260426-LW`, but `route_short_name = LW`. Always deduplicate routes by `route_short_name` before returning to clients.

**Train stop_ids are 2-letter codes** — `UN`, `MK`, `OA`, etc. Bus stops are longer strings.

**`stop_times.txt` is ~1.6M rows** — parsed line-by-line with a custom CSV parser. Do not introduce a CSV library dependency.

**`getTorontoMidnightMs()` in `gtfs-static.ts` — DO NOT SIMPLIFY.** It tries both EDT (UTC-4) and EST (UTC-5) offsets and picks whichever gives hour=0 in Toronto time. This is intentional — simplifying it breaks the departures filter during DST transitions.

## Key lib files

- `src/lib/gtfs-static.ts` — downloads/parses GTFS zip, refreshes every 6h. Exports `ensureGtfs()`, `getActiveServiceIds()`, `parseGtfsTime()`, `getTorontoMidnightMs()`, `getTodayStr()`, `getTodayDow()`, `getMidnightMsForDate()`, `getDowForDate()`
- `src/lib/gtfsrt.ts` — `fetchTripUpdates()`, `fetchAlerts()` via gtfs-realtime-bindings
- `src/lib/metrolinx.ts` — `metrolinxGet()`, `metrolinxProto()` with `Ocp-Apim-Subscription-Key` header
- `src/lib/nextService.ts` — Metrolinx REST NextService fallback for departures (includes Platform field)
- `src/lib/cache.ts` — `cacheGet`/`cacheSet` with Upstash Redis + in-memory fallback
- `src/schemas/index.ts` — Zod response schemas

## GtfsData structure

```ts
{
  stops: Map<stop_id, GtfsStop>
  stopsByCode: Map<stop_code, GtfsStop>
  routes: Map<route_id, GtfsRoute>
  trips: Map<trip_id, GtfsTrip>
  stopTimesIndex: Map<stop_id, GtfsStopTime[]>   // stop_id → sorted by departure_time
  tripTimesIndex: Map<trip_id, GtfsStopTime[]>   // trip_id → sorted by stop_sequence
  calendarDates: Map<service_id, exceptions[]>
}
```

`tripTimesIndex` is built by inverting `stopTimesIndex` — shared object references, minimal memory overhead.

## Deployment

- `Dockerfile` — multi-stage build, `ENV TZ=America/Toronto`, exposes port 3000
- `railway.toml` — healthcheck at `/health`, restarts on failure
- Set `METROLINX_API_KEY` and Upstash env vars in Railway dashboard before deploying

## API key status (as of 2026-04-21)

Key is set and recognised (`metrolinx_key: true` in `/health`). GTFS-RT feeds and NextService are returning 404/401 — subscription not yet provisioned. Registration submitted 2026-04-19 (up to 10 days). The departures endpoint falls back to GTFS static only until the subscription activates.
