import fetch from "node-fetch";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GtfsStop {
  stop_id: string;
  stop_code: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  wheelchair_boarding: number;
}

export interface GtfsRoute {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: number;
  route_color: string;
  route_text_color: string;
}

export interface GtfsTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
  trip_headsign: string;
  direction_id: number;
  shape_id: string;
}

export interface GtfsStopTime {
  trip_id: string;
  departure_time: string; // "HH:MM:SS" — hours can exceed 23
  stop_id: string;
  stop_sequence: number;
}

export interface GtfsCalendar {
  service_id: string;
  days: boolean[]; // [sun, mon, tue, wed, thu, fri, sat]
  start_date: string; // "YYYYMMDD"
  end_date: string;
}

export interface GtfsData {
  etag: string | null;
  loadedAt: Date;
  stops: Map<string, GtfsStop>;          // stop_id → Stop
  stopsByCode: Map<string, GtfsStop>;    // stop_code → Stop
  routes: Map<string, GtfsRoute>;        // route_id → Route
  trips: Map<string, GtfsTrip>;          // trip_id → Trip
  stopTimesIndex: Map<string, GtfsStopTime[]>; // stop_id → sorted stop times
  tripTimesIndex: Map<string, GtfsStopTime[]>; // trip_id → stop times sorted by sequence
  calendar: Map<string, GtfsCalendar>;   // service_id → Calendar
  calendarDates: Map<string, { date: string; exceptionType: 1 | 2 }[]>; // service_id → []
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const GTFS_ZIP_URL =
  "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip";
const REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

let data: GtfsData | null = null;
let currentEtag: string | null = null;
let lastLoaded = 0;
let inflightLoad: Promise<void> | null = null;

export async function ensureGtfs(): Promise<GtfsData> {
  if (data && Date.now() - lastLoaded < REFRESH_MS) return data;
  if (inflightLoad) {
    await inflightLoad;
    return data!;
  }
  inflightLoad = loadGtfs().finally(() => {
    inflightLoad = null;
  });
  await inflightLoad;
  return data!;
}

export function gtfsLoadedAt(): Date | null {
  return data?.loadedAt ?? null;
}

export function gtfsEtag(): string | null {
  return currentEtag;
}

// ── Loader ────────────────────────────────────────────────────────────────────

async function loadGtfs(): Promise<void> {
  const localDir = process.env.GTFS_DATA_DIR;

  if (localDir) {
    console.log(`[gtfs-static] Loading from local directory: ${localDir}`);
    parseFromDirectory(localDir);
    return;
  }

  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; GOTrackerProxy/1.0)",
    "Accept": "application/zip, application/octet-stream, */*",
  };

  // Cheap HEAD check first — avoid re-downloading if unchanged
  try {
    const headRes = await fetch(GTFS_ZIP_URL, { method: "HEAD", headers: HEADERS });
    const newEtag =
      headRes.headers.get("etag") ?? headRes.headers.get("last-modified");
    if (newEtag && newEtag === currentEtag && data) {
      lastLoaded = Date.now();
      console.log("[gtfs-static] ETag unchanged — skipping re-parse");
      return;
    }
    currentEtag = newEtag;
  } catch {
    // HEAD failed — try full download anyway
  }

  console.log("[gtfs-static] Downloading GTFS zip…");
  const res = await fetch(GTFS_ZIP_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status} ${res.statusText}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new Error(`GTFS download returned HTML — URL may be blocked or changed`);
  }

  const buf = await res.buffer();
  console.log(`[gtfs-static] Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB — parsing…`);

  const zip = new AdmZip(buf);

  const stops = parseStops(zip);
  const routes = parseRoutes(zip);
  const trips = parseTrips(zip);
  const { calendar, calendarDates } = parseCalendarFiles(zip);

  // Train stop_ids are 2–3 char codes (UN, MK, OA, etc.). Filtering stop_times
  // to these ~70 stations drops memory from ~400 MB to ~50 MB on Railway.
  const trainStopIds = new Set<string>();
  for (const stop of stops.values()) {
    if (stop.stop_id.length <= 3) trainStopIds.add(stop.stop_id);
  }

  // For bus routes: pick one representative trip per route+direction so that
  // route-detail can show stop sequences. ~130 trips × ~25 stops = negligible memory.
  const busRepTripIds = new Set<string>();
  {
    const seen = new Map<string, Set<number>>();
    for (const trip of trips.values()) {
      const route = routes.get(trip.route_id);
      if (!route || route.route_type !== 3) continue;
      if (!seen.has(route.route_short_name)) seen.set(route.route_short_name, new Set());
      const dirs = seen.get(route.route_short_name)!;
      if (!dirs.has(trip.direction_id)) {
        dirs.add(trip.direction_id);
        busRepTripIds.add(trip.trip_id);
      }
    }
  }

  const stopTimesEntry = zip.getEntry("stop_times.txt");
  const stopTimesIndex = stopTimesEntry
    ? parseStopTimesFromBuffer(stopTimesEntry.getData(), trainStopIds)
    : new Map<string, GtfsStopTime[]>();

  const tripTimesIndex = buildTripTimesIndex(stopTimesIndex);

  // Merge bus representative trip stop sequences into tripTimesIndex
  if (stopTimesEntry && busRepTripIds.size > 0) {
    const busTrips = parseBusRepTripTimes(stopTimesEntry.getData(), busRepTripIds);
    for (const [tripId, times] of busTrips) {
      tripTimesIndex.set(tripId, times);
    }
  }

  data = {
    etag: currentEtag,
    loadedAt: new Date(),
    stops,
    stopsByCode: buildStopsByCode(stops),
    routes,
    trips,
    stopTimesIndex,
    tripTimesIndex,
    calendar,
    calendarDates,
  };
  lastLoaded = Date.now();

  console.log(
    `[gtfs-static] Ready — ${stops.size} stops, ${routes.size} routes, ` +
    `${trips.size} trips, ${stopTimesIndex.size} stops with times`
  );
}

