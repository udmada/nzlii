import type {
  ExecutionContext,
  ExportedHandler,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import { Effect, Schema } from "effect";

import { markDone, markError, queryCases, queryPendingCases } from "./lib/d1.ts";
import { getCourts, saveCourts } from "./lib/kv.ts";
import { detectPdf, resolveUrl, extractText, parseCourts } from "./lib/parse.ts";
import { headObject, putText, putBinary, makeR2Key } from "./lib/r2.ts";
import {
  type Env,
  type QueueMessage,
  type ScraperError,
  fetchError,
  storageError,
  toErrorMessage,
  QueueMessageSchema,
} from "./types.ts";

// Re-export Workflow and DO classes so wrangler can bind them
export { OrchestratorWorkflow } from "./workflows/orchestrator.ts";
export { CourtScrapeWorkflow } from "./workflows/court-scrape.ts";
export { RateLimiterDO } from "./objects/rate-limiter.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
} as const;

const DATABASES_URL = "https://beta.nzlii.org/databases.html";
const FETCH_TIMEOUT_MS = 20_000;

const isQueueMessage = Schema.is(QueueMessageSchema);

// ---------------------------------------------------------------------------
// processCase — core scrape logic for a single queue message
// ---------------------------------------------------------------------------

const processCase = (env: Env, msg: QueueMessage): Effect.Effect<string, ScraperError> => {
  const { court, year, num, title, url } = msg;
  const txtKey = makeR2Key(court, year, num, title, "txt");
  const pdfKey = makeR2Key(court, year, num, title, "pdf");
  const rtfKey = makeR2Key(court, year, num, title, "rtf");
  const label = `${court}/${year}/${num}`;

  // R2 HEAD check — skip if any variant already stored
  const checkExists = Effect.tryPromise({
    try: () =>
      Promise.all([
        headObject(env.R2, txtKey),
        headObject(env.R2, pdfKey),
        headObject(env.R2, rtfKey),
      ]),
    catch: (e) => storageError(toErrorMessage(e)),
  });

  const errorMsg = (e: ScraperError): string =>
    e._tag === "FetchError" ? `HTTP ${e.status} for ${e.url}` : e.message;

  return Effect.flatMap(checkExists, ([txtExists, pdfExists, rtfExists]) => {
    if (txtExists || pdfExists || rtfExists) {
      return Effect.succeed(`SKIP ${label} (already in R2)`);
    }

    // Fetch the case page
    const fetchPage = Effect.tryPromise({
      try: () => fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      catch: (e) => storageError(toErrorMessage(e)),
    });

    return Effect.flatMap(fetchPage, (pageRes) => {
      if (!pageRes.ok) {
        return Effect.fail(fetchError(pageRes.status, url));
      }

      const readPage = Effect.tryPromise({
        try: () => pageRes.text(),
        catch: (e) => storageError(toErrorMessage(e)),
      });

      return Effect.flatMap(readPage, (html) => {
        const pdfHref = detectPdf(html);

        if (pdfHref !== null) {
          // PDF path
          const pdfUrl = resolveUrl(pdfHref, url);

          const fetchPdf = Effect.tryPromise({
            try: () =>
              fetch(pdfUrl, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
            catch: (e) => storageError(toErrorMessage(e)),
          });

          return Effect.flatMap(fetchPdf, (pdfRes) => {
            if (!pdfRes.ok) {
              return Effect.fail(fetchError(pdfRes.status, pdfUrl));
            }

            const readPdf = Effect.tryPromise({
              try: () => pdfRes.arrayBuffer(),
              catch: (e) => storageError(toErrorMessage(e)),
            });

            return Effect.flatMap(readPdf, (data) =>
              Effect.flatMap(
                Effect.tryPromise({
                  try: () => putBinary(env.R2, pdfKey, data),
                  catch: (e) => storageError(toErrorMessage(e)),
                }),
                () =>
                  Effect.map(markDone(env.DB, court, year, num, pdfKey), () => `DONE ${label}.pdf`),
              ),
            );
          });
        }

        // Empty HTML body — server has no HTML for this case, try RTF fallback
        if (html.length === 0) {
          const rtfUrl = url.replace(/\.html$/i, ".rtf");

          const fetchRtf = Effect.tryPromise({
            try: () =>
              fetch(rtfUrl, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
            catch: (e) => storageError(toErrorMessage(e)),
          });

          return Effect.flatMap(fetchRtf, (rtfRes) => {
            if (!rtfRes.ok) {
              return Effect.fail(fetchError(rtfRes.status, rtfUrl));
            }

            const readRtf = Effect.tryPromise({
              try: () => rtfRes.arrayBuffer(),
              catch: (e) => storageError(toErrorMessage(e)),
            });

            return Effect.flatMap(readRtf, (data) =>
              Effect.flatMap(
                Effect.tryPromise({
                  try: () => putBinary(env.R2, rtfKey, data, "application/rtf"),
                  catch: (e) => storageError(toErrorMessage(e)),
                }),
                () =>
                  Effect.map(markDone(env.DB, court, year, num, rtfKey), () => `DONE ${label}.rtf`),
              ),
            );
          });
        }

        // HTML text path
        const text = extractText(html);

        return Effect.flatMap(
          Effect.tryPromise({
            try: () => putText(env.R2, txtKey, text),
            catch: (e) => storageError(toErrorMessage(e)),
          }),
          () => Effect.map(markDone(env.DB, court, year, num, txtKey), () => `DONE ${label}.txt`),
        );
      });
    });
  }).pipe(Effect.tapError((e) => markError(env.DB, court, year, num, errorMsg(e))));
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const scheduled = async (
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => {
  ctx.waitUntil(env.ORCHESTRATOR.create({}));
};

const RETRY_DELAY_SECONDS = 60;

const queue = async (batch: MessageBatch, env: Env): Promise<void> => {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("global"));

  for (let i = 0; i < batch.messages.length; i++) {
    const msg = batch.messages[i];
    if (msg === undefined) continue;

    if (!isQueueMessage(msg.body)) {
      console.error("Invalid queue message shape:", msg.body);
      msg.ack();
      continue;
    }
    const body: QueueMessage = msg.body;

    const allowed = await stub.acquireSlot();
    if (!allowed) {
      // Rate limiter backed up. Retry this and all remaining messages with a
      // delay using the native retry mechanism — no Queue API call, so it
      // cannot itself be rate-limited (unlike sendBatch).
      msg.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      for (let j = i + 1; j < batch.messages.length; j++) {
        batch.messages[j]?.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      }
      return;
    }

    const result = await Effect.runPromise(Effect.either(processCase(env, body)));
    if (result._tag === "Left") {
      console.error(`ERROR ${body.court}/${body.year}/${body.num}:`, result.left);
      // Retry on transient server/network errors (5xx, timeouts); ack permanent ones (4xx)
      const isTransient = result.left._tag === "FetchError" && result.left.status >= 500;
      if (isTransient) {
        msg.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      } else {
        msg.ack();
      }
    } else {
      console.log(result.right);
      msg.ack();
    }
  }
};

// ---------------------------------------------------------------------------
// Type guard for D1 case rows
// ---------------------------------------------------------------------------

type CaseRow = { readonly num: string; readonly r2_key: string | null };

const isCaseRow = (v: unknown): v is CaseRow =>
  typeof v === "object" &&
  v !== null &&
  "num" in v &&
  typeof (v as Record<string, unknown>)["num"] === "string" &&
  "r2_key" in v;

// ---------------------------------------------------------------------------
// HTTP fetch handler
// ---------------------------------------------------------------------------

const handleFetch = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const url = new URL(request.url);
  const { pathname } = url;

  // GET /courts — serve from KV cache, refreshing from nzlii.org if stale/empty
  if (request.method === "GET" && pathname === "/courts") {
    let courts = await getCourts(env.KV);
    if (!courts) {
      const res = await fetch(DATABASES_URL, { headers: HEADERS });
      if (res.ok) {
        courts = parseCourts(await res.text());
        await saveCourts(env.KV, courts);
      }
    }
    return Response.json(courts ?? []);
  }

  // GET /decisions?court=X&year=Y
  if (request.method === "GET" && pathname === "/decisions") {
    const court = url.searchParams.get("court");
    const yearStr = url.searchParams.get("year");
    if (court === null || yearStr === null) {
      return new Response("Missing court or year query param", { status: 400 });
    }
    const year = Number(yearStr);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return new Response("Invalid year", { status: 400 });
    }
    const result = await Effect.runPromise(Effect.either(queryCases(env.DB, court, year)));
    if (result._tag === "Left") {
      return new Response("DB error", { status: 500 });
    }
    return Response.json(result.right);
  }

  // GET /decisions/:court/:year/:num
  const decisionMatch = /^\/decisions\/([^/]+)\/(\d+)\/([^/]+)$/.exec(pathname);
  if (request.method === "GET" && decisionMatch !== null) {
    const [, court, yearStr, num] = decisionMatch;
    if (court == null || yearStr == null || num == null) {
      return new Response("Not found", { status: 404 });
    }
    const year = Number(yearStr);
    const result = await Effect.runPromise(Effect.either(queryCases(env.DB, court, year)));
    if (result._tag === "Left") {
      return new Response("DB error", { status: 500 });
    }
    const row = result.right.find((r) => isCaseRow(r) && r.num === num);
    if (!isCaseRow(row) || row.r2_key === null) {
      return new Response("Not found", { status: 404 });
    }
    const obj = await env.R2.get(row.r2_key);
    if (obj === null) {
      return new Response("Not found in storage", { status: 404 });
    }
    const contentType = row.r2_key.endsWith(".pdf")
      ? "application/pdf"
      : row.r2_key.endsWith(".rtf")
        ? "application/rtf"
        : "text/plain; charset=utf-8";
    return new Response(obj.body as ReadableStream, {
      headers: { "Content-Type": contentType },
    });
  }

  // POST /scrape?force=1  — pass a timestamp runId to bypass already_exists on same-day re-runs
  if (request.method === "POST" && pathname === "/scrape") {
    const force = url.searchParams.get("force") === "1";
    const params = force ? { runId: Date.now().toString() } : {};
    await env.ORCHESTRATOR.create({ params });
    return new Response(null, { status: 202 });
  }

  // POST /requeue-pending?include_errors=1
  // Re-enqueues all pending (and optionally error) cases from D1 as fresh queue messages.
  if (request.method === "POST" && pathname === "/requeue-pending") {
    const includeErrors = url.searchParams.get("include_errors") === "1";
    const statuses = includeErrors ? (["pending", "error"] as const) : (["pending"] as const);
    const result = await Effect.runPromise(Effect.either(queryPendingCases(env.DB, statuses)));
    if (result._tag === "Left") {
      return new Response("DB error", { status: 500 });
    }
    const cases = result.right;
    ctx.waitUntil(
      (async (): Promise<void> => {
        for (let i = 0; i < cases.length; i += 100) {
          const batch = cases.slice(i, i + 100).map((c) => ({
            body: {
              court: c.court,
              year: c.year,
              num: c.num,
              title: c.title,
              url: c.url,
            } satisfies QueueMessage,
          }));
          await env.SCRAPE_QUEUE.sendBatch(batch);
        }
      })(),
    );
    return Response.json({ enqueued: cases.length });
  }

  return new Response("Not found", { status: 404 });
};

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default {
  scheduled,
  queue,
  fetch: handleFetch,
} satisfies ExportedHandler<Env>;
