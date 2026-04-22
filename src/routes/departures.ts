import { Router, Request, Response } from "express";
import { z } from "zod";
import { cacheGet, cacheSet } from "../lib/cache";
import { fetchTripUpdates, TripUpdate } from "../lib/gtfsrt";
import {
  ensureGtfs,
  getActiveServiceIds,
  parseGtfsTime,
  getTorontoMidnightMs,
  getTodayStr,
  getTodayDow,
} from "../lib/gtfs-static";
import { fetchNextService } from "../lib/nextService";
import { Departure, DeparturesResponseSchema } from "../schemas";

const router = Router();

const QuerySchema = z.object({
  stop_id:      z.string().min(1),
  limit:        z.coerce.number().int().min(1).max(20).default(5),
  window_hours: z.coerce.number().min(0.5).max(12).default(3),
});

// GET /v1/departures?stop_id=UN&limit=5&window_hours=3
router.get("/", async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "bad_request",
      message: parsed.error.issues.map((i) => i.message).join(", "),
      status: 400,
    });
  }

  const { stop_id, limit, window_hours } = parsed.data;
  const CACHE_KEY = `departures:${stop_id}:${limit}`;

  const cached = await cacheGet<object>(CACHE_KEY);
  if (cached) return res.json(cached);

  // ── GTFS merge path ────────────────────────────────────────────────────────
  try {
    const gtfs = await ensureGtfs();

    // Resolve stop: accept either GTFS stop_id or stop_code
    const stop =
      gtfs.stops.get(stop_id) ??
      gtfs.stopsByCode.get(stop_id.toUpperCase()) ??
      null;

    const resolvedStopId = stop?.stop_id ?? stop_id;
    const stopTimes = gtfs.stopTimesIndex.get(resolvedStopId) ?? [];

    const todayStr   = getTodayStr();
    const todayDow   = getTodayDow();
    const midnightMs = getTorontoMidnightMs();
    const now        = new Date();
    const windowEnd  = new Date(now.getTime() + window_hours * 3_600_000);

    const activeServices = getActiveServiceIds(gtfs, todayStr, todayDow);

    // Scheduled departures within window for active services
    const scheduled: { dep: Date; tripId: string }[] = [];
    for (const st of stopTimes) {
      const trip = gtfs.trips.get(st.trip_id);
      if (!trip || !activeServices.has(trip.service_id)) continue;
      const dep = parseGtfsTime(st.departure_time, midnightMs);
      if (dep < now || dep > windowEnd) continue;
      scheduled.push({ dep, tripId: st.trip_id });
      if (scheduled.length >= limit * 4) break; // over-fetch before realtime merge
    }

    // Fetch realtime (graceful degrade)
    const tripUpdateMap = new Map<string, TripUpdate>();
    try {
      const rt = await fetchTripUpdates();
      for (const tu of rt.trips) tripUpdateMap.set(tu.trip_id, tu);
    } catch {
      // schedule-only if GTFS-RT unavailable
    }

    // Build merged departure list
    const departures: Departure[] = scheduled
      .slice(0, limit)
      .map(({ dep, tripId }) => {
        const trip  = gtfs.trips.get(tripId)!;
        const route = gtfs.routes.get(trip.route_id);
        const st    = stopTimes.find((s) => s.trip_id === tripId)!;
        const update = tripUpdateMap.get(tripId);

        const stopUpdate = update?.stop_time_updates.find(
          (u) => u.stop_id === resolvedStopId || u.stop_sequence === st.stop_sequence
        );

        const delaySec = stopUpdate?.departure_delay ?? 0;
        const realtimeDep: Date | null = stopUpdate?.departure_time
          ? new Date(stopUpdate.departure_time * 1000)
          : delaySec !== 0
          ? new Date(dep.getTime() + delaySec * 1000)
          : null;

        let status: Departure["status"] = "SCHEDULED";
        if (update?.schedule_relationship === "cancelled") status = "CANCELLED";
        else if (realtimeDep) status = delaySec > 60 ? "DELAYED" : "ON_TIME";

        return {
          trip_id:             tripId,
          route_id:            trip.route_id,
          route_short_name:    route?.route_short_name ?? trip.route_id,
          route_long_name:     route?.route_long_name ?? "",
          headsign:            trip.trip_headsign,
          direction_id:        trip.direction_id,
          stop_sequence:       st.stop_sequence,
          scheduled_departure: dep.toISOString(),
          realtime_departure:  realtimeDep?.toISOString() ?? null,
          delay_seconds:       delaySec || null,
          status,
          vehicle_id:          null,
        };
      });

    const result = DeparturesResponseSchema.parse({
      stop_id:      resolvedStopId,
      stop_name:    stop?.stop_name ?? stop_id,
      generated_at: now.toISOString(),
      source:       "gtfs",
      departures,
    });

    await cacheSet(CACHE_KEY, result, 30_000);
    return res.json(result);
  } catch (gtfsErr) {
    console.warn(
      "[departures] GTFS merge failed, falling back to NextService:",
      (gtfsErr as Error).message
    );
  }

  // ── NextService fallback ───────────────────────────────────────────────────
  try {
    const { generated_at, departures: nsDeps } = await fetchNextService(stop_id);

    const departures: Departure[] = nsDeps.slice(0, limit).map((d) => ({
      trip_id:             d.trip_id,
      route_id:            d.route_id,
      route_short_name:    d.route_id,
      route_long_name:     d.route_name,
      headsign:            d.headsign,
      direction_id:        null,
      stop_sequence:       null,
      scheduled_departure: toISO(d.scheduled),
      realtime_departure:  d.realtime ? toISO(d.realtime) : null,
      delay_seconds:       d.delay_minutes * 60 || null,
      status:
        d.status === "cancelled" ? "CANCELLED"
        : d.status === "delayed"  ? "DELAYED"
        : "ON_TIME",
      vehicle_id:   null,
      accessible:   d.accessible,
      platform:     d.platform,
    }));

    const result = {
      stop_id,
      stop_name:    stop_id,
      generated_at,
      source:       "nextservice" as const,
      departures,
    };

    await cacheSet(CACHE_KEY, result, 30_000);
    return res.json(result);
  } catch (nsErr) {
    const message = (nsErr as Error).message ?? "Unknown error";
    console.error("[departures] NextService also failed:", message);
    return res.status(502).json({ error: "upstream_error", message, status: 502 });
  }
});

/** Convert "HH:MM" NextService time to a full ISO string for today (Toronto TZ). */
function toISO(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export default router;
