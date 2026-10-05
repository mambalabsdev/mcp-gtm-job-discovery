#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. One value for
// every Mamba Labs wrapper, set 2026-10-05: start and poll exists so a long run
// survives, and a shorter limit would end the long runs it was built for. Past
// this limit the run ends TIMED-OUT and the caller is told so, with the run id.
// Measured on 2026-08-13 over 31 SUCCEEDED runs: slowest ever 345.7 s.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. This wrapper used
// run-sync-get-dataset-items?timeout=300 and cut off runs the actor completes:
// more than five percent of this actor's SUCCEEDED runs take longer than 300
// seconds. Raising that query parameter does not fix it, which is worth stating
// because it is the obvious fix and it is wrong. Apify's synchronous endpoints
// carry a platform ceiling of 300 seconds on the HTTP wait itself and answer
// 408 past it regardless of what `timeout` says. The only way for the wrapper
// to wait as long as the actor needs is to start the run, poll it to a terminal
// status, and then read the dataset.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-gtm-job-discovery",
  version: pkg.version,
});

// Job Posting Monitor (immutable actor ID QCfICD9kOPiOdj5iI)
server.registerTool(
  "monitor_job_postings",
  {
    title: "Monitor Job Postings",
    description:
      "Find companies that are hiring for a set of role keywords across public job boards, and return one flat row per posting enriched with company firmographics and the company LinkedIn URL. Discovery runs through the boards named in sources as a chain: seven keyless boards first (Jobicy, Remotive, Arbeitnow, The Muse, Remote OK, We Work Remotely, Himalayas), then Adzuna, then the metered JobsPipe, TheirStack, and Google Jobs on your own keys, only for keywords still short of new companies. Every row carries posted_via, the board the posting was actually published through. Postings are filtered by age, by country, and optionally by employee count, and staffing agencies and freelance marketplaces are dropped by default because they are noise for direct outreach. A cross run delta cache means a repeat run returns only postings it has not emitted before, and previous_run_date lets you set that watermark yourself. max_results caps how many raw postings are pulled before filtering and max_companies caps how many unique companies get enriched, so the two together are the cost dial. Use it to build a list of companies hiring for the roles you sell into. Requires an APIFY_TOKEN and consumes Apify credits; it discovers and enriches and writes nothing.",
    annotations: {
      title: "Monitor Job Postings",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    keywords: z.array(z.string()).describe("Role titles to search for across job boards, one per entry, for example [\"account executive\", \"revops manager\"]. Each keyword runs through the source chain separately."),
    sources: z.array(z.enum(["google_jobs", "jobicy", "remotive", "arbeitnow", "themuse", "remoteok", "weworkremotely", "himalayas", "adzuna", "jobspipe", "theirstack"])).optional().describe("Which job boards to search, run as an ordered chain. Tier 0 needs no key and runs every keyword: jobicy, remotive, arbeitnow, themuse, remoteok, weworkremotely, himalayas. Tier 1 is adzuna (needs adzuna_app_id and adzuna_app_key). Tier 2 runs only on keywords the earlier tiers left short: jobspipe and theirstack (each needs its key, billed by the provider per job returned) and google_jobs (needs serpapi_key). A posting on two boards is deduplicated and counted once. Default: [\"google_jobs\"]."),
    country: z.string().optional().describe("Geographic filter, e.g. United States, United Kingdom, Canada. Default: \"United States\"."),
    countries: z.array(z.string()).optional().describe("Loop these countries inside one run; overrides country when set. Metered sources query each country separately; keyless remote boards are global and run once. Use the names Google Jobs accepts, for example United States, United Kingdom, Canada."),
    lookback_days: z.number().int().optional().describe("Only return postings newer than this many days. Default: 30."),
    company_size_min: z.number().int().optional().describe("Optional. Drop companies with fewer employees than this (only applied when company size is known)."),
    company_size_max: z.number().int().optional().describe("Optional. Drop companies larger than this (only applied when company size is known)."),
    exclude_staffing_agencies: z.boolean().optional().describe("Filter out staffing and recruitment agency postings using name and job-description heuristics. Default: true."),
    exclude_freelance_marketplaces: z.boolean().optional().describe("Filter out postings where the company is a freelance marketplace (Upwork, Fiverr, etc.), which are noise for direct outreach. Default: true."),
    freelance_marketplaces: z.array(z.string()).optional().describe("Company names treated as freelance marketplaces and excluded when the toggle above is on. Defaults shown; override or extend as needed. Default: [\"Upwork\", \"Fiverr\", \"Freelancer\", \"Toptal\", \"PeoplePerHour\", \"Guru\", \"99designs\"]."),
    remote_only: z.boolean().optional().describe("Only return remote / work-from-home postings. Default: false."),
    previous_run_date: z.string().optional().describe("Optional ISO date (e.g. 2026-06-01) of your last run. Only postings newer than this are emitted, on top of the built-in cross-run delta cache."),
    max_results: z.number().int().optional().describe("Upper bound on raw postings pulled from the discovery source before filtering. Higher values cost more. Default: 100."),
    max_companies: z.number().int().optional().describe("Cap on unique companies enriched per run (firmographics + LinkedIn). Bounds sub-actor cost. Default: 40."),
    serpapi_key: z.string().optional().describe("SerpAPI key used for Google Jobs discovery (get a free key at serpapi.com, 250 searches/month, no card). Required to produce results unless a SERPAPI_KEY environment variable is set on the actor."),
    adzuna_app_id: z.string().optional().describe("Your Adzuna application id for the adzuna source. It travels in the tool call; the actor's ADZUNA_APP_ID environment variable is used when this is empty."),
    adzuna_app_key: z.string().optional().describe("Your Adzuna application key for the adzuna source. The actor's ADZUNA_APP_KEY environment variable is used when this is empty."),
    jobspipe_key: z.string().optional().describe("Your JobsPipe Bearer key (jp_live_...) for the jobspipe source. JobsPipe bills one credit per job returned. The actor's JOBSPIPE_KEY environment variable is used when this is empty."),
    theirstack_key: z.string().optional().describe("Your TheirStack API key for the theirstack source. TheirStack bills one credit per job returned. The actor's THEIRSTACK_KEY environment variable is used when this is empty."),
    metered_window_days: z.number().int().min(1).max(7).optional().describe("Only ask the metered sources (jobspipe, theirstack) for postings this many days old or newer. They bill per job returned, seen before or not, so a narrow window is the biggest credit saver. 1 to 7. Default: 2."),
    enough_new_companies_per_keyword: z.number().int().min(1).max(100).optional().describe("Stop the source chain for a keyword once this many distinct new companies have been found for it this run. Later, metered tiers run only on keywords still below this. Default: 3."),
    metered_run_cap: z.number().int().min(1).max(500).optional().describe("Ceiling per metered source per country per run: searches for SerpAPI, calls for Adzuna, jobs for JobsPipe and TheirStack. Default: 50."),
    },
  },
  async (args) =>
    runActor("QCfICD9kOPiOdj5iI", "Job Posting Monitor", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
