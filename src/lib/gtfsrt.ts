import { transit_realtime } from "gtfs-realtime-bindings";
import { metrolinxProto } from "./metrolinx";

// Correct GTFS-RT feed paths (confirmed from API docs)
const FEEDS = {
  trips:    "api/V1/Gtfs/Feed/TripUpdates",
  alerts:   "api/V1/Gtfs/Feed/Alerts",
  vehicles: "api/V1/Gtfs/Feed/VehiclePosition",
} as const;

async function decodeFeed(path: string): Promise<transit_realtime.IFeedMessage> {
  const buffer = await metrolinxProto(path);
  return transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

// ── Trip updates ──────────────────────────────────────────────────────────────

export interface StopTimeUpdate {
  stop_id: string;
  stop_sequence: number | null;
  arrival_delay: number | null;
  departure_delay: number | null;
  arrival_time: number | null;
  departure_time: number | null;
  schedule_relationship: string;
}

export interface TripUpdate {
  trip_id: string;
  route_id: string;
  direction_id: number | null;
  schedule_relationship: string;
  stop_time_updates: StopTimeUpdate[];
}

export async function fetchTripUpdates(): Promise<{
  generated_at: string;
  trips: TripUpdate[];
}> {
  const feed = await decodeFeed(FEEDS.trips);
  const generatedAt = tsToIso(feed.header?.timestamp);
  const trips: TripUpdate[] = [];

  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu?.trip) continue;

    const stopTimeUpdates: StopTimeUpdate[] = (tu.stopTimeUpdate ?? []).map(
      (stu) => ({
        stop_id:              stu.stopId ?? "",
        stop_sequence:        stu.stopSequence ?? null,
        arrival_delay:        stu.arrival?.delay ?? null,
        departure_delay:      stu.departure?.delay ?? null,
        arrival_time:         stu.arrival?.time  != null ? Number(stu.arrival.time)  : null,
        departure_time:       stu.departure?.time != null ? Number(stu.departure.time) : null,
        schedule_relationship: stuSchedRel(stu.scheduleRelationship),
      })
    );

    trips.push({
      trip_id:              tu.trip.tripId ?? entity.id ?? "",
      route_id:             tu.trip.routeId ?? "",
      direction_id:         tu.trip.directionId ?? null,
      schedule_relationship: tripSchedRel(tu.trip.scheduleRelationship),
      stop_time_updates:    stopTimeUpdates,
    });
  }

  return { generated_at: generatedAt, trips };
}

// ── Service alerts ────────────────────────────────────────────────────────────

export type AlertSeverity = "minor" | "major" | "cancelled";
export type AlertEffect =
  | "significant_delays"
  | "detour"
  | "no_service"
  | "reduced_service"
  | "modified_service"
  | "stop_moved"
  | "other";

export interface ServiceAlert {
  id: string;
  severity: AlertSeverity;
  effect: AlertEffect;
  affected_routes: string[];
  affected_stops: string[];
  header: string;
  description: string;
  timestamp: string;
}

export async function fetchAlerts(): Promise<{
  generated_at: string;
  alerts: ServiceAlert[];
}> {
  const feed = await decodeFeed(FEEDS.alerts);
  const generatedAt = tsToIso(feed.header?.timestamp);
  const alerts: ServiceAlert[] = [];

  for (const entity of feed.entity ?? []) {
    const a = entity.alert;
    if (!a) continue;

    const affectedRoutes = (a.informedEntity ?? [])
      .map((e) => e.routeId).filter((r): r is string => !!r);
    const affectedStops = (a.informedEntity ?? [])
      .map((e) => e.stopId).filter((s): s is string => !!s);

    const effect = a.effect;
    let severity: AlertSeverity = "minor";
    if (
      effect === transit_realtime.Alert.Effect.NO_SERVICE ||
      effect === transit_realtime.Alert.Effect.STOP_MOVED
    ) {
      severity = "cancelled";
    } else if (
      effect === transit_realtime.Alert.Effect.SIGNIFICANT_DELAYS ||
      effect === transit_realtime.Alert.Effect.REDUCED_SERVICE ||
      effect === transit_realtime.Alert.Effect.DETOUR ||
      effect === transit_realtime.Alert.Effect.MODIFIED_SERVICE
    ) {
      severity = "major";
    }

    const activePeriod = a.activePeriod?.[0];
    const timestamp = activePeriod?.start
      ? new Date(Number(activePeriod.start) * 1000).toISOString()
      : generatedAt;

    alerts.push({
      id:              entity.id ?? "",
      severity,
      effect:          mapEffect(effect),
      affected_routes: [...new Set(affectedRoutes)],
      affected_stops:  [...new Set(affectedStops)],
      header:          translatedText(a.headerText) ?? "",
      description:     translatedText(a.descriptionText) ?? "",
      timestamp,
    });
  }

  return { generated_at: generatedAt, alerts };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tsToIso(ts: number | Long | null | undefined): string {
  if (ts == null) return new Date().toISOString();
  return new Date(Number(ts) * 1000).toISOString();
}

function translatedText(t: transit_realtime.ITranslatedString | null | undefined): string | null {
  if (!t?.translation?.length) return null;
  const en = t.translation.find((tr) => tr.language === "en");
  return (en ?? t.translation[0]).text ?? null;
}

function tripSchedRel(
  rel: transit_realtime.TripDescriptor.ScheduleRelationship | null | undefined
): string {
  switch (rel) {
    case transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED:     return "cancelled";
    case transit_realtime.TripDescriptor.ScheduleRelationship.ADDED:        return "added";
    case transit_realtime.TripDescriptor.ScheduleRelationship.UNSCHEDULED:  return "unscheduled";
    default: return "scheduled";
  }
}

function stuSchedRel(
  rel: transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship | null | undefined
): string {
  switch (rel) {
    case transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED:  return "skipped";
    case transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA:  return "no_data";
    default: return "scheduled";
  }
}

function mapEffect(e: transit_realtime.Alert.Effect | null | undefined): AlertEffect {
  switch (e) {
    case transit_realtime.Alert.Effect.SIGNIFICANT_DELAYS: return "significant_delays";
    case transit_realtime.Alert.Effect.DETOUR:             return "detour";
    case transit_realtime.Alert.Effect.NO_SERVICE:         return "no_service";
    case transit_realtime.Alert.Effect.REDUCED_SERVICE:    return "reduced_service";
    case transit_realtime.Alert.Effect.MODIFIED_SERVICE:   return "modified_service";
    case transit_realtime.Alert.Effect.STOP_MOVED:         return "stop_moved";
    default:                                               return "other";
  }
}

// Long is a protobufjs type used for int64 fields
type Long = { toNumber(): number };
