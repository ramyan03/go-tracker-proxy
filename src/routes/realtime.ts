import { Router, Request, Response } from "express";
import { cacheGet, cacheSet } from "../lib/cache";
import { fetchTripUpdates, fetchAlerts } from "../lib/gtfsrt";

const router = Router();

const TTL_TRIPS  = 30_000;
const TTL_ALERTS = 60_000;

// GET /v1/realtime/trips
router.get("/trips", async (_req: Request, res: Response) => {
  const CACHE_KEY = "realtime:trips";
  const cached = await cacheGet<object>(CACHE_KEY);
  if (cached) return res.json(cached);

  try {
    const data = await fetchTripUpdates();
    await cacheSet(CACHE_KEY, data, TTL_TRIPS);
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[realtime/trips]", message);
    res.status(502).json({ error: "upstream_error", message, status: 502 });
  }
});

// GET /v1/realtime/alerts
router.get("/alerts", async (_req: Request, res: Response) => {
  const CACHE_KEY = "realtime:alerts";
  const cached = await cacheGet<object>(CACHE_KEY);
  if (cached) return res.json(cached);

  try {
    const data = await fetchAlerts();
    await cacheSet(CACHE_KEY, data, TTL_ALERTS);
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[realtime/alerts]", message);
    res.status(502).json({ error: "upstream_error", message, status: 502 });
  }
});

export default router;
