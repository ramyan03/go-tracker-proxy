import { Router, Request, Response } from "express";
import { z } from "zod";
import { cacheGet, cacheSet } from "../lib/cache";
import { fetchTripUpdates } from "../lib/gtfsrt";

const router = Router();

// GO Transit Service Guarantee: 15+ min late qualifies for a credit.
// https://www.gotransit.com/en/travelling-with-us/service-guarantee

const CLAIM_URL = "https://www.gotransit.com/en/travelling-with-us/service-guarantee";
const GUARANTEE_THRESHOLD_SECONDS = 15 * 60; // 15 minutes

const QuerySchema = z.object({
  trip_id: z.string().min(1),
});

/**
 * GET /v1/guarantee?trip_id=...
 *
 * Checks if a trip currently qualifies for a GO Service Guarantee claim
 * (delay >= 15 min on final destination arrival). Returns claim link if eligible.
 *
 * V1 note: GTFS-RT provides departure delays per stop. We use the maximum
 * observed delay across stop_time_updates as a proxy for destination delay
 * (since arrival delay at final stop = best available signal from GTFS-RT).
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

  const { trip_id } = parsed.data;
  const CACHE_KEY = `guarantee:${trip_id}`;
  const cached = await cacheGet<object>(CACHE_KEY);
  if (cached) return res.json(cached);

  try {
    const rt = await fetchTripUpdates();
    const tripUpdate = rt.trips.find((t) => t.trip_id === trip_id);

    if (!tripUpdate) {
      return res.json({
        trip_id,
        eligible: false,
        delay_seconds: null,
        reason: "No realtime data for this trip",
        claim_url: null,
      });
    }

    const isCancelled = tripUpdate.schedule_relationship === "cancelled";

    // Max delay across all stop_time_updates (arrival delay at final stop is most relevant)
    const maxDelay = isCancelled
      ? Infinity
      : Math.max(
          0,
          ...tripUpdate.stop_time_updates
            .map((u) => u.arrival_delay ?? u.departure_delay ?? 0)
            .filter((d) => d > 0)
        );

    const eligible = isCancelled || maxDelay >= GUARANTEE_THRESHOLD_SECONDS;

    const result = {
      trip_id,
      route_id:      tripUpdate.route_id,
      eligible,
      delay_seconds: isCancelled ? null : maxDelay === Infinity ? null : maxDelay,
      cancelled:     isCancelled,
      reason: isCancelled
        ? "Trip cancelled — guaranteed refund"
        : eligible
        ? `${Math.round(maxDelay / 60)} min late — qualifies for GO Service Guarantee`
        : `${Math.round(maxDelay / 60)} min late — below 15-min threshold`,
      claim_url: eligible ? CLAIM_URL : null,
    };

    await cacheSet(CACHE_KEY, result, 30_000);
    return res.json(result);
  } catch (err) {
    const message = (err as Error).message ?? "Unknown error";
    console.error("[guarantee]", message);
    return res.status(502).json({ error: "upstream_error", message, status: 502 });
  }
});

export default router;
