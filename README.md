# ads-automation-kit

> **BUILT WITH GOOGLE ANTIGRAVITY CLI (`agy`)**
> This repository and its unified 56-tool Google Ads MCP Server + 25-Agent CLI architecture were built using the **Google Antigravity CLI (`agy`)**.
> Just like [SlavaWagner/ai-ads-pipeline](https://github.com/SlavaWagner/ai-ads-pipeline) and [SlavaWagner/swa-google-ads-mcp](https://github.com/SlavaWagner/swa-google-ads-mcp), `ads-automation-kit` operates **exclusively inside Google Antigravity CLI**.
>
> **UNOFFICIAL SOFTWARE NOTICE**
> This is an **unofficial**, independent open-source project. It is **not** affiliated with, endorsed by, or maintained by Google LLC or the official Google Ads API team.
>
> **SAFETY GATES & MUTATE WORKFLOW**
> Alongside 32 read-only Core, Reporting, and Research tools, the kit exposes **24 active Google Ads Mutate tools**. Every agent mutation runs through **pre-flight API dry-run validation (`validate_only: true`)**, **interactive human confirmation**, **`PAUSED` defaults for new entities**, and **persistent decision receipts** inside `storage/`.

---

## End-to-End Architecture Sequence

`ads-automation-kit` is structured as a strict 5-phase operational pipeline from session authentication to closed-loop optimization:

1. **Phase 1 — Antigravity Runtime Guard & OAuth2 Connection** (`src/guard.js`, `src/auth.js`, `src/config.js`)
2. **Phase 2 — 56-Tool Google Ads MCP Server** (`bin/mcp-server.js`, `src/mcp/toolRegistry.js`)
3. **Phase 3 — 16 Sequential Paired MCP Domain Agents (`01`–`16`)** (`src/agents/mcp/`)
4. **Phase 4 — 9-Stage R&D Intelligence Loop (`Stage 1`–`9`)** (`src/agents/rd/`)
5. **Phase 5 — Pre-Flight Validation, Staged `PAUSED` Execution & Episodic Memory** (`src/safety.js`, `src/memory.js`)

---

## Phase 1 — Antigravity CLI Guard & OAuth2 Setup

`ads-automation-kit` verifies an active Google Antigravity session (`ANTIGRAVITY_*`, `AGY_*`) at startup and reuses the OAuth2 loopback mechanism and `config.json` format from [SlavaWagner/ai-ads-pipeline](https://github.com/SlavaWagner/ai-ads-pipeline):

- **Loopback OAuth2 consent server** on `http://localhost:8085` (scope: `https://www.googleapis.com/auth/adwords`, offline refresh token).
- **Automatic token refresh** with a 300-second pre-expiry buffer and single automatic HTTP `401` retry recovery (`src/googleAdsClient.js`).
- **Gemini / Antigravity Agent Bridge** (`geminiApiKey: "antigravity"` in `config.json`) for interactive LLM copy generation and strategic Q&A.

### Quick Start

```bash
# 1. Start Google Antigravity CLI
agy

# 2. Install dependencies & link binaries
git clone <your-private-repo-url> ads-automation-kit
cd ads-automation-kit
npm install
npm link

# 3a. Interactive setup (Credentials -> OAuth2 on port 8085 -> Antigravity MCP registration)
ads-automation-kit setup

# OR 3b. Import existing credentials directly from ai-ads-pipeline / swa-google-ads-mcp
ads-automation-kit config-import /path/to/ai-ads-pipeline/config.json
ads-automation-kit install-agy

# 4. Verify live Google Ads API connectivity
ads-automation-kit status --live

# 5. Launch the interactive 25-Agent & 56-Tool Workspace
ads-automation-kit
```

---

## Phase 2 — Complete 56-Tool MCP Inventory

All 56 `zod`-validated tools are exposed simultaneously over **Stdio MCP** (`ads-automation-kit mcp` / `ads-kit-mcp` registered in `~/.gemini/config/mcp_config.json`) and invoked directly in-process by every CLI Agent. Tools load in four numbered groups:

1. **Core & GAQL (`01`–`05`, `src/mcp/tools/coreTools.js`)**:
   - `01` `list_accessible_customers` · `02` `get_account_hierarchy` · `03` `get_customer_info` · `04` `run_gaql_query` · `05` `get_gaql_field_metadata`
2. **Reporting (`06`–`27`, `src/mcp/tools/reportingTools.js`)**:
   - `06` `report_campaigns` · `07` `report_ad_groups` · `08` `report_ads` · `09` `report_asset_groups` · `10` `report_keywords` · `11` `report_search_terms` · `12` `report_times` · `13` `report_locations` · `14` `report_impression_share` · `15` `report_change_history` · `16` `report_audiences` · `17` `report_placements` · `18` `report_assets` · `19` `report_demographics` · `20` `report_devices` · `21` `report_landing_pages` · `22` `report_conversion_actions` · `23` `report_recommendations` · `24` `report_budgets_and_bidding` · `25` `report_shared_sets` · `26` `report_shopping_and_pmax_insights` · `27` `report_policy_diagnostics`
3. **Research & Keyword Planner (`28`–`32`, `src/mcp/tools/researchTools.js`)**:
   - `28` `keyword_planner_generate_ideas` · `29` `keyword_planner_historical_metrics` · `30` `keyword_planner_forecast_metrics` · `31` `suggest_geo_targets` · `32` `search_audience_segments`
4. **Mutate / Create / Exclude (`33`–`56`, `src/mcp/tools/mutateTools.js`)**:
   - `33` `create_campaign` · `34` `create_ad_group` · `35` `create_ad` · `36` `create_asset_group` · `37` `create_audience` · `38` `attach_audience_targeting` · `39` `create_keywords` · `40` `exclude_negative_search_terms` · `41` `exclude_placements` · `42` `create_location_targeting` · `43` `adjust_target_cpa` · `44` `adjust_target_roas` · `45` `create_budget_and_adjust_bidding` · `46` `create_and_upload_asset` · `47` `link_assets` · `48` `manage_ad_schedule` · `49` `create_portfolio_bidding_strategy` · `50` `update_entity_status` · `51` `update_ad` · `52` `manage_shared_sets` · `53` `manage_labels` · `54` `create_conversion_action` · `55` `upload_offline_click_conversions` · `56` `apply_or_dismiss_recommendation`

---

## Phase 3 — The 16 Sequential Paired MCP Domain Agents (`01`–`16`)

Every API domain follows the same operational execution chain:
**Pull Report/Research -> Deterministic Scoring & Diagnosis -> Dry-Run Validation (`validate_only: true`) -> Confirmation -> Mutate -> Episodic Memory Receipt.**

Ordered chronologically along the Google Ads campaign lifecycle:

| # | Agent ID | Domain | Paired Report & Research Tools | Paired Mutate / Action Outputs |
| :--- | :--- | :--- | :--- | :--- |
| `01` | `account-explorer` | Core & Diagnostics | `list_accessible_customers`, `get_account_hierarchy`, `get_customer_info`, `run_gaql_query`, `get_gaql_field_metadata` | Interactive `config.json` account & MCC switcher |
| `02` | `campaign` | Campaign Architecture | `report_campaigns`, `report_impression_share` | `create_campaign` (`PAUSED` stage), `update_entity_status` |
| `03` | `ad-group` | Ad Group Structure | `report_ad_groups`, `report_impression_share` | `create_ad_group`, `update_entity_status`, `adjust_target_cpa`, `adjust_target_roas` |
| `04` | `keyword` | Keywords & Planner | `report_keywords`, `report_impression_share`, `report_search_terms`, `keyword_planner_generate_ideas`, `keyword_planner_historical_metrics`, `keyword_planner_forecast_metrics` | `create_keywords` (deduplicated Planner ideas), `update_entity_status` |
| `05` | `search-term` | Search Intelligence | `report_search_terms`, `report_shared_sets` | `exclude_negative_search_terms` (4 scopes), `create_keywords` (`EXACT`), `manage_shared_sets` |
| `06` | `ad-creative` | Creatives & Policy | `report_ads`, `report_policy_diagnostics`, `report_landing_pages` | `create_ad` (RSA/Call/RDA, `PAUSED`), `update_ad`, `update_entity_status` |
| `07` | `pmax-asset-group` | Performance Max | `report_asset_groups`, `report_shopping_and_pmax_insights`, `report_assets` | `create_asset_group` (`PAUSED`), `attach_audience_targeting`, `link_assets`, `update_entity_status` |
| `08` | `asset-extensions` | Assets & Labels | `report_assets`, `report_landing_pages` | `create_and_upload_asset`, `link_assets`, `manage_labels` |
| `09` | `audience` | Audiences & Demographics | `report_audiences`, `report_demographics`, `search_audience_segments` | `create_audience`, `attach_audience_targeting` |
| `10` | `placement` | Placements & Brand Safety | `report_placements`, `report_shared_sets` | `exclude_placements`, `manage_shared_sets` |
| `11` | `location-geo` | Geo & Radius Targeting | `report_locations`, `suggest_geo_targets` | `create_location_targeting` (positive/negative geo & proximity) |
| `12` | `bidding-budget` | Bidding & Budgets | `report_budgets_and_bidding`, `report_campaigns`, `report_impression_share` | `adjust_target_cpa`, `adjust_target_roas`, `create_budget_and_adjust_bidding`, `create_portfolio_bidding_strategy` |
| `13` | `dayparting-schedule` | Dayparting & Devices | `report_times`, `report_devices` | `manage_ad_schedule` |
| `14` | `conversion-attribution` | Conversions & CRM | `report_conversion_actions`, `report_campaigns` | `create_conversion_action`, `upload_offline_click_conversions` (`GCLID`/`GBRAID`/`WBRAID`) |
| `15` | `recommendations` | Recommendations & Score | `report_recommendations`, `report_policy_diagnostics`, `get_customer_info` | `apply_or_dismiss_recommendation` |
| `16` | `change-history-listener` | Event Listener & Memory | `report_change_history`, `report_campaigns`, `report_times` | Fingerprinted `change-events-ledger.json`, 7d Before/After impact attribution, `--watch` loop & `update_entity_status` rollback |

---

## Phase 4 — The 9-Stage Sequential R&D Intelligence Loop (`Stage 1`–`9`)

Beyond 1:1 tool pairing, the 9 R&D Intelligence Agents execute a continuous quantitative optimization loop backed directly by Google Ads API telemetry and statistical models:

| Stage | Agent ID | Stage Role | Quantitative Engine & Google Ads API Loop |
| :--- | :--- | :--- | :--- |
| `Stage 1` | `rd-angle-discovery` | Angle Discovery & Intent Mining | Clusters `search_term_view`, `keyword_view`, `BEST`/`GOOD` ad assets, Keyword Planner ideas, and scraped Landing Pages into 4 intent archetypes (**Pain**, **Objection/Comparison**, **Outcome**, **Urgency**) saved to `angle-knowledge-base.json`. |
| `Stage 2` | `rd-asset-generator` | AI Creative & Persuasion Generation | Combines saved Angles + account winners with 6 persuasion frameworks (**PAS, 4U, AIDA, Proof-First, Objection-Dissolver, Contrarian**) via Gemini or Antigravity Bridge, sanitizes copy to `<=30`/`<=90` chars (`sanitizeAdCopy`), and stages `PAUSED` RSAs or Callouts. |
| `Stage 3` | `rd-asset-testing` | Asset Testing & Kill-Rules | Enforces statistical sample gates (`>= 1,000` impr or `>= 30` clicks), flags `LOW`-labeled assets and zero-conversion ads for pausing, and identifies single-ad Ad Groups needing challenger variants. |
| `Stage 4` | `rd-asset-intelligence` | Creative Portfolio Health & Redundancy | Computes a **0–100 Composite Creative Health Score**, classifies Ads into **Clickbait Traps vs Hidden Gems vs Scalable Winners**, flags redundant RSA headlines via **Jaccard Similarity (`>= 0.70`)**, and pauses underperformers. |
| `Stage 5` | `rd-search-term-intel` | Search Intent & Drift Control | Cross-checks `search_term_view` against `keyword_view` inventory, separates Commercial High-Intent vs Info/Freebie Drain vs Close-Variant Drift, and executes batch Exclusions, `EXACT` Promotions, or PMax Search Theme injections. |
| `Stage 6` | `rd-budget-scaling` | Micro-Step Budget Scaling | Combines Budget Lost IS, CPA/ROAS guardrails, and a daily conversion **Volatility Circuit Breaker** (Coefficient of Variation) to stage **+15% Micro-Step scale-ups** or **-20% defensive cuts**. |
| `Stage 7` | `rd-format-placement` | Cross-Format & Placement Yield | Benchmarks channel yield (`SEARCH`, `PERFORMANCE_MAX`, `DEMAND_GEN`, `DISPLAY`, `SHOPPING`) and Device splits (`DESKTOP`, `MOBILE`, `TABLET`), then excludes zero-conversion Display/Video/App placements at Account scope. |
| `Stage 8` | `rd-anomaly-health` | Z-Score Anomaly & Self-Healing | Runs daily **Z-Score Anomaly Detection** (`\|Z\| >= 2.0`) on Spend & Conversion curves + tracking outage alerts alongside 7d Change History and Policy Diagnostics, offering supervised emergency pause or Target CPA tightening. |
| `Stage 9` | `rd-predictive-forecast` | Holt-Winters Forecast & Fatigue Decay | Runs **Double Exponential Smoothing (Holt-Winters trend)** on 30-day daily time series to project Spend/Clicks/Conversions/CPA + **CTR Fatigue Decay slope** + Keyword Planner expansion scenarios that feed back into Stage 1. |

---

## Phase 5 — Pre-Flight Safety Gates & Persistent Episodic Memory (`storage/`)

Every write action initiated by Phases 3 or 4 passes through `src/safety.js` and `src/memory.js`:

1. **Ad Copy Compliance Sanitizer (`sanitizeAdCopy`)**: Enforces 30-char headline / 90-char description caps and strips trailing `!` / `.` and restricted hype terms before API submission.
2. **Pre-Flight Validation (`validate_only: true`)**: Every Mutate call validates schema and Google Ads API policy/entity integrity prior to live execution.
3. **Human Confirmation & `PAUSED` Default**: Interactive approval prompt before writing live, with new campaigns, ad groups, ads, asset groups, and promoted keywords defaulting to `PAUSED`.
4. **Episodic Memory Persistence (`storage/`)**:
   - `storage/memory/change-events-ledger.json` — Fingerprinted `change_event` audit trail with 7-day Pre/Post performance verdicts (`POSITIVE_LIFT`, `NEUTRAL`, `NEGATIVE_REGRESSION`).
   - `storage/memory/decision-log.json` — Chronological log of every dry-run and live mutation executed through `ads-automation-kit`.
   - `storage/memory/angle-knowledge-base.json` — Persisted messaging angles linking Stage 1 (`rd-angle-discovery`) to Stage 2 (`rd-asset-generator`).
   - `storage/runs/*.json` — JSON artifacts saved after every agent run.

---

## Complete CLI Reference

```bash
ads-automation-kit                         # Interactive 25-Agent & 56-Tool Workspace
ads-automation-kit setup                   # Credentials + OAuth2 (port 8085) + Antigravity MCP
ads-automation-kit auth                    # OAuth2 browser consent flow on port 8085
ads-automation-kit refresh-token           # Non-interactive access token refresh
ads-automation-kit config-import <path>    # Import config.json from ai-ads-pipeline / swa-google-ads-mcp
ads-automation-kit status [--live]         # Inspect config, tokens, MCP status & test API access
ads-automation-kit agents [--group ... ]   # List all 25 CLI Agents in sequential order
ads-automation-kit run <agentId> [opts]    # Run any agent directly (--customer-id, --date-range, --json, --dry-run)
ads-automation-kit watch-changes [-i 60]   # Continuous Change History Event Listener (--watch)
ads-automation-kit tools [--category ...]  # List all 56 numbered Google Ads MCP tools
ads-automation-kit call <tool> --args '{}' # Invoke any MCP tool directly (--validate-only supported)
ads-automation-kit mcp                     # Start Stdio MCP Server (also via ads-kit-mcp)
ads-automation-kit install-agy [--dry-run] # Register MCP server in ~/.gemini/config/mcp_config.json
ads-automation-kit uninstall-agy           # Remove MCP registration from Antigravity
```

Developer / CI flags: pass `--inside-agy` or set `AGY_SESSION=1`.

---

## ⚡ Built with Google Antigravity CLI

This project was built and optimized with the **Google Antigravity CLI** (`agy`). It features deep native integration into Antigravity IDE and CLI agent loops, structured JSON-RPC Stdio MCP protocol bindings, safety circuit breakers, and zero-leak guardrails.

---

## License

MIT License — see [LICENSE](./LICENSE).
