import { Router, Request, Response } from "express";
import {
  ensureGtfs,
  getActiveServiceIds,
  parseGtfsTime,
  getMidnightMsForDate,
  getDowForDate,
  getTodayStr,
} from "../lib/gtfs-static";

const router = Router();

// ── Station Schedule ───────────────────────────────────────────────────────────
// GET /v1/schedule/station?stop_id=MK&date=20260421&limit=20
// Returns all departures from a stop on a given date, each with full stop times.
router.get("/station", async (req: Request, res: Response) => {
  const stopId = (req.query.stop_id as string)?.toUpperCase();
  const date   = (req.query.date   as string) || getTodayStr();
  const limit  = Math.min(parseInt((req.query.limit as string) ?? "20"), 60);

  if (!stopId) {
    return res.status(400).json({ error: "bad_request", message: "stop_id required" });
  }
  if (!/^\d{8}$/.test(date)) {
    return res.status(400).json({ error: "bad_request", message: "date must be YYYYMMDD" });
  }

  try {
    const gtfs = await ensureGtfs();
    const stop  = gtfs.stops.get(stopId) ?? gtfs.stopsByCode.get(stopId) ?? null;
    const resolvedId = stop?.stop_id ?? stopId;

    const dow            = getDowForDate(date);
    const activeServices = getActiveServiceIds(gtfs, date, dow);
    const midnightMs     = getMidnightMsForDate(date);

    const rawTimes = gtfs.stopTimesIndex.get(resolvedId) ?? [];

    const departures: object[] = [];

    for (const st of rawTimes) {
      if (departures.length >= limit) break;

      const trip = gtfs.trips.get(st.trip_id);
      if (!trip || !activeServices.has(trip.service_id)) continue;

      const depDate = parseGtfsTime(st.departure_time, midnightMs);

      const route = gtfs.routes.get(trip.route_id);
      const tripTimes = gtfs.tripTimesIndex.get(st.trip_id) ?? [];

      const stopTimes = tripTimes.map((tst) => {
        const s = gtfs.stops.get(tst.stop_id);
        return {
          stop_id:        tst.stop_id,
          stop_name:      s?.stop_name ?? tst.stop_id,
          stop_sequence:  tst.stop_sequence,
          departure_time: tst.departure_time.substring(0, 5),
          departure_iso:  parseGtfsTime(tst.departure_time, midnightMs).toISOString(),
        };
      });

      departures.push({
        trip_id:             st.trip_id,
        route_short_name:    route?.route_short_name ?? trip.route_id,
        route_long_name:     route?.route_long_name ?? "",
        headsign:            trip.trip_headsign,
        direction_id:        trip.direction_id,
        scheduled_departure: depDate.toISOString(),
        stop_times:          stopTimes,
      });
    }

    return res.json({
      stop_id:   resolvedId,
      stop_name: stop?.stop_name ?? stopId,
      date,
      departures,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("[schedule/station]", message);
    return res.status(502).json({ error: "upstream_error", message });
  }
});

// ── Journey Planner ────────────────────────────────────────────────────────────
// GET /v1/schedule/journey?from=MK&to=UN&date=20260421&time=07:00&limit=10
// Finds trips calling at both stops in order, departing from `from` at or after `time`.
router.get("/journey", async (req: Request, res: Response) => {
  const fromId  = (req.query.from as string)?.toUpperCase();
  const toId    = (req.query.to   as string)?.toUpperCase();
  const date    = (req.query.date  as string) || getTodayStr();
  const timeStr = (req.query.time  as string) || "00:00";
  const limit   = Math.min(parseInt((req.query.limit as string) ?? "10"), 30);

  if (!fromId || !toId) {
    return res.status(400).json({ error: "bad_request", message: "from and to required" });
  }
  if (fromId === toId) {
    return res.status(400).json({ error: "bad_request", message: "from and to must differ" });
  }
  if (!/^\d{8}$/.test(date)) {
    return res.status(400).json({ error: "bad_request", message: "date must be YYYYMMDD" });
  }

  try {
    const gtfs = await ensureGtfs();

    const fromStop = gtfs.stops.get(fromId) ?? gtfs.stopsByCode.get(fromId) ?? null;
    const toStop   = gtfs.stops.get(toId)   ?? gtfs.stopsByCode.get(toId)   ?? null;
    const fromResolved = fromStop?.stop_id ?? fromId;
    const toResolved   = toStop?.stop_id   ?? toId;

    const dow            = getDowForDate(date);
    const activeServices = getActiveServiceIds(gtfs, date, dow);
    const midnightMs     = getMidnightMsForDate(date);

    // Parse time threshold as HH:MM:SS string for lexicographic compare
    const [hh = 0, mm = 0] = timeStr.split(":").map(Number);
    const threshold = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;

    const fromTimes = gtfs.stopTimesIndex.get(fromResolved) ?? [];

    const journeys: object[] = [];

    for (const fromSt of fromTimes) {
      if (journeys.length >= limit) break;
      if (fromSt.departure_time < threshold) continue;

      const trip = gtfs.trips.get(fromSt.trip_id);
      if (!trip || !activeServices.has(trip.service_id)) continue;

      const tripTimes = gtfs.tripTimesIndex.get(fromSt.trip_id) ?? [];
      const toSt = tripTimes.find(
        (st) => st.stop_id === toResolved && st.stop_sequence > fromSt.stop_sequence
      );
      if (!toSt) continue;

      const route       = gtfs.routes.get(trip.route_id);
      const departDate  = parseGtfsTime(fromSt.departure_time, midnightMs);
      const arriveDate  = parseGtfsTime(toSt.departure_time,   midnightMs);
      const durationMin = Math.round((arriveDate.getTime() - departDate.getTime()) / 60_000);

      journeys.push({
        trip_id:          fromSt.trip_id,
        route_short_name: route?.route_short_name ?? trip.route_id,
        route_long_name:  route?.route_long_name  ?? "",
        headsign:         trip.trip_headsign,
        depart_time:      fromSt.departure_time.substring(0, 5),
        depart_iso:       departDate.toISOString(),
        arrive_time:      toSt.departure_time.substring(0, 5),
        arrive_iso:       arriveDate.toISOString(),
        duration_minutes: durationMin,
      });
    }

    return res.json({
      from_stop_id:   fromResolved,
      from_stop_name: fromStop?.stop_name ?? fromId,
      to_stop_id:     toResolved,
      to_stop_name:   toStop?.stop_name   ?? toId,
      date,
      journeys,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("[schedule/journey]", message);
    return res.status(502).json({ error: "upstream_error", message });
  }
});

export default router;
