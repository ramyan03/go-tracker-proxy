import { z } from "zod";

// ── Departure ─────────────────────────────────────────────────────────────────

export const DepartureSchema = z.object({
  trip_id:             z.string(),
  route_id:            z.string(),
  route_short_name:    z.string(),
  route_long_name:     z.string(),
  headsign:            z.string(),
  direction_id:        z.number().nullable(),
  stop_sequence:       z.number().nullable(),
  scheduled_departure: z.string().datetime(),
  realtime_departure:  z.string().datetime().nullable(),
  delay_seconds:       z.number().nullable(),
  status:              z.enum(["ON_TIME", "DELAYED", "CANCELLED", "SCHEDULED"]),
  vehicle_id:          z.string().nullable(),
  accessible:          z.boolean().optional(),
  platform:            z.string().nullable().optional(),
});

export const DeparturesResponseSchema = z.object({
  stop_id:       z.string(),
  stop_name:     z.string(),
  generated_at:  z.string().datetime(),
  source:        z.enum(["gtfs", "nextservice"]),
  departures:    z.array(DepartureSchema),
});

export type Departure         = z.infer<typeof DepartureSchema>;
export type DeparturesResponse = z.infer<typeof DeparturesResponseSchema>;

// ── Realtime trips ────────────────────────────────────────────────────────────

export const StopTimeUpdateSchema = z.object({
  stop_id:               z.string(),
  stop_sequence:         z.number().nullable(),
  arrival_delay:         z.number().nullable(),
  departure_delay:       z.number().nullable(),
  arrival_time:          z.number().nullable(),
  departure_time:        z.number().nullable(),
  schedule_relationship: z.string(),
});

export const TripUpdateSchema = z.object({
  trip_id:               z.string(),
  route_id:              z.string(),
  direction_id:          z.number().nullable(),
  schedule_relationship: z.string(),
  stop_time_updates:     z.array(StopTimeUpdateSchema),
});

export const TripUpdatesResponseSchema = z.object({
  generated_at: z.string(),
  trips:        z.array(TripUpdateSchema),
});

// ── Alerts ────────────────────────────────────────────────────────────────────

export const AlertSchema = z.object({
  id:              z.string(),
  severity:        z.enum(["minor", "major", "cancelled"]),
  affected_routes: z.array(z.string()),
  affected_stops:  z.array(z.string()),
  header:          z.string(),
  description:     z.string(),
  timestamp:       z.string(),
});

export const AlertsResponseSchema = z.object({
  generated_at: z.string(),
  alerts:       z.array(AlertSchema),
});

// ── Stops ─────────────────────────────────────────────────────────────────────

export const StopSchema = z.object({
  stop_id:              z.string(),
  stop_code:            z.string(),
  stop_name:            z.string(),
  stop_lat:             z.number(),
  stop_lon:             z.number(),
  wheelchair_boarding:  z.number(),
});

// ── Routes ────────────────────────────────────────────────────────────────────

export const RouteSchema = z.object({
  route_id:          z.string(),
  route_short_name:  z.string(),
  route_long_name:   z.string(),
  route_type:        z.number(),
  route_color:       z.string(),
  route_text_color:  z.string(),
});

// ── GTFS version ──────────────────────────────────────────────────────────────

export const GtfsVersionSchema = z.object({
  version:        z.string(),
  published_date: z.string(),
  etag:           z.string().nullable(),
});

// ── Compare (V1) ──────────────────────────────────────────────────────────────

export const CompareQuerySchema = z.object({
  stop_ids:    z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  limit:       z.coerce.number().int().min(1).max(10).default(3),
  drive_time:  z.coerce.number().int().min(0).optional(), // seconds
});

export const CompareStationSchema = z.object({
  stop_id:        z.string(),
  stop_name:      z.string(),
  drive_seconds:  z.number().nullable(),
  departures:     z.array(DepartureSchema),
  next_viable:    DepartureSchema.nullable(), // first departure you can catch given drive time
});

export const CompareResponseSchema = z.object({
  generated_at: z.string().datetime(),
  stations:     z.array(CompareStationSchema),
});

export type CompareStation  = z.infer<typeof CompareStationSchema>;
export type CompareResponse = z.infer<typeof CompareResponseSchema>;