function parseFromDirectory(dir: string): void {
  const read = (name: string): string | null => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  };

  const getEntryTextFromDir = (name: string) => read(name);

  const stops = parseStopsFromText(getEntryTextFromDir("stops.txt"));
  const routes = parseRoutesFromText(getEntryTextFromDir("routes.txt"));
  const trips = parseTripsFromText(getEntryTextFromDir("trips.txt"));
  const { calendar, calendarDates } = parseCalendarFilesFromText(
    getEntryTextFromDir("calendar.txt"),
    getEntryTextFromDir("calendar_dates.txt")
  );
  const stopTimesIndex = parseStopTimesFromText(getEntryTextFromDir("stop_times.txt"));

  const tripTimesIndex = buildTripTimesIndex(stopTimesIndex);

  data = {
    etag: null,
    loadedAt: new Date(),
    stops,
    stopsByCode: buildStopsByCode(stops),
    routes,
    trips,
    stopTimesIndex,
    tripTimesIndex,
    calendar,
    calendarDates,
  };
  lastLoaded = Date.now();

  console.log(
    `[gtfs-static] Ready (local) — ${stops.size} stops, ${routes.size} routes, ` +
    `${trips.size} trips, ${stopTimesIndex.size} stops with times`
  );
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function getEntryText(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  return entry.getData().toString("utf8");
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let inQuote = false;
  let cur = "";
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === "," && !inQuote) { result.push(cur); cur = ""; continue; }
    cur += ch;
  }
  result.push(cur);
  return result;
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r/g, "").split("\n");
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => {
      const vals = parseCSVLine(l);
      const row: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        row[headers[i]] = (vals[i] ?? "").trim();
      }
      return row;
    });
}

function parseStops(zip: AdmZip): Map<string, GtfsStop> {
  return parseStopsFromText(getEntryText(zip, "stops.txt"));
}

export function parseStopsFromText(text: string | null): Map<string, GtfsStop> {
  if (!text) return new Map();
  const map = new Map<string, GtfsStop>();
  // Strip BOM if present
  const clean = text.replace(/^\uFEFF/, "");
  for (const row of parseCSV(clean)) {
    if (!row.stop_id) continue;
    map.set(row.stop_id, {
      stop_id: row.stop_id,
      stop_code: row.stop_code?.trim() || row.stop_id,
      stop_name: row.stop_name ?? "",
      stop_lat: parseFloat(row.stop_lat) || 0,
      stop_lon: parseFloat(row.stop_lon) || 0,
      wheelchair_boarding: parseInt(row.wheelchair_boarding) || 0,
    });
  }
  return map;
}

