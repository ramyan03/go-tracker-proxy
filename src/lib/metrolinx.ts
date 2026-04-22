import fetch from "node-fetch";

const BASE = "https://api.openmetrolinx.com/OpenDataAPI";

function authHeaders(): Record<string, string> {
  const key = process.env.METROLINX_API_KEY;
  if (!key || key === "your_key_here") return {};
  return { "Ocp-Apim-Subscription-Key": key };
}

/** Fetch a Metrolinx REST endpoint and return parsed JSON. */
export async function metrolinxGet<T>(path: string): Promise<T> {
  const url = `${BASE}/${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...authHeaders() },
    // node-fetch v2 timeout via options cast
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
  const url = `${BASE}/${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/x-protobuf",
      ...authHeaders(),
    },
  } as Parameters<typeof fetch>[1]);

  if (!res.ok) {
    throw new Error(
      `Metrolinx GTFS-RT ${res.status} ${res.statusText} — ${path}`
    );
  }
  return res.buffer();
}
