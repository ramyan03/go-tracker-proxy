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

export default router;