function buildStopsByCode(stops: Map<string, GtfsStop>): Map<string, GtfsStop> {
  const map = new Map<string, GtfsStop>();
  for (const stop of stops.values()) {
    if (stop.stop_code && stop.stop_code !== stop.stop_id) {
      map.set(stop.stop_code, stop);
    }
  }
  return map;
}

function parseRoutes(zip: AdmZip): Map<string, GtfsRoute> {
  return parseRoutesFromText(getEntryText(zip, "routes.txt"));
}

export function parseRoutesFromText(text: string | null): Map<string, GtfsRoute> {
  if (!text) return new Map();
  const map = new Map<string, GtfsRoute>();
  const clean = text.replace(/^\uFEFF/, "");
  for (const row of parseCSV(clean)) {
    if (!row.route_id) continue;
    map.set(row.route_id, {
      route_id: row.route_id,
      route_short_name: row.route_short_name ?? "",
      route_long_name: row.route_long_name ?? "",
      route_type: parseInt(row.route_type) || 3,
      route_color: row.route_color ?? "",
      route_text_color: row.route_text_color ?? "",
    });
  }
  return map;
}

function parseTrips(zip: AdmZip): Map<string, GtfsTrip> {
  return parseTripsFromText(getEntryText(zip, "trips.txt"));
}

export function parseTripsFromText(text: string | null): Map<string, GtfsTrip> {
  if (!text) return new Map();
  const map = new Map<string, GtfsTrip>();
  const clean = text.replace(/^\uFEFF/, "");
  for (const row of parseCSV(clean)) {
    if (!row.trip_id) continue;
    map.set(row.trip_id, {
      trip_id: row.trip_id,
      route_id: row.route_id ?? "",
      service_id: row.service_id ?? "",
      trip_headsign: row.trip_headsign ?? "",
      direction_id: parseInt(row.direction_id) || 0,
      shape_id: row.shape_id ?? "",
    });
  }
  return map;
}

function parseCalendarFiles(zip: AdmZip): {
  calendar: Map<string, GtfsCalendar>;
  calendarDates: Map<string, { date: string; exceptionType: 1 | 2 }[]>;
} {
  return parseCalendarFilesFromText(
    getEntryText(zip, "calendar.txt"),
    getEntryText(zip, "calendar_dates.txt")
  );
}

export function parseCalendarFilesFromText(
  calText: string | null,
  datesText: string | null
): {
  calendar: Map<string, GtfsCalendar>;
  calendarDates: Map<string, { date: string; exceptionType: 1 | 2 }[]>;
} {
  const calendar = new Map<string, GtfsCalendar>();
  const calendarDates = new Map<string, { date: string; exceptionType: 1 | 2 }[]>();

  if (calText) {
    for (const row of parseCSV(calText.replace(/^\uFEFF/, ""))) {
      if (!row.service_id) continue;
      calendar.set(row.service_id, {
        service_id: row.service_id,
        days: [
          row.sunday === "1",
          row.monday === "1",
          row.tuesday === "1",
          row.wednesday === "1",
          row.thursday === "1",
          row.friday === "1",
          row.saturday === "1",
        ],
        start_date: row.start_date ?? "",
        end_date: row.end_date ?? "",
      });
    }
  }

  if (datesText) {
    for (const row of parseCSV(datesText.replace(/^\uFEFF/, ""))) {
      if (!row.service_id) continue;
      const existing = calendarDates.get(row.service_id) ?? [];
      existing.push({
        date: row.date,
        exceptionType: (parseInt(row.exception_type) as 1 | 2) || 1,
      });
      calendarDates.set(row.service_id, existing);
    }
  }

  return { calendar, calendarDates };
}

function parseStopTimes(zip: AdmZip): Map<string, GtfsStopTime[]> {
  return parseStopTimesFromText(getEntryText(zip, "stop_times.txt"));
}

