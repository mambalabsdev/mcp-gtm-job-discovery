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

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
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

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 400:
        message = `The ${actorLabel} run was rejected as invalid input.${detail}`;
        break;
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Ask for less per call, or run the actor on Apify directly for larger jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  // A 2xx from run-sync-get-dataset-items normally carries the dataset array.
  // Anything else on this path is a failure the caller must see, never an empty
  // success: surfacing it here is what keeps a failed run from reading as "no
  // results found".
  let items: unknown;
  try {
    items = await response.json();
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
      "Find companies that are hiring for a set of role keywords across public job boards, and return one flat row per posting enriched with company firmographics and the company LinkedIn URL. Discovery runs through Google Jobs, and passing your own SerpAPI key runs that search on your own quota. Postings are filtered by age, by country, and optionally by employee count, and staffing agencies and freelance marketplaces are dropped by default because they are noise for direct outreach. A cross run delta cache means a repeat run returns only postings it has not emitted before, and previous_run_date lets you set that watermark yourself. max_results caps how many raw postings are pulled before filtering and max_companies caps how many unique companies get enriched, so the two together are the cost dial. Requires an APIFY_TOKEN and consumes Apify credits. Read only: this discovers and enriches, it writes nothing.",
    annotations: {
      title: "Monitor Job Postings",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    keywords: z.array(z.string()).describe("Editorial / content role titles to search for across job boards."),
    country: z.string().optional().describe("Geographic filter, e.g. United States, United Kingdom, Canada. Default: \"United States\"."),
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
    },
  },
  async (args) =>
    runActor("QCfICD9kOPiOdj5iI", "Job Posting Monitor", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
