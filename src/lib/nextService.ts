import { metrolinxGet } from "./metrolinx";

// Metrolinx REST APIs always return HTTP 200.
// Errors are indicated in Metadata.ErrorCode.
interface MetrolinxEnvelope {
  Metadata: {
    TimeStamp: string;
    ErrorCode: string;   // "200" = ok, "401" = unauthorised, etc.
    ErrorMessage: string;
  };
}

interface RawNextServiceResponse extends MetrolinxEnvelope {
  NextService: RawNextServiceData | null;
}

interface RawNextServiceData {
  // Discovered shape — may be wrapped in a Lines array or flat
  // We handle both possibilities defensively.
  Lines?: RawLine[];
  Line?:  RawLine | RawLine[];
}

interface RawLine {
  LineCode?:    string;
  LineName?:    string;
  DirectionCode?: string;
  Services?:    RawService | RawService[];
  Service?:     RawService | RawService[];
}

interface RawService {
  TripNumber?:          string;
  DestinationCode?:     string;
  DestinationName?:     string;
  ScheduledDeparture?:  string;  // "HH:MM"
  ActualDeparture?:     string;  // "HH:MM"
  Delay?:               number;  // minutes (positive = late)
  Platform?:            string;
  VehicleType?:         string;  // "Train" | "Bus"
  Cancelled?:           boolean | string;
  Accessible?:          boolean | string;
}

export interface NextServiceDeparture {
  trip_id:       string;
  route_id:      string;
  route_name:    string;
  headsign:      string;
  scheduled:     string;
  realtime:      string | null;
  delay_minutes: number;
  platform:      string | null;
  status:        "on_time" | "delayed" | "cancelled";
  vehicle_type:  "train" | "bus";
  accessible:    boolean;
}

function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function isTruthy(v: boolean | string | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  return v.toLowerCase() === "true" || v === "1";
}

export async function fetchNextService(stopCode: string): Promise<{
  generated_at: string;
  stop_id:      string;
  departures:   NextServiceDeparture[];
}> {
  const raw = await metrolinxGet<RawNextServiceResponse>(
    `api/V1/Stop/NextService/${encodeURIComponent(stopCode)}.json`
  );

  const generatedAt = new Date().toISOString();

  if (raw.Metadata.ErrorCode !== "200") {
    throw new Error(
      `Metrolinx API error ${raw.Metadata.ErrorCode}: ${raw.Metadata.ErrorMessage}`
    );
  }

  if (!raw.NextService) {
    return { generated_at: generatedAt, stop_id: stopCode, departures: [] };
  }

  // Flatten lines → services
  const lines = toArray(raw.NextService.Lines ?? raw.NextService.Line);
  const departures: NextServiceDeparture[] = [];

  for (const line of lines) {
    const services = toArray(line.Services ?? line.Service);
    for (const s of services) {
      const delayMinutes = s.Delay ?? 0;
      let status: NextServiceDeparture["status"] = "on_time";
      if (isTruthy(s.Cancelled)) status = "cancelled";
      else if (delayMinutes >= 2) status = "delayed";

      departures.push({
        trip_id:       s.TripNumber    ?? "",
        route_id:      line.LineCode   ?? "",
        route_name:    line.LineName   ?? line.LineCode ?? "",
        headsign:      s.DestinationName ?? "",
        scheduled:     s.ScheduledDeparture ?? "--:--",
        realtime:      s.ActualDeparture ?? null,
        delay_minutes: delayMinutes,
        platform:      s.Platform ?? null,
        status,
        vehicle_type:  s.VehicleType?.toLowerCase() === "bus" ? "bus" : "train",
        accessible:    isTruthy(s.Accessible),
      });
    }
  }

  // Sort by scheduled departure time ascending
  departures.sort((a, b) => a.scheduled.localeCompare(b.scheduled));

  return { generated_at: generatedAt, stop_id: stopCode, departures };
}
