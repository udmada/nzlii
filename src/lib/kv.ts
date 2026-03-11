import type { KVNamespace } from "@cloudflare/workers-types";
import { Schema } from "effect";

import { CourtsCacheSchema, type Court, type CourtsCache } from "../types.ts";

const COURTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const decodeCache = Schema.decodeUnknownOption(CourtsCacheSchema);

export const getCourts = async (kv: KVNamespace): Promise<readonly Court[] | null> => {
  const raw: unknown = await kv.get("courts", "json");
  const result = decodeCache(raw);
  if (result._tag === "None") return null;
  const cache = result.value;
  if (Date.now() - cache.fetchedAt >= COURTS_CACHE_TTL_MS) return null;
  return cache.courts;
};

export const saveCourts = async (kv: KVNamespace, courts: readonly Court[]): Promise<void> => {
  const cache: CourtsCache = { fetchedAt: Date.now(), courts };
  await kv.put("courts", JSON.stringify(cache));
};

export const isYearDone = async (kv: KVNamespace, court: string, year: number): Promise<boolean> =>
  (await kv.get(`done:${court}:${year}`)) === "1";

export const markYearDone = async (kv: KVNamespace, court: string, year: number): Promise<void> => {
  await kv.put(`done:${court}:${year}`, "1");
};
