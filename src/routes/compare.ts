import { Router, Request, Response } from "express";
import { z } from "zod";
import { cacheGet, cacheSet } from "../lib/cache";
import {
  ensureGtfs,
  getActiveServiceIds,
  parseGtfsTime,
  getTorontoMidnightMs,
  getTodayStr,
  getTodayDow,
} from "../lib/gtfs-static";
import { fetchTripUpdates, TripUpdate } from "../lib/gtfsrt";
import { Departure, CompareResponseSchema } from "../schemas";

const router = Router();

const QuerySchema = z.object({
  // comma-separated stop IDs: "UN,MK,OS"
  stop_ids:    z.string().min(1).transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  limit:       z.coerce.number().int().min(1).max(10).default(3),
  window_hours: z.coerce.number().min(0.5).max(6).default(2),
  // per-stop drive time in seconds (comma-separated, aligned with stop_ids)
  drive_seconds: z.string().optional().transform((s) =>
    s ? s.split(",").map((x) => parseInt(x.trim()) || 0) : []
  ),
});

/**
 * GET /v1/compare?stop_ids=UN,MK,OS&limit=3&drive_seconds=0,900,1200
 *
 * Returns departures for 2-3 stations side-by-side with a "next_viable"
 * departure — the first train you can still catch given the drive time.
 *
 * V1 feature: drive_seconds is client-supplied (from Google Maps Distance Matrix
 * on the mobile side) to avoid needing a Maps API key on the proxy.
 */
router.get("/", async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error:   "bad_request",
      message: parsed.error.issues.map((i) => i.message).join(", "),
      status:  400,
    });
  }

  const { stop_ids, limit, window_hours, drive_seconds } = parsed.data;

  if (stop_ids.length < 2 || stop_ids.length > 3) {
    return res.status(400).json({
      error:   "bad_request",
      message: "stop_ids must contain 2–3 comma-separated IDs",
      status:  400,
    });
  }

  const CACHE_KEY = `compare:${stop_ids.join(",")}:${limit}:${drive_seconds.join(",")}`;
  const cached = await cacheGet<object>(CACHE_KEY);
  if (cached) return res.json(cached);

  try {
    const gtfs = await ensureGtfs();

    const todayStr   = getTodayStr();
    const todayDow   = getTodayDow();
    const midnightMs = getTorontoMidnightMs();
    const now        = new Date();
    const windowEnd  = new Date(now.getTime() + window_hours * 3_600_000);
    const activeServices = getActiveServiceIds(gtfs, todayStr, todayDow);

    // Fetch realtime once for all stations
    const tripUpdateMap = new Map<string, TripUpdate>();
    try {
      const rt = await fetchTripUpdates();
      for (const tu of rt.trips) tripUpdateMap.set(tu.trip_id, tu);
    } catch {}

    const stations = stop_ids.map((stopId, idx) => {
      const stop = gtfs.stops.get(stopId) ?? gtfs.stopsByCode.get(stopId.toUpperCase()) ?? null;
      const resolvedId = stop?.stop_id ?? stopId;
      const driveMs = (drive_seconds[idx] ?? 0) * 1000;

      const stopTimes = gtfs.stopTimesIndex.get(resolvedId) ?? [];
      const departures: Departure[] = [];

      for (const st of stopTimes) {
        if (departures.length >= limit) break;
        const trip = gtfs.trips.get(st.trip_id);
        if (!trip || !activeServices.has(trip.service_id)) continue;

        const dep = parseGtfsTime(st.departure_time, midnightMs);
        if (dep < now || dep > windowEnd) continue;

        const route = gtfs.routes.get(trip.route_id);
        const update = tripUpdateMap.get(st.trip_id);
        const stopUpdate = update?.stop_time_updates.find(
          (u) => u.stop_id === resolvedId || u.stop_sequence === st.stop_sequence
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

        departures.push({
          trip_id:             st.trip_id,
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
        });
      }

      // Next viable: first departure with enough buffer for the drive
      const leaveBy = new Date(now.getTime() + driveMs);
      const nextViable = departures.find((d) => {
        const actualDep = new Date(d.realtime_departure ?? d.scheduled_departure);
        return actualDep > leaveBy && d.status !== "CANCELLED";
      }) ?? null;

      return {
        stop_id:       resolvedId,
        stop_name:     stop?.stop_name ?? stopId,
        drive_seconds: drive_seconds[idx] ?? null,
        departures,
        next_viable:   nextViable,
      };
    });

    const result = CompareResponseSchema.parse({
      generated_at: now.toISOString(),
      stations,
    });

    await cacheSet(CACHE_KEY, result, 30_000);
    return res.json(result);
  } catch (err) {
    const message = (err as Error).message ?? "Unknown error";
    console.error("[compare]", message);
    return res.status(502).json({ error: "upstream_error", message, status: 502 });
  }
});

export default router;
