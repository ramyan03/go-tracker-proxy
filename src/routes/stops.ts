import { Router, Request, Response } from "express";
import { ensureGtfs } from "../lib/gtfs-static";

const router = Router();

// GET /v1/stops?query=union&type=train|bus
// Tries GTFS static first, falls back to hardcoded list.
router.get("/", async (req: Request, res: Response) => {
  try {
    const gtfs  = await ensureGtfs();
    let stops   = Array.from(gtfs.stops.values());

    const query = typeof req.query.query === "string" ? req.query.query.toLowerCase() : null;
    const type  = req.query.type as string | undefined;

    if (query) {
      stops = stops.filter(
        (s) =>
          s.stop_name.toLowerCase().includes(query) ||
          s.stop_code.toLowerCase().includes(query)
      );
    }

    // route_type 2 = rail, 3 = bus — filter by which routes serve this stop (approximate via stop_code prefix)
    if (type === "train") {
      // GO train stops tend to have 2-letter codes; buses have numeric codes
      stops = stops.filter((s) => /^[A-Z]{2}$/.test(s.stop_code));
    }

    return res.json(stops);
  } catch {
    // GTFS not yet loaded — return empty so mobile can retry
    return res.json([]);
  }
});

// GET /v1/stops/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const gtfs = await ensureGtfs();
    const id = req.params.id.toUpperCase();
    const stop = gtfs.stops.get(id) ?? gtfs.stopsByCode.get(id) ?? null;
    if (!stop) {
      return res.status(404).json({
        error:   "not_found",
        message: `Stop ${req.params.id} not found`,
        status:  404,
      });
    }
    return res.json(stop);
  } catch {
    return res.status(503).json({
      error:   "gtfs_not_ready",
      message: "GTFS data not yet loaded",
      status:  503,
    });
  }
});

export default router;
