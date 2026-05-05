import { Router, Request, Response } from "express";
import { ensureGtfs } from "../lib/gtfs-static";

const router = Router();

function resolveStopId(gtfs: Awaited<ReturnType<typeof ensureGtfs>>, raw: string): string | null {
  const upper = raw.toUpperCase();
  return gtfs.stops.get(upper)?.stop_id ?? gtfs.stopsByCode.get(upper)?.stop_id ?? null;
}

function lookupFare(
  gtfs: Awaited<ReturnType<typeof ensureGtfs>>,
  fromId: string,
  toId: string
): number | null {
  const fromZone = gtfs.stops.get(fromId)?.zone_id;
  const toZone   = gtfs.stops.get(toId)?.zone_id;
  if (!fromZone || !toZone) return null;
  return gtfs.fares.get(`${fromZone}-${toZone}`) ?? null;
}

// GET /v1/fares?from=UN&to=UI
router.get("/", async (req: Request, res: Response) => {
  const fromRaw = req.query.from as string;
  const toRaw   = req.query.to   as string;

  if (!fromRaw || !toRaw) {
    return res.status(400).json({ error: "bad_request", message: "from and to required" });
  }

  try {
    const gtfs   = await ensureGtfs();
    const fromId = resolveStopId(gtfs, fromRaw);
    const toId   = resolveStopId(gtfs, toRaw);

    if (!fromId) return res.status(404).json({ error: "not_found", message: `Stop not found: ${fromRaw}` });
    if (!toId)   return res.status(404).json({ error: "not_found", message: `Stop not found: ${toRaw}` });

    const fare = lookupFare(gtfs, fromId, toId);

    return res.json({
      from_stop_id: fromId,
      to_stop_id:   toId,
      fare,
      currency: "CAD",
      payment: "eticket",
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("[fares]", message);
    return res.status(502).json({ error: "upstream_error", message });
  }
});

// GET /v1/fares/bulk?from=UN&stop_ids=UI,MR,MJ,ST
router.get("/bulk", async (req: Request, res: Response) => {
  const fromRaw    = req.query.from      as string;
  const stopIdsRaw = req.query.stop_ids  as string;

  if (!fromRaw || !stopIdsRaw) {
    return res.status(400).json({ error: "bad_request", message: "from and stop_ids required" });
  }

  try {
    const gtfs   = await ensureGtfs();
    const fromId = resolveStopId(gtfs, fromRaw);
    if (!fromId) return res.status(404).json({ error: "not_found", message: `Stop not found: ${fromRaw}` });

    const stopIds = stopIdsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const fares: Record<string, number | null> = {};

    for (const rawId of stopIds) {
      const toId = resolveStopId(gtfs, rawId);
      fares[rawId] = toId ? lookupFare(gtfs, fromId, toId) : null;
    }

    return res.json({ from_stop_id: fromId, fares, currency: "CAD", payment: "eticket" });
  } catch (err) {
    const message = (err as Error).message;
    console.error("[fares/bulk]", message);
    return res.status(502).json({ error: "upstream_error", message });
  }
});

export default router;
