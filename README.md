# TokenOracle MCP

Token Oracle is a Model Context Protocol (MCP) server that estimates, compares, and controls LLM API costs before agents spend tokens. It exposes nine tools, four read-only Resources, and a cost_analysis_workflow Prompt template. All tools are read-only and idempotent — no external LLM API calls are made at query time. Pricing data is sourced from the LiteLLM community dataset (model_prices_and_context_window.json) and cached in-memory with a bundled snapshot fallback.

**MCP tools exposed:**

- `estimate_cost` — Estimates the USD cost of a single LLM API call before execution. Input: task_description, prompt_text, task_type, or explicit token_count. Output: cost_usd, recommended_model, confidence, will_fit_context, pricing_stale. Annotations: readOnlyHint:true, idempotentHint:true, openWorldHint:false.
- `estimate_cost_batch` — Prices up to 100 LLM tasks in a single call. Returns per-task breakdown, total_cost_usd, and cheapest_model_for_all. Use before starting any multi-step pipeline.
- `compare_models` — Ranks LLM pricing across all supported providers for a given task. Returns models sorted by cost with speed_tier and quality_tier. Supports filtering by min_quality, max_cost_usd, and provider. Input: task_type, token_count, or prompt_text.
- `budget_check` — Checks whether a planned task fits within a monthly budget. Returns can_proceed (boolean), remaining_budget_usd, budget_consumed_pct, and cheaper_alternatives with savings_pct. Input: monthly_budget_usd, current_spend_usd, and task description.
- `find_cheapest_for_budget` — Inverse of budget_check. Given a budget_usd cap and task, returns the best model/quality combination within budget plus all alternatives ranked by quality then cost.

**MCP Resources exposed:**
- `token-oracle://meta` — Machine-readable server capability document (version, model_count, pricing freshness)
- `token-oracle://models` — Model IDs with metadata for discovery and validation
- `token-oracle://heuristics` — Task-type token heuristics and keyword classifier patterns (auditable)
- `token-oracle://pricing/changelog` — Append-only log of pricing changes; use to detect stale cached data

**MCP Prompt exposed:**
- `cost_analysis_workflow` — Guided three-step prompt template: estimate_cost → compare_models → budget_check. Arguments: task_description, monthly_budget_usd (optional), quality_threshold (optional).

**Supported providers:** Anthropic, OpenAI, Google, Groq, Together AI, Mistral, DeepSeek, Cohere (100+ models).

**Canonical agent workflow example:**
Goal: Run 500 product description generation tasks. Budget $50/mo, current spend $43.
1. estimate_cost_batch({ tasks: [{ task_type: "generate", token_count: { input: 200, output: 800 }, quantity: 500 }] }) → total_cost_usd: $0.60
2. compare_models({ token_count: { input: 200, output: 800 }, task_type: "generate", min_quality: "med", max_cost_usd: 0.002 }) → deepseek-v3 at $0.00035/task ($0.175 total) — 71% cheaper, same quality tier
3. budget_check({ monthly_budget_usd: 50, current_spend_usd: 43, token_count: { input: 200, output: 800 }, model: "deepseek-v3" }) → can_proceed: true, remaining: $6.825, budget_consumed_pct: 2.4%
Decision: Use deepseek-v3. Save $0.425 vs gpt-4o-mini.

**Pricing:**
- Free: 100 API calls/day, all five tools via hosted HTTP endpoint, no credit card
- Pro ($29/mo): Unlimited calls, track_spend tool (persisted cost ledger per API key), priority throughput, spend attribution per agent/task/session

**Contact:** info@guffeyholdings.com

## Hosted endpoint

- Canonical remote MCP URL: `https://mcp.guffeyholdings.com/TokenOracle`
- Canonical MCP name: `com.guffeyholdings/token-oracle`

Direct remote configuration:

```json
{
  "mcpServers": {
    "token-oracle": {
      "type": "streamable-http",
      "url": "https://mcp.guffeyholdings.com/TokenOracle",
      "headers": {
        "X-API-Key": "${TOKEN_ORACLE_API_KEY}"
      }
    }
  }
}
```

## npm bridge package

For local clients that still expect an npm-installed stdio server, use `token-oracle-mcp`.

```json
{
  "mcpServers": {
    "token-oracle": {
      "command": "npx",
      "args": ["-y", "token-oracle-mcp"],
      "env": {
        "TOKEN_ORACLE_API_KEY": "${TOKEN_ORACLE_API_KEY}"
      }
    }
  }
}
```

Optional bridge environment variables:

- `TOKEN_ORACLE_API_KEY`: required hosted API key
- `TOKEN_ORACLE_BASE_URL`: override for the remote endpoint; defaults to `https://mcp.guffeyholdings.com/TokenOracle`
- `TOKEN_ORACLE_SUBJECT`: optional end-user subject forwarded as `X-Token-Oracle-Subject`

## Capabilities

Tools:
- `estimate_cost`
- `estimate_cost_batch`
- `compare_models`
- `budget_check`
- `find_cheapest_for_budget`
- `get_budget_status`
- `list_request_activity`
- `get_usage_summary`
- `get_usage_leaderboard`

Resources:
- `token-oracle://meta`
- `token-oracle://models`
- `token-oracle://heuristics`
- `token-oracle://pricing/changelog`

Prompts:
- `cost_analysis_workflow`

## Versioning

- Hosted service version: `1.0.1`
- Bridge package version: `1.0.1`
