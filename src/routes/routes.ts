import { Router, Request, Response } from "express";
import { ensureGtfs } from "../lib/gtfs-static";

const router = Router();

// GET /v1/routes?type=train|bus
router.get("/", async (req: Request, res: Response) => {
  try {
    const gtfs = await ensureGtfs();
    let routes = Array.from(gtfs.routes.values());

    const type = req.query.type as string | undefined;
    if (type === "train") routes = routes.filter((r) => r.route_type === 2);
    if (type === "bus")   routes = routes.filter((r) => r.route_type === 3);

    // Deduplicate by route_short_name — route_id has a date prefix so multiple entries exist
    const seen = new Set<string>();
    routes = routes.filter((r) => {
      if (seen.has(r.route_short_name)) return false;
      seen.add(r.route_short_name);
      return true;
    });

    return res.json(routes);
  } catch {
    return res.json(FALLBACK_ROUTES.filter((r) => {
      if (req.query.type === "train") return r.route_type === 2;
      if (req.query.type === "bus")   return r.route_type === 3;
      return true;
    }));
  }
});

// GET /v1/routes/:short_name/stops
// Returns ordered stops with coordinates for both directions of a route.
router.get("/:short_name/stops", async (req: Request, res: Response) => {
  try {
    const shortName = req.params.short_name.toUpperCase();
    const gtfs = await ensureGtfs();

    // Find the canonical route entry
    const route = Array.from(gtfs.routes.values()).find(
      (r) => r.route_short_name === shortName
    );
    if (!route) return res.status(404).json({ error: "Route not found" });

    // Collect all trips for this route short name
    const routeTrips = Array.from(gtfs.trips.values()).filter((t) => {
      const r = gtfs.routes.get(t.route_id);
      return r?.route_short_name === shortName;
    });

    if (!routeTrips.length) return res.status(404).json({ error: "No trips for route" });

    // For each direction pick the trip with the most stops (most representative)
    const directions: Record<number, {
      headsign: string;
      stops: {
        stop_id: string;
        stop_name: string;
        stop_lat: number;
        stop_lon: number;
        stop_sequence: number;
        departure_time: string;
      }[];
    }> = {};

    for (const dir of [0, 1]) {
      const dirTrips = routeTrips.filter((t) => t.direction_id === dir);
      let bestTripId: string | null = null;
      let bestCount = 0;

      for (const trip of dirTrips) {
        const times = gtfs.tripTimesIndex.get(trip.trip_id);
        if (times && times.length > bestCount) {
          bestCount = times.length;
          bestTripId = trip.trip_id;
        }
      }

      if (!bestTripId) continue;

      const times = gtfs.tripTimesIndex.get(bestTripId)!;
      const trip = gtfs.trips.get(bestTripId)!;

      directions[dir] = {
        headsign: trip.trip_headsign,
        stops: times.map((st) => {
          const stop = gtfs.stops.get(st.stop_id);
          return {
            stop_id: st.stop_id,
            stop_name: stop?.stop_name ?? st.stop_id,
            stop_lat: stop?.stop_lat ?? 0,
            stop_lon: stop?.stop_lon ?? 0,
            stop_sequence: st.stop_sequence,
            departure_time: st.departure_time,
          };
        }),
      };
    }

    return res.json({
      route_short_name: shortName,
      route_long_name: route.route_long_name,
      route_color: route.route_color,
      route_type: route.route_type,
      directions,
    });
  } catch (err) {
    return res.status(500).json({ error: "internal_error" });
  }
});

const FALLBACK_ROUTES = [
  { route_id: "LW", route_short_name: "LW", route_long_name: "Lakeshore West",      route_type: 2, route_color: "009BC9", route_text_color: "FFFFFF" },
  { route_id: "LE", route_short_name: "LE", route_long_name: "Lakeshore East",      route_type: 2, route_color: "EE3124", route_text_color: "FFFFFF" },
  { route_id: "ST", route_short_name: "ST", route_long_name: "Stouffville",         route_type: 2, route_color: "794500", route_text_color: "FFFFFF" },
  { route_id: "BR", route_short_name: "BR", route_long_name: "Barrie",              route_type: 2, route_color: "69B143", route_text_color: "FFFFFF" },
  { route_id: "RH", route_short_name: "RH", route_long_name: "Richmond Hill",       route_type: 2, route_color: "00853F", route_text_color: "FFFFFF" },
  { route_id: "KI", route_short_name: "KI", route_long_name: "Kitchener",           route_type: 2, route_color: "F5A623", route_text_color: "000000" },
  { route_id: "MI", route_short_name: "MI", route_long_name: "Milton",              route_type: 2, route_color: "0070C0", route_text_color: "FFFFFF" },
];

export default router;
