import { Redis } from "@upstash/redis";

type MemEntry = { value: unknown; expiresAt: number };
const mem = new Map<string, MemEntry>();

let redis: Redis | null = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log("[cache] Upstash Redis connected");
} else {
  console.log("[cache] No Upstash config — using in-memory cache");
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (redis) {
    try {
      return await redis.get<T>(key);
    } catch (e) {
      console.warn("[cache] Redis get failed, using memory:", (e as Error).message);
    }
  }
  const entry = mem.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    mem.delete(key);
    return null;
  }
  return entry.value as T;
}

export async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  if (redis) {
    try {
      await redis.set(key, value, { px: ttlMs });
      return;
    } catch (e) {
      console.warn("[cache] Redis set failed, using memory:", (e as Error).message);
    }
  }
  mem.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export async function cacheDel(key: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(key);
    } catch {}
  }
  mem.delete(key);
}
