import fetch from "node-fetch";

const BASE = "https://api.openmetrolinx.com/OpenDataAPI";

function withKey(path: string): string {
  const key = process.env.METROLINX_API_KEY;
  if (!key || key === "your_key_here") return `${BASE}/${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE}/${path}${sep}key=${key}`;
}

/** Fetch a Metrolinx REST endpoint and return parsed JSON. */
export async function metrolinxGet<T>(path: string): Promise<T> {
  const url = withKey(path);
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  } as Parameters<typeof fetch>[1]);

  if (!res.ok) {
    throw new Error(
      `Metrolinx API ${res.status} ${res.statusText} — ${path}`
    );
  }
  return res.json() as Promise<T>;
}

/** Fetch a Metrolinx GTFS-RT feed and return the raw buffer. */
export async function metrolinxProto(path: string): Promise<Buffer> {
  const url = withKey(path);
  const res = await fetch(url, {
    headers: { Accept: "application/x-protobuf" },
  } as Parameters<typeof fetch>[1]);

  if (!res.ok) {
    throw new Error(
      `Metrolinx GTFS-RT ${res.status} ${res.statusText} — ${path}`
    );
  }
  return res.buffer();
}
