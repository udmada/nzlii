import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "../types.ts";
import { getCourts, saveCourts, isYearDone } from "../lib/kv.ts";
import { parseCourts } from "../lib/parse.ts";

const DATABASES_URL = "https://www.nzlii.org/databases.html";
const SCRAPE_FROM_YEAR = 2000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-NZ,en;q=0.9",
} as const;

export class OrchestratorWorkflow extends WorkflowEntrypoint<Env> {
  async run(_event: WorkflowEvent<never>, step: WorkflowStep): Promise<void> {
    // Resolve the configured courts (refresh KV cache if stale)
    const courts = await step.do("resolve-courts", async () => {
      const cached = await getCourts(this.env.KV);
      if (!cached) {
        const res = await fetch(DATABASES_URL, { headers: HEADERS });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching courts list`);
        const all = parseCourts(await res.text());
        await saveCourts(this.env.KV, all);
      }
      // Return only the configured courts from env
      return this.env.COURTS.split(",")
        .map((c) => c.trim())
        .filter((c): c is string => c.length > 0);
    });

    const currentYear = new Date().getFullYear();

    // One step per court — iterate all years inside to keep step count low
    for (const court of courts) {
      await step.do(`spawn-${court}`, async () => {
        for (let year = currentYear; year >= SCRAPE_FROM_YEAR; year--) {
          // Skip completed historical years (current year is never skipped)
          const skip = year < currentYear && (await isYearDone(this.env.KV, court, year));
          if (!skip) {
            const id = `${court}-${year}-${new Date().toISOString().slice(0, 10)}`;
            await this.env.COURT_SCRAPE.create({ id, params: { court, year } });
          }
        }
      });
    }
  }
}
