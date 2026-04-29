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

// ── Last Departure ────────────────────────────────────────────────────────────
// GET /v1/schedule/lastdeparture?stop_id=UN&date=20260429
// Returns the last train departure time for a stop on a given date.
router.get("/lastdeparture", async (req: Request, res: Response) => {
  const stopId = (req.query.stop_id as string)?.toUpperCase();
  const date   = (req.query.date as string) || getTodayStr();

  if (!stopId) {
    return res.status(400).json({ error: "bad_request", message: "stop_id required" });
  }

  try {
    const gtfs = await ensureGtfs();
    const stop = gtfs.stops.get(stopId) ?? gtfs.stopsByCode.get(stopId) ?? null;
    const resolvedId = stop?.stop_id ?? stopId;

    const dow            = getDowForDate(date);
    const activeServices = getActiveServiceIds(gtfs, date, dow);
    const midnightMs     = getMidnightMsForDate(date);

    const rawTimes = gtfs.stopTimesIndex.get(resolvedId) ?? [];

    let lastDepTime: string | null = null;

    for (const st of rawTimes) {
      const trip = gtfs.trips.get(st.trip_id);
      if (!trip || !activeServices.has(trip.service_id)) continue;
      if (!lastDepTime || st.departure_time > lastDepTime) {
        lastDepTime = st.departure_time;
      }
    }

    const lastDepIso = lastDepTime
      ? parseGtfsTime(lastDepTime, midnightMs).toISOString()
      : null;

    return res.json({
      stop_id:            resolvedId,
      stop_name:          stop?.stop_name ?? stopId,
      date,
      last_departure_iso: lastDepIso,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("[schedule/lastdeparture]", message);
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
    const fromStopObj = gtfs.stops.get(fromResolved);
    const toStopObj   = gtfs.stops.get(toResolved);

    const journeys: object[] = [];
    const MIN_TRANSFER_MS = 5 * 60 * 1000;

    // ── Direct journeys ──────────────────────────────────────────────────────
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

      journeys.push({
        type:             "direct",
        trip_id:          fromSt.trip_id,
        route_short_name: route?.route_short_name ?? trip.route_id,
        route_long_name:  route?.route_long_name  ?? "",
        headsign:         trip.trip_headsign,
        depart_time:      fromSt.departure_time.substring(0, 5),
        depart_iso:       departDate.toISOString(),
        arrive_time:      toSt.departure_time.substring(0, 5),
        arrive_iso:       arriveDate.toISOString(),
        duration_minutes: Math.round((arriveDate.getTime() - departDate.getTime()) / 60_000),
      });
    }

    // ── Transfer journeys (1 change) ─────────────────────────────────────────
    // Only search for transfers if we haven't filled the result set with directs.
    if (journeys.length < limit) {
      // Track seen (leg1TripId, transferStopId, leg2TripId) to avoid duplicates
      const seen = new Set<string>();

      outer: for (const fromSt of fromTimes) {
        if (fromSt.departure_time < threshold) continue;

        const trip1 = gtfs.trips.get(fromSt.trip_id);
        if (!trip1 || !activeServices.has(trip1.service_id)) continue;

        const leg1Stops = gtfs.tripTimesIndex.get(fromSt.trip_id) ?? [];

        for (const transferSt of leg1Stops) {
          if (journeys.length >= limit) break outer;
          if (transferSt.stop_sequence <= fromSt.stop_sequence) continue;
          if (transferSt.stop_id === toResolved) continue; // direct route handled above
          if (transferSt.stop_id.length > 3) continue;     // train stops only

          const transferStop = gtfs.stops.get(transferSt.stop_id);
          const leg2Times    = gtfs.stopTimesIndex.get(transferSt.stop_id) ?? [];
          const arrivalAtTransfer = parseGtfsTime(transferSt.departure_time, midnightMs);
          const earliestLeg2Ms    = arrivalAtTransfer.getTime() + MIN_TRANSFER_MS;

          for (const leg2FromSt of leg2Times) {
            const leg2Depart = parseGtfsTime(leg2FromSt.departure_time, midnightMs);
            if (leg2Depart.getTime() < earliestLeg2Ms) continue;

            const trip2 = gtfs.trips.get(leg2FromSt.trip_id);
            if (!trip2 || !activeServices.has(trip2.service_id)) continue;

            const leg2Stops = gtfs.tripTimesIndex.get(leg2FromSt.trip_id) ?? [];
            const toSt = leg2Stops.find(
              (st) => st.stop_id === toResolved && st.stop_sequence > leg2FromSt.stop_sequence
            );
            if (!toSt) continue;

            const key = `${fromSt.trip_id}|${transferSt.stop_id}|${leg2FromSt.trip_id}`;
            if (seen.has(key)) break;
            seen.add(key);

            const route1 = gtfs.routes.get(trip1.route_id);
            const route2 = gtfs.routes.get(trip2.route_id);
            const departDate   = parseGtfsTime(fromSt.departure_time, midnightMs);
            const arriveDate   = parseGtfsTime(toSt.departure_time,   midnightMs);
            const leg2Arrive   = parseGtfsTime(toSt.departure_time,   midnightMs);

            journeys.push({
              type:                  "transfer",
              depart_time:           fromSt.departure_time.substring(0, 5),
              depart_iso:            departDate.toISOString(),
              arrive_time:           toSt.departure_time.substring(0, 5),
              arrive_iso:            arriveDate.toISOString(),
              total_duration_minutes: Math.round((arriveDate.getTime() - departDate.getTime()) / 60_000),
              transfer_stop_id:      transferSt.stop_id,
              transfer_stop_name:    transferStop?.stop_name ?? transferSt.stop_id,
              legs: [
                {
                  trip_id:          fromSt.trip_id,
                  route_short_name: route1?.route_short_name ?? trip1.route_id,
                  route_long_name:  route1?.route_long_name  ?? "",
                  headsign:         trip1.trip_headsign,
                  from_stop_id:     fromResolved,
                  from_stop_name:   fromStopObj?.stop_name ?? fromResolved,
                  to_stop_id:       transferSt.stop_id,
                  to_stop_name:     transferStop?.stop_name ?? transferSt.stop_id,
                  depart_time:      fromSt.departure_time.substring(0, 5),
                  depart_iso:       departDate.toISOString(),
                  arrive_time:      transferSt.departure_time.substring(0, 5),
                  arrive_iso:       arrivalAtTransfer.toISOString(),
                  duration_minutes: Math.round((arrivalAtTransfer.getTime() - departDate.getTime()) / 60_000),
                },
                {
                  trip_id:          leg2FromSt.trip_id,
                  route_short_name: route2?.route_short_name ?? trip2.route_id,
                  route_long_name:  route2?.route_long_name  ?? "",
                  headsign:         trip2.trip_headsign,
                  from_stop_id:     transferSt.stop_id,
                  from_stop_name:   transferStop?.stop_name ?? transferSt.stop_id,
                  to_stop_id:       toResolved,
                  to_stop_name:     toStopObj?.stop_name ?? toResolved,
                  depart_time:      leg2FromSt.departure_time.substring(0, 5),
                  depart_iso:       leg2Depart.toISOString(),
                  arrive_time:      toSt.departure_time.substring(0, 5),
                  arrive_iso:       leg2Arrive.toISOString(),
                  duration_minutes: Math.round((leg2Arrive.getTime() - leg2Depart.getTime()) / 60_000),
                },
              ],
            });
            break; // best connecting train found for this transfer stop + leg1 trip
          }
        }
      }

      // Sort by depart_iso so directs and transfers are interleaved by time
      journeys.sort((a, b) => {
        const aIso = (a as { depart_iso: string }).depart_iso;
        const bIso = (b as { depart_iso: string }).depart_iso;
        return aIso < bIso ? -1 : aIso > bIso ? 1 : 0;
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

// ── Trip Stop Times ──────────────────────────────────────────────────────────
// GET /v1/schedule/trip?trip_id=X&date=YYYYMMDD
// Returns the full stop sequence for a specific trip.
router.get("/trip", async (req: Request, res: Response) => {
  const tripId = req.query.trip_id as string;
  const date   = (req.query.date as string) || getTodayStr();

  if (!tripId) {
    return res.status(400).json({ error: "bad_request", message: "trip_id required" });
  }

  try {
    const gtfs       = await ensureGtfs();
    const midnightMs = getMidnightMsForDate(date);

    const trip = gtfs.trips.get(tripId);
    if (!trip) {
      return res.status(404).json({ error: "not_found", message: `Trip ${tripId} not found`, status: 404 });
    }

    const route     = gtfs.routes.get(trip.route_id);
    const tripTimes = gtfs.tripTimesIndex.get(tripId) ?? [];

    const stop_times = tripTimes.map((tst) => {
      const s = gtfs.stops.get(tst.stop_id);
      return {
        stop_id:        tst.stop_id,
        stop_name:      s?.stop_name ?? tst.stop_id,
        stop_sequence:  tst.stop_sequence,
        departure_time: tst.departure_time.substring(0, 5),
        departure_iso:  parseGtfsTime(tst.departure_time, midnightMs).toISOString(),
      };
    });

    return res.json({
      trip_id:          tripId,
      route_short_name: route?.route_short_name ?? trip.route_id,
      route_long_name:  route?.route_long_name  ?? "",
      headsign:         trip.trip_headsign,
      direction_id:     trip.direction_id,
      stop_times,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("[schedule/trip]", message);
    return res.status(502).json({ error: "upstream_error", message });
  }
});

export default router;
