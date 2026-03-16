import type { D1Database } from "@cloudflare/workers-types";
import { Effect } from "effect";

import { type R2Key, type ScraperError, storageError } from "../types.ts";

export type CaseStatus = "pending" | "done" | "error";

export const upsertCase = (
  db: D1Database,
  court: string,
  year: number,
  num: string,
  title: string,
  url: string,
): Effect.Effect<void, ScraperError> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          "INSERT INTO cases (court, year, num, title, url) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(court, year, num, title, url)
        .run(),
    catch: (e) => storageError(e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.map(() => undefined));

export const markDone = (
  db: D1Database,
  court: string,
  year: number,
  num: string,
  r2Key: R2Key,
): Effect.Effect<void, ScraperError> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          "UPDATE cases SET status = ?, r2_key = ?, scraped_at = ? WHERE court = ? AND year = ? AND num = ?",
        )
        .bind("done", r2Key, Date.now(), court, year, num)
        .run(),
    catch: (e) => storageError(e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.map(() => undefined));

export const markError = (
  db: D1Database,
  court: string,
  year: number,
  num: string,
  errorMsg: string,
): Effect.Effect<void, ScraperError> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          "UPDATE cases SET status = ?, error = ?, scraped_at = ? WHERE court = ? AND year = ? AND num = ?",
        )
        .bind("error", errorMsg, Date.now(), court, year, num)
        .run(),
    catch: (e) => storageError(e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.map(() => undefined));

export const queryCases = (
  db: D1Database,
  court: string,
  year: number,
): Effect.Effect<readonly unknown[], ScraperError> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          "SELECT * FROM cases WHERE court = ? AND year = ? ORDER BY CAST(num AS INTEGER) DESC",
        )
        .bind(court, year)
        .all(),
    catch: (e) => storageError(e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.map((r) => r.results));

export type PendingCase = {
  readonly court: string;
  readonly year: number;
  readonly num: string;
  readonly title: string;
  readonly url: string;
};

const isPendingCase = (v: unknown): v is PendingCase =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Record<string, unknown>)["court"] === "string" &&
  typeof (v as Record<string, unknown>)["year"] === "number" &&
  typeof (v as Record<string, unknown>)["num"] === "string" &&
  typeof (v as Record<string, unknown>)["title"] === "string" &&
  typeof (v as Record<string, unknown>)["url"] === "string";

export const queryPendingCases = (
  db: D1Database,
  statuses: readonly CaseStatus[],
): Effect.Effect<readonly PendingCase[], ScraperError> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT court, year, num, title, url FROM cases WHERE status IN (${statuses.map(() => "?").join(",")})`,
        )
        .bind(...statuses)
        .all(),
    catch: (e) => storageError(e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.map((r) => r.results.filter(isPendingCase)));