// Buffer-based parser: processes stop_times.txt line-by-line without allocating
// a full decompressed string or lines array — critical for Railway's 512 MB limit.
function parseStopTimesFromBuffer(buf: Buffer, allowedStopIds: Set<string>): Map<string, GtfsStopTime[]> {
  const index = new Map<string, GtfsStopTime[]>();

  let pos = (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0;
  let lineStart = pos;
  let isHeader = true;
  let iTrip = -1, iDep = -1, iStop = -1, iSeq = -1;

  while (pos <= buf.length) {
    if (pos === buf.length || buf[pos] === 0x0A) {
      const end = (pos > lineStart && buf[pos - 1] === 0x0D) ? pos - 1 : pos;
      if (end > lineStart) {
        const line = buf.slice(lineStart, end).toString("utf8");
        if (isHeader) {
          const headers = parseCSVLine(line).map((h) => h.trim());
          iTrip = headers.indexOf("trip_id");
          iDep  = headers.indexOf("departure_time");
          iStop = headers.indexOf("stop_id");
          iSeq  = headers.indexOf("stop_sequence");
          isHeader = false;
        } else {
          const vals = parseCSVLine(line);
          const stopId = (vals[iStop] ?? "").trim();
          if (stopId && allowedStopIds.has(stopId)) {
            const st: GtfsStopTime = {
              trip_id:        (vals[iTrip] ?? "").trim(),
              departure_time: (vals[iDep]  ?? "").trim(),
              stop_id:        stopId,
              stop_sequence:  parseInt(vals[iSeq] ?? "0") || 0,
            };
            const bucket = index.get(stopId);
            if (bucket) bucket.push(st);
            else index.set(stopId, [st]);
          }
        }
      }
      lineStart = pos + 1;
    }
    pos++;
  }

  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.departure_time.localeCompare(b.departure_time));
  }

  return index;
}

// Scans stop_times.txt for a specific set of trip_ids, indexed by trip_id.
// Used to load bus representative trip sequences without inflating memory.
function parseBusRepTripTimes(buf: Buffer, allowedTripIds: Set<string>): Map<string, GtfsStopTime[]> {
  const index = new Map<string, GtfsStopTime[]>();

  let pos = (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0;
  let lineStart = pos;
  let isHeader = true;
  let iTrip = -1, iDep = -1, iStop = -1, iSeq = -1;

  while (pos <= buf.length) {
    if (pos === buf.length || buf[pos] === 0x0A) {
      const end = (pos > lineStart && buf[pos - 1] === 0x0D) ? pos - 1 : pos;
      if (end > lineStart) {
        const line = buf.slice(lineStart, end).toString("utf8");
        if (isHeader) {
          const headers = parseCSVLine(line).map((h) => h.trim());
          iTrip = headers.indexOf("trip_id");
          iDep  = headers.indexOf("departure_time");
          iStop = headers.indexOf("stop_id");
          iSeq  = headers.indexOf("stop_sequence");
          isHeader = false;
        } else {
          const vals = parseCSVLine(line);
          const tripId = (vals[iTrip] ?? "").trim();
          if (tripId && allowedTripIds.has(tripId)) {
            const st: GtfsStopTime = {
              trip_id:        tripId,
              departure_time: (vals[iDep]  ?? "").trim(),
              stop_id:        (vals[iStop] ?? "").trim(),
              stop_sequence:  parseInt(vals[iSeq] ?? "0") || 0,
            };
            const bucket = index.get(tripId);
            if (bucket) bucket.push(st);
            else index.set(tripId, [st]);
          }
        }
      }
      lineStart = pos + 1;
    }
    pos++;
  }

  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.stop_sequence - b.stop_sequence);
  }

  return index;
}

export function parseStopTimesFromText(text: string | null): Map<string, GtfsStopTime[]> {
  if (!text) return new Map();

  const index = new Map<string, GtfsStopTime[]>();
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  if (!lines.length) return index;

  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const iTrip = col("trip_id");
  const iDep  = col("departure_time");
  const iStop = col("stop_id");
  const iSeq  = col("stop_sequence");

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const vals = parseCSVLine(line);
    const stopId = (vals[iStop] ?? "").trim();
    if (!stopId) continue;

    const st: GtfsStopTime = {
      trip_id:        (vals[iTrip] ?? "").trim(),
      departure_time: (vals[iDep]  ?? "").trim(),
      stop_id:        stopId,
      stop_sequence:  parseInt(vals[iSeq] ?? "0") || 0,
    };

    const bucket = index.get(stopId);
    if (bucket) {
      bucket.push(st);
    } else {
      index.set(stopId, [st]);
    }
  }

  // Sort each bucket by departure_time (lexicographic works for HH:MM:SS)
  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.departure_time.localeCompare(b.departure_time));
  }

  return index;
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

