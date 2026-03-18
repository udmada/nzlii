import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { getDoneYears } from "../lib/kv.ts";
import type { Env } from "../types.ts";

const SCRAPE_FROM_YEAR = 2000;

type OrchestratorParams = {
  // Unique tag embedded in court-scrape workflow IDs. Defaults to today's
  // date (YYYY-MM-DD) so the nightly cron is idempotent within a day.
  // Pass a different value (e.g. a timestamp) to force fresh instances,
  // e.g. when recovering after failures on the same calendar day.
  readonly runId?: string;
};

export class OrchestratorWorkflow extends WorkflowEntrypoint<Env, OrchestratorParams> {
  async run(event: WorkflowEvent<OrchestratorParams>, step: WorkflowStep): Promise<void> {
    const runId = event.payload.runId ?? new Date().toISOString().slice(0, 10);

    // Parse configured courts from env var — no network call needed here.
    // The KV courts cache is warmed lazily by GET /courts.
    const courts = await step.do("resolve-courts", () =>
      Promise.resolve(
        this.env.COURTS.split(",")
          .map((c) => c.trim())
          .filter((c): c is string => c.length > 0),
      ),
    );

    const currentYear = new Date().getFullYear();

    // One step per court — one KV list replaces N individual reads
    for (const court of courts) {
      await step.do(`spawn-${court}`, async () => {
        const doneYears = await getDoneYears(this.env.KV, court);
        for (let year = currentYear; year >= SCRAPE_FROM_YEAR; year--) {
          // Skip completed historical years (current year is never skipped)
          if (year < currentYear && doneYears.has(year)) continue;
          const id = `${court}-${year}-${runId}`;
          try {
            await this.env.COURT_SCRAPE.create({ id, params: { court, year } });
          } catch (e: unknown) {
            // Idempotent: skip if this instance was already created on a prior attempt
            if (!(e instanceof Error && e.message.includes("already_exists"))) throw e;
          }
        }
      });
    }
  }
}
