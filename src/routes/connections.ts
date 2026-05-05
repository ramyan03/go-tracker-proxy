import { Router, Request, Response } from "express";
import { ensureGtfs } from "../lib/gtfs-static";

const router = Router();

// GET /v1/connections?stop_id=UN
// Returns GTFS transfers from a stop — connecting services a rider can reach.
router.get("/", async (req: Request, res: Response) => {
  const stopId = (req.query.stop_id as string)?.toUpperCase();

  if (!stopId) {
    return res.status(400).json({ error: "bad_request", message: "stop_id required" });
  }

  try {
    const gtfs = await ensureGtfs();
    const stop = gtfs.stops.get(stopId) ?? gtfs.stopsByCode.get(stopId) ?? null;
    const resolvedId = stop?.stop_id ?? stopId;

    const rawTransfers = gtfs.transfers.get(resolvedId) ?? [];

    const connections = rawTransfers
      .filter((t) => t.transfer_type !== 3) // exclude "no transfer possible"
      .slice(0, 8)
      .map((t) => {
        const toStop = gtfs.stops.get(t.to_stop_id);
        return {
          to_stop_id:        t.to_stop_id,
          to_stop_name:      toStop?.stop_name ?? t.to_stop_id,
          transfer_type:     t.transfer_type,
          min_transfer_time: t.min_transfer_time, // seconds; null = immediate
        };
      });

    return res.json({
      stop_id:     resolvedId,
      stop_name:   stop?.stop_name ?? stopId,
      connections,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("[connections]", message);
    return res.status(502).json({ error: "upstream_error", message });
  }
});

// GET /v1/connections/routes?stop_id=MR
// Returns GO bus routes that connect to a given train station via GTFS transfers.
router.get("/routes", async (req: Request, res: Response) => {
  const stopId = (req.query.stop_id as string)?.toUpperCase();

  if (!stopId) {
    return res.status(400).json({ error: "bad_request", message: "stop_id required" });
  }

  try {
    const gtfs = await ensureGtfs();
    const stop = gtfs.stops.get(stopId) ?? gtfs.stopsByCode.get(stopId) ?? null;
    const resolvedId = stop?.stop_id ?? stopId;

    const rawTransfers = gtfs.transfers.get(resolvedId) ?? [];
    const connectedStopIds = rawTransfers
      .filter((t) => t.transfer_type !== 3)
      .map((t) => t.to_stop_id);

    const routesSeen = new Set<string>();
    const connectingRoutes: {
      route_short_name: string;
      route_long_name: string;
      route_type: number;
      route_color: string;
    }[] = [];

    for (const connStopId of connectedStopIds) {
      const times = gtfs.stopTimesIndex.get(connStopId) ?? [];
      for (const st of times) {
        const trip = gtfs.trips.get(st.trip_id);
        if (!trip) continue;
        const route = gtfs.routes.get(trip.route_id);
        if (!route) continue;
        if (routesSeen.has(route.route_short_name)) continue;
        routesSeen.add(route.route_short_name);
        connectingRoutes.push({
          route_short_name: route.route_short_name,
          route_long_name: route.route_long_name,
          route_type: route.route_type,
          route_color: route.route_color,
        });
        if (routesSeen.size >= 20) break;
      }
      if (routesSeen.size >= 20) break;
    }

    connectingRoutes.sort((a, b) => a.route_short_name.localeCompare(b.route_short_name));

    return res.json({
      stop_id:           resolvedId,
      stop_name:         stop?.stop_name ?? stopId,
      connecting_routes: connectingRoutes,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("[connections/routes]", message);
    return res.status(502).json({ error: "upstream_error", message });
  }
});

export default router;
