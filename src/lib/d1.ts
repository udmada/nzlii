import type { D1Database } from "@cloudflare/workers-types";
import { Effect } from "effect";
import type { R2Key, ScraperError } from "../types.ts";
import { storageError } from "../types.ts";

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
