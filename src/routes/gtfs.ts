import { Router, Request, Response } from "express";
import fetch from "node-fetch";
import { cacheGet, cacheSet } from "../lib/cache";
import { gtfsEtag, gtfsLoadedAt } from "../lib/gtfs-static";

const router = Router();

const GTFS_ZIP_URL =
  "https://www.gotransit.com/static_files/gotransit/assets/Files/GO_GTFS.zip";

async function fetchGtfsVersion(): Promise<{
  version: string;
  published_date: string;
  etag: string | null;
}> {
  const res = await fetch(GTFS_ZIP_URL, { method: "HEAD" });
  const lastModified = res.headers.get("last-modified");
  const etag = res.headers.get("etag") ?? lastModified ?? null;
  const date = lastModified ? new Date(lastModified) : new Date();
  return {
    version:        date.toISOString().slice(0, 10),
    published_date: date.toISOString(),
    etag,
  };
}

// GET /v1/gtfs/version
// Mobile app calls this on launch to decide if it needs to re-download GTFS.
// Response includes etag so the app can use If-None-Match on /gtfs/download.
router.get("/version", async (_req: Request, res: Response) => {
  const CACHE_KEY = "gtfs:version";
  const cached = await cacheGet<object>(CACHE_KEY);
  if (cached) return res.json(cached);

  try {
    const data = await fetchGtfsVersion();
    await cacheSet(CACHE_KEY, data, 60 * 60_000); // 1 hour
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[gtfs/version]", message);
    res.status(502).json({ error: "upstream_error", message, status: 502 });
  }
});

// GET /v1/gtfs/download
// Streams the GTFS zip to the mobile app.
// Forwards ETag and Last-Modified so the app can cache locally.
// Mobile should send If-None-Match header to avoid re-downloading unchanged zips.
router.get("/download", async (req: Request, res: Response) => {
  try {
    const upstream = await fetch(GTFS_ZIP_URL);
    if (!upstream.ok) {
      return res.status(502).json({
        error:   "upstream_error",
        message: `GTFS zip returned ${upstream.status}`,
        status:  502,
      });
    }

    const contentLength = upstream.headers.get("content-length");
    const lastModified  = upstream.headers.get("last-modified");
    const etag          = upstream.headers.get("etag");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="GO_GTFS.zip"');
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (lastModified)  res.setHeader("Last-Modified", lastModified);
    if (etag)          res.setHeader("ETag", etag);

    upstream.body?.pipe(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[gtfs/download]", message);
    res.status(502).json({ error: "upstream_error", message, status: 502 });
  }
});

// GET /v1/gtfs/status — proxy-internal GTFS static cache state
router.get("/status", (_req: Request, res: Response) => {
  const loadedAt = gtfsLoadedAt();
  const etag = gtfsEtag();
  res.json({
    loaded: loadedAt !== null,
    loaded_at: loadedAt?.toISOString() ?? null,
    etag,
  });
});

export default router;