/** Returns active service_ids for a given date string ("YYYYMMDD") and day-of-week index (0=Sun). */
export function getActiveServiceIds(
  gtfs: GtfsData,
  dateStr: string,  // "YYYYMMDD"
  dayOfWeek: number // 0=Sun, 1=Mon, ... 6=Sat
): Set<string> {
  const active = new Set<string>();

  for (const svc of gtfs.calendar.values()) {
    if (dateStr >= svc.start_date && dateStr <= svc.end_date && svc.days[dayOfWeek]) {
      active.add(svc.service_id);
    }
  }

  for (const [serviceId, exceptions] of gtfs.calendarDates) {
    for (const ex of exceptions) {
      if (ex.date === dateStr) {
        if (ex.exceptionType === 1) active.add(serviceId);
        else active.delete(serviceId);
      }
    }
  }

  return active;
}

/** Parse "HH:MM:SS" GTFS time, adding to the service-day midnight Date.
 *  Hours > 23 are intentional (next-calendar-day trips). */
export function parseGtfsTime(timeStr: string, midnightMs: number): Date {
  const parts = timeStr.split(":");
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  const s = parseInt(parts[2]) || 0;
  return new Date(midnightMs + (h * 3600 + m * 60 + s) * 1000);
}

/** Midnight of today in Toronto time, as a Unix ms timestamp. */
export function getTorontoMidnightMs(): number {
  const now = new Date();
  // Format today's date in Toronto timezone
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "YYYY-MM-DD"

  const [y, mo, d] = dateStr.split("-").map(Number);

  // Find the UTC timestamp that equals midnight in Toronto.
  // Toronto is UTC-4 (EDT) or UTC-5 (EST) — try both and pick whichever
  // produces hour=0 when displayed in the Toronto timezone.
  for (const offsetH of [4, 5]) {
    const candidateMs = Date.UTC(y, mo - 1, d, offsetH, 0, 0, 0);
    const h = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Toronto",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date(candidateMs))
    );
    if (h === 0) return candidateMs;
  }
  // Fallback: EDT
  return Date.UTC(y, mo - 1, d, 4, 0, 0, 0);
}

/** Get YYYYMMDD string for today in Toronto time. */
export function getTodayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replace(/-/g, "");
}

/** Get day-of-week (0=Sun…6=Sat) for today in Toronto time. */
export function getTodayDow(): number {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    weekday: "short",
  }).format(new Date()); // "Mon", "Tue", etc.
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[day] ?? 0;
}

/** Midnight of any YYYYMMDD date in Toronto time, as a Unix ms timestamp. */
export function getMidnightMsForDate(dateStr: string): number {
  const y  = parseInt(dateStr.substring(0, 4));
  const mo = parseInt(dateStr.substring(4, 6));
  const d  = parseInt(dateStr.substring(6, 8));
  for (const offsetH of [4, 5]) {
    const candidateMs = Date.UTC(y, mo - 1, d, offsetH, 0, 0, 0);
    const h = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Toronto",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date(candidateMs))
    );
    if (h === 0) return candidateMs;
  }
  return Date.UTC(y, mo - 1, d, 4, 0, 0, 0);
}

/** Day-of-week (0=Sun…6=Sat) for any YYYYMMDD date in Toronto time. */
export function getDowForDate(dateStr: string): number {
  const midMs = getMidnightMsForDate(dateStr);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    weekday: "short",
  }).format(new Date(midMs + 3_600_000)); // 1h past midnight to avoid edge cases
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[day] ?? 0;
}

/** Build trip_id → GtfsStopTime[] index from the stop_id index (shared object references). */
function buildTripTimesIndex(
  stopTimesIndex: Map<string, GtfsStopTime[]>
): Map<string, GtfsStopTime[]> {
  const index = new Map<string, GtfsStopTime[]>();
  for (const times of stopTimesIndex.values()) {
    for (const st of times) {
      const bucket = index.get(st.trip_id);
      if (bucket) {
        bucket.push(st);
      } else {
        index.set(st.trip_id, [st]);
      }
    }
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.stop_sequence - b.stop_sequence);
  }
  return index;
}
