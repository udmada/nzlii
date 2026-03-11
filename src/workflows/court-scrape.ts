import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect } from "effect";

import { upsertCase } from "../lib/d1.ts";
import { markYearDone } from "../lib/kv.ts";
import { parseCaseLinks } from "../lib/parse.ts";
import type { Env, QueueMessage } from "../types.ts";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
} as const;

type CourtScrapeParams = { readonly court: string; readonly year: number };

export class CourtScrapeWorkflow extends WorkflowEntrypoint<Env, CourtScrapeParams> {
  async run(event: WorkflowEvent<CourtScrapeParams>, step: WorkflowStep): Promise<void> {
    const { court, year } = event.payload;
    const base = `http://www.nzlii.org/nz/cases/${court}/${year}`;

    const cases = await step.do("fetch-index", async () => {
      const res = await fetch(`${base}/`, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching index for ${court}/${year}`);
      return parseCaseLinks(await res.text(), base);
    });

    if (cases.length === 0) return;

    await step.do("upsert-cases", () =>
      Effect.runPromise(
        Effect.forEach(cases, (c) => upsertCase(this.env.DB, court, year, c.num, c.title, c.url), {
          concurrency: 1,
        }),
      ),
    );

    await step.do("enqueue", async () => {
      const messages = cases.map(
        (c): MessageSendRequest<QueueMessage> => ({
          body: { court, year, num: c.num, title: c.title, url: c.url },
        }),
      );
      // Queue.sendBatch accepts up to 100 messages; chunk for large courts
      for (let i = 0; i < messages.length; i += 100) {
        await this.env.SCRAPE_QUEUE.sendBatch(messages.slice(i, i + 100));
      }
    });

    await step.do("mark-done", async () => {
      const currentYear = new Date().getFullYear();
      if (year < currentYear) {
        await markYearDone(this.env.KV, court, year);
      }
    });
  }
}
