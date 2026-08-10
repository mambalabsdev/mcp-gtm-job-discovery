# Job Posting Monitor MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-gtm-job-discovery)](https://smithery.ai/servers/mambabuilt/mcp-gtm-job-discovery) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-gtm-job-discovery/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-gtm-job-discovery) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-gtm-job-discovery%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-gtm-job-discovery&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-gtm-job-discovery)](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-job-discovery) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-gtm-job-discovery)](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-job-discovery) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-gtm-job-discovery)](https://github.com/mambalabsdev/mcp-gtm-job-discovery/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-gtm-job-discovery)

MCP server for the Mamba Labs [Job Posting Monitor](https://apify.com/mambalabs/gtm-job-discovery) actor on Apify.

Give it a list of role keywords and it returns the companies currently advertising those roles, one flat row per posting, each enriched with firmographics and the company LinkedIn URL.

## Install

```bash
npx -y @mambalabsdev/mcp-gtm-job-discovery
```

### Claude Desktop

```json
{
  "mcpServers": {
    "mamba-gtm-job-discovery": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-gtm-job-discovery"],
      "env": { "APIFY_TOKEN": "your-apify-token" }
    }
  }
}
```

Get an Apify token at [console.apify.com/account/integrations](https://console.apify.com/account/integrations).

## Tool

### `monitor_job_postings`

Give it a list of role keywords and it returns the companies currently advertising those roles, one flat row per posting, each enriched with firmographics and the company LinkedIn URL.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `keywords` | array | yes | Editorial / content role titles to search for across job boards. |
| `country` | string | no | Geographic filter, e.g. United States, United Kingdom, Canada. |
| `lookback_days` | integer | no | Only return postings newer than this many days. |
| `company_size_min` | integer | no | Optional. Drop companies with fewer employees than this (only applied when company size is known). |
| `company_size_max` | integer | no | Optional. Drop companies larger than this (only applied when company size is known). |
| `exclude_staffing_agencies` | boolean | no | Filter out staffing and recruitment agency postings using name and job-description heuristics. |
| `exclude_freelance_marketplaces` | boolean | no | Filter out postings where the company is a freelance marketplace (Upwork, Fiverr, etc.), which are noise for direct outreach. |
| `freelance_marketplaces` | array | no | Company names treated as freelance marketplaces and excluded when the toggle above is on. Defaults shown; override or extend as needed. |
| `remote_only` | boolean | no | Only return remote / work-from-home postings. |
| `previous_run_date` | string | no | Optional ISO date (e.g. 2026-06-01) of your last run. Only postings newer than this are emitted, on top of the built-in cross-run delta cache. |
| `max_results` | integer | no | Upper bound on raw postings pulled from the discovery source before filtering. Higher values cost more. |
| `max_companies` | integer | no | Cap on unique companies enriched per run (firmographics + LinkedIn). Bounds sub-actor cost. |
| `serpapi_key` | string | no | SerpAPI key used for Google Jobs discovery (get a free key at serpapi.com, 250 searches/month, no card). Required to produce results unless a SERPAPI_KEY environment variable is set on the actor. |

## Billing

You are charged per result row returned, plus a small actor start fee. Filtered postings are free.

Pricing is on the [actor's Apify page](https://apify.com/mambalabs/gtm-job-discovery). Running this server consumes Apify credits.

## What this server does and does not do

It is a thin client for the Apify actor. It passes your input through and returns the actor's output unchanged. Every behavior described above lives in the actor, not here.

Errors are surfaced, never swallowed. An invalid input, an invalid token, an exhausted balance, a timeout, or a run that returns anything other than a dataset all come back as an explicit tool error rather than as an empty result.

## Source

The actor is on the [Apify Store]( https://apify.com/mambalabs/gtm-job-discovery). This wrapper is [MIT licensed](LICENSE).

Built by [Mamba Labs](https://apify.com/mambalabs)
