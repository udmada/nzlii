import type {
  D1Database,
  DurableObjectNamespace,
  KVNamespace,
  Queue,
  R2Bucket,
} from "@cloudflare/workers-types";
import { Schema } from "effect";

import type { RateLimiterDO } from "./objects/rate-limiter.ts";

// ---------------------------------------------------------------------------
// Domain schemas + types
// ---------------------------------------------------------------------------

export const CourtSchema = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
});
export type Court = typeof CourtSchema.Type;

export const CaseLinkSchema = Schema.Struct({
  num: Schema.String,
  title: Schema.String,
  url: Schema.String,
});
export type CaseLink = typeof CaseLinkSchema.Type;

export const CourtsCacheSchema = Schema.Struct({
  fetchedAt: Schema.Number,
  courts: Schema.Array(CourtSchema),
});
export type CourtsCache = typeof CourtsCacheSchema.Type;

// ---------------------------------------------------------------------------
// Queue message schema + type
// ---------------------------------------------------------------------------

export const QueueMessageSchema = Schema.Struct({
  court: Schema.String,
  year: Schema.Number,
  num: Schema.String,
  title: Schema.String,
  url: Schema.String,
});
export type QueueMessage = typeof QueueMessageSchema.Type;

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

export const R2KeySchema = Schema.String.pipe(Schema.brand("R2Key"));
export type R2Key = typeof R2KeySchema.Type;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type FetchError = {
  readonly _tag: "FetchError";
  readonly status: number;
  readonly url: string;
};

export type ParseError = {
  readonly _tag: "ParseError";
  readonly message: string;
};

export type StorageError = {
  readonly _tag: "StorageError";
  readonly message: string;
};

export type ScraperError = FetchError | ParseError | StorageError;

export const fetchError = (status: number, url: string): FetchError => ({
  _tag: "FetchError",
  status,
  url,
});

export const parseError = (message: string): ParseError => ({
  _tag: "ParseError",
  message,
});

export const storageError = (message: string): StorageError => ({
  _tag: "StorageError",
  message,
});

export const toScraperError = (e: unknown): ScraperError =>
  parseError(e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Env interface
// ---------------------------------------------------------------------------

export interface Env {
  readonly ORCHESTRATOR: Workflow;
  readonly COURT_SCRAPE: Workflow;
  readonly RATE_LIMITER: DurableObjectNamespace<RateLimiterDO>;
  readonly SCRAPE_QUEUE: Queue<QueueMessage>;
  readonly KV: KVNamespace;
  readonly R2: R2Bucket;
  readonly DB: D1Database;
  readonly COURTS: string;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export const toErrorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
