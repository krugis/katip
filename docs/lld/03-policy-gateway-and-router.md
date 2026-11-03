# LLD-03 — Policy gateway and LLM router

`apps/policy-gateway` is a TypeScript service (Fastify) that exposes an **OpenAI-compatible API**. It is the only path to LLMs. LiteLLM sits behind it as the provider abstraction.

## 1. Endpoints

| Method + path | Purpose | Notes |
| --- | --- | --- |
| `POST /v1/chat/completions` | Chat (stream and non-stream) | Main path from LibreChat custom endpoint, Studio, knowledge service |
| `POST /v1/embeddings` | Embeddings (RAG) | Routed to BGE-M3 (or tenant policy), counted as standard tokens |
| `GET /v1/models` | Model list **filtered by tenant policy** | LibreChat `models.fetch: true` shows only allowed aliases |
| `POST /v1/research/runs` | Deep-research run accounting (phase 2) | Called by the research MCP server; decrements run quota |
| `GET /healthz`, `GET /readyz`, `GET /metrics` | Ops | `/metrics` on an internal port only |

### 1.1 Model aliases exposed to users

| Alias (shown in LibreChat) | Meaning |
| --- | --- |
| `auto` (default) | Router decides (rules in §4) |
| `fast` | Standard class, fastest/cheapest allowed model |
| `best` | Premium class (consumes premium quota) |
| `tr-local` | KVKK: Turkey-hosted model only (visible only with the KVKK add-on) |
| Explicit models | Optional, if the tenant admin enables "let users pick models" (from `tenant_model_allow`) |

### 1.2 LibreChat custom endpoint (rendered per tenant into `librechat.yaml`)

```yaml
endpoints:
  custom:
    - name: "SME AI"
      apiKey: "${SME_GATEWAY_KEY}"
      baseURL: "http://policy-gateway:8080/v1"
      models:
        default: ["auto", "fast", "best"]
        fetch: true
      titleConvo: true
      titleModel: "fast"
      summarize: false
      modelDisplayLabel: "SME AI"
      headers:
        X-User-Id: "{{LIBRECHAT_USER_ID}}"
        X-User-Email: "{{LIBRECHAT_USER_EMAIL}}"
        X-Conversation-Id: "{{LIBRECHAT_BODY_CONVERSATIONID}}"
```

The header placeholders are documented for custom endpoints. Verify `{{LIBRECHAT_BODY_CONVERSATIONID}}` on the pinned version.

## 2. Request pipeline

Each step is a Fastify hook or plugin with its own unit tests. The pure logic lives in `packages/policy-engine` and `packages/pii`.

| # | Step | Detail | On failure |
| --- | --- | --- | --- |
| 1 | Authenticate | Hash the bearer token → `gateway_keys` (Valkey cache 60 s) → `tenant_id`, key type | 401 |
| 2 | Identify user | `X-User-Email` → `users` (tenant-scoped, cache 60 s) → user, department, seat tier, status | 403 `user_not_provisioned` / `user_disabled` |
| 3 | Load policy | Merge tenant policy + department overrides → `EffectivePolicy` (cache 30 s; invalidated by pub/sub `policy.changed`) | – |
| 4 | Access checks | Tenant active; `CF-IPCountry` in allowed countries (if enforced); alias allowed; data-residency rule | 403 `policy_denied` with reason |
| 5 | Classify request | Estimate input tokens (tokenizer approximation: chars/3.5 for TR); detect task hints (§4) | – |
| 6 | Choose model | Router rules → ordered candidate list `[primary, fallback1, …]` with class `standard`/`premium`/`tr` | 403 if no candidate allowed |
| 7 | Quota reservation | Estimate cost (input + `max_tokens` or default 1,024 out); atomic Lua script in Valkey: check pooled counters (tenant, month, class) + department budget + user cap → reserve | Per tenant setting: `block` → 429 `quota_exceeded`; `downgrade` → re-route to the cheaper class; `overage` → continue, flag `overage=true` |
| 8 | PII masking | `packages/pii`: Presidio analyze (TR + EN) on user/system messages → replace entities with stable placeholders `⟦PERSON_1⟧`, keep the map in request memory only. Skip if `policy.pii.mode = off`; `block` mode rejects requests containing listed entity types | 400 `pii_blocked` (block mode) |
| 9 | Call LiteLLM | `POST http://litellm:4000/v1/chat/completions`, `model = <litellm model name>`; `user = <tenant_slug>:<user_id>`; `metadata = {tenant, dept, conversation, alias}`; LiteLLM key = per-tenant **virtual key** (team = tenant) so LiteLLM budgets act as a backstop | Upstream error → next candidate (step 6 list) up to 2 retries; then 502 |
| 10 | Stream + un-mask | Pass SSE chunks through; a streaming un-masker buffers text until no partial `⟦…` placeholder can still complete (max buffer 64 chars), then emits restored text | – |
| 11 | Settle usage | From the final `usage` (or LiteLLM response cost header, verify name: `x-litellm-response-cost`) → write `usage_events` row; adjust the Valkey reservation to actual; release on error | Write to an outbox in Valkey if Postgres is down; a worker replays it |
| 12 | Audit | `audit_log` entry for denials, PII hits (counts by entity type only), overage, fallback | – |

Latency budget added by the gateway, excluding the provider: p50 under 40 ms, p95 under 120 ms (PII analysis dominates; run Presidio with 2 workers and cache recognizers).

## 3. LiteLLM configuration

The model list lives in `katip.config.yaml` (`models`), and the bootstrap renders the LiteLLM config from it. The same list seeds `model_catalog`.

```yaml
model_list:
  - model_name: std-deepseek-v4-flash
    litellm_params: { model: deepinfra/deepseek-ai/DeepSeek-V4-Flash, api_key: os.environ/DEEPINFRA_API_KEY }   # verify exact model id
  - model_name: std-glm-5.3-flash
    litellm_params: { model: openrouter/z-ai/glm-5.3-flash, api_key: os.environ/OPENROUTER_API_KEY }
  - model_name: std-gemma-4-26b
    litellm_params: { model: deepinfra/google/gemma-4-26b-a4b-it, api_key: os.environ/DEEPINFRA_API_KEY }   # verify id
  - model_name: prem-claude-sonnet-5.5
    litellm_params: { model: anthropic/claude-sonnet-5-5, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: prem-gemini-4-argon
    litellm_params: { model: vertex_ai/gemini-4-argon, vertex_project: os.environ/GCP_PROJECT, vertex_location: europe-west3 }   # verify id
  - model_name: emb-bge-m3
    litellm_params: { model: deepinfra/BAAI/bge-m3, api_key: os.environ/DEEPINFRA_API_KEY }
  - model_name: tr-gpt-oss-120b
    litellm_params: { model: openai/gpt-oss-120b, api_base: http://vllm-tr:8000/v1, api_key: os.environ/VLLM_TR_KEY }
router_settings:
  routing_strategy: simple-shuffle
  num_retries: 1
  timeout: 120
litellm_settings:
  drop_params: true
  cache: true
  cache_params: { type: redis, host: valkey, port: 6379 }
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/LITELLM_DATABASE_URL
  store_prompts_in_spend_logs: false
```

Notes:

- Provider choice follows the privacy rule: only zero-retention, no-training providers for customer data. OpenRouter is allowed **only** with the account setting "no training providers" plus provider allowlisting per model; prefer direct DeepInfra, Anthropic or Vertex.
- `model_catalog` in Postgres maps `litellm model_name` → class, price per 1M tokens in/out, region, data policy, enabled. The gateway reads the catalog; LiteLLM never decides policy.

## 4. Routing rules (v1, data-driven, `router_rules` table)

Evaluated top to bottom; the first match wins. Rules can be edited by provider admins and are overridable per tenant.

| Priority | Condition | Route |
| --- | --- | --- |
| 10 | Tenant or department `residency = TR_ONLY` | `tr` class only (`tr-gpt-oss-120b`); never fall back outside TR |
| 20 | Alias `best` | premium: `prem-claude-sonnet-5.5` → `prem-gemini-4-argon` |
| 30 | Alias `fast` | standard: `std-deepseek-v4-flash` → `std-glm-5.3-flash` → `std-gemma-4-26b` |
| 40 | Alias `auto` AND (input tokens > 60k OR tools/attachments with complex reasoning hint OR user pressed "think harder") AND premium quota left | premium as `best` |
| 50 | Alias `auto` (default) | standard as `fast` |
| 60 | Background task (title, summary; header `X-Task: background`) | cheapest standard model |

The phase 2 learned router (RouteLLM-style) replaces rule 40 behind a feature flag once we have labelled traffic.

## 5. PII masking (`packages/pii` + Presidio)

| Entity | Recognizer | Example |
| --- | --- | --- |
| `TR_TCKN` | Regex `\b[1-9]\d{10}\b` + TCKN checksum validation | 10000000146 |
| `TR_IBAN` | Regex `\bTR\d{2}\s?(\d{4}\s?){5}\d{2}\b` + IBAN mod-97 | TR33 0006 1005 1978 6457 8413 26 |
| `TR_PHONE` | `(\+90|0)?\s?5\d{2}\s?\d{3}\s?\d{2}\s?\d{2}` | 0532 123 45 67 |
| `EMAIL_ADDRESS`, `CREDIT_CARD`, `IP_ADDRESS` | Presidio built-in | – |
| `PERSON` | Turkish BERT NER model `akdeniz27/bert-base-turkish-cased-ner` (MIT), fixed to one commit, baked into the image | Ayşe Yılmaz |
| `TR_VKN` (tax no) | 10 digits + checksum, context words "VKN", "vergi" | – |

Policy modes per tenant:

- `off`
- `mask` (default for Business and Studio)
- `block` (reject when any listed entity is found)

Per-entity overrides are allowed, for example `PERSON: off` for HR tenants who need names.

If Presidio fails or times out while `PERSON` is active, names can go undetected. The structured recognizers still run, and `policy.pii.onDetectorFailure` decides what happens next. Departments may tighten this setting but not loosen it.

- `allow` (default): the request continues and the response carries `x-katip-pii-degraded: true`.
- `block`: the request is rejected with 503 `pii_unavailable`, and the provider is not called.

### What may leave for a provider

The gateway is the one control point for LLM calls, including those made for user-added MCP tools and generated flows, so requests pass through an allow list (`maskChatRequest` in `packages/pii`). A field not on it is dropped, and its name, never its value, is logged as `request_fields_dropped`. Every string that can carry text is scanned: messages, tool results, earlier tool-call arguments, tool definitions, response schemas and file names.

- **Tool arguments stay masked.** The gateway unmasks reply text for the user, but not `tool_calls`, so a tool receives placeholders rather than real values. Users can add any MCP server, so this is what keeps personal data away from them. A tool asked to find a person by name therefore can't find them; a per-tenant list of trusted tools is possible later.
- **Placeholders hold for a whole conversation, and nothing is stored.** A placeholder such as `⟦PERSON_3fa9c1d2⟧` is an HMAC of the tenant, conversation and normalised value, using `PII_TOKEN_KEY`. Tool arguments and tool results come back holding placeholders, and the same value gets the same one on every request. They are keyed so a provider can't guess a TCKN from its token, and differ per conversation so they can't be linked. A reply can only restore a placeholder if its value is also in that request; otherwise the user sees the placeholder. Flows need the same scope (`X-Flow-Run-Id`) when Studio is built.
- **Tool calls are recorded by name.** Each tool the model asks to call goes in `usage_events.tool_calls` (one entry per call) and an info-level `tool_calls_requested` log event, with tenant, user and conversation. Arguments are never kept, as they can hold anything. This records what the model asked for, not whether the tool ran or what it returned: LibreChat runs the tools. Names that don't look like one are stored as `<invalid>`. There is no per-tenant allow or block rule yet.
- **Images, files and audio are allowed for now, unscanned**, and counted in a `non_text_content_sent` log event. Their contents reach the provider as they are. Filtering documents before they are sent is tracked as P3-11.
- **What this can't see:** what a tool does with what it receives, including an MCP server calling its own LLM, and personal data the detectors miss.

### When the detector fails

Both cases log an error-level `pii_detector_failed` event with `tenant_id`, `user_id` and `action`, never prompt text. Monitoring (P1-43) alerts on this event.

### How well it finds things

Test set: `packages/pii/test/fixtures/tr-recall.json`, made by `gen-tr-recall.mjs`: 392 Turkish sentences holding personal data and 30 without. Target recall ≥ 0.95 for each structured kind and ≥ 0.80 for PERSON. A name counts only if all of it is found, since half a name still identifies someone. The structured floor runs in the normal tests, and `pnpm test:pii-names` runs the name floor against a real analyzer. Both run in CI.

| Name model, 2 CPUs | Whole name | At least part | Clean sentences wrong | Licence |
| --- | --- | --- | --- | --- |
| spaCy `xx_ent_wiki_sm` (first choice) | 0.44 | 0.48 | 5 of 20 | MIT |
| `akdeniz27/bert-base-turkish-cased-ner` (in use) | 0.99 | 1.00 | 0 of 30 | MIT |
| `savasy/bert-base-turkish-ner-cased` | 0.96 | 1.00 | 0 of 20 | none stated, so not usable |

The spaCy row and the savasy row were measured on an earlier, 102-name version of the set, and savasy without this client's cut-off and span merging, so compare them with care.

These are made-up sentences written around common patterns, so **real text will score lower**. Measure again with real, anonymised text before relying on the number. The weakest case is lower-case names that are also words, such as "hatice kara".

The client keeps spans from a score of 0.3, because the model is often unsure of real surnames (0.48 for one), and it joins neighbouring spans into one name.

**Cost of this model:** the image grows from 1.5 GB to 3.7 GB, each of the two workers uses about 1 GB of memory, and on 2 CPUs a short sentence takes 47 ms at p50 and 75 ms at p95. That p50 is over the 40 ms budget above when nothing is cached. Long text is cut into pieces of 2,000 characters, and results are remembered in memory as positions under a hash, because each chat turn sends its history again. New text of 100,000 characters takes about 18 s and the next turn about 0.2 s. There is no GPU path yet.

## 6. Quotas and budgets

Valkey keys (monthly, UTC):

- `q:{tenant}:{yyyymm}:std_tokens`
- `q:{tenant}:{yyyymm}:prem_tokens`
- `q:{tenant}:{yyyymm}:research_runs`
- `q:{tenant}:{yyyymm}:dept:{id}:usd_micro`
- `q:{tenant}:{yyyymm}:user:{id}:usd_micro`

Rules:

- Limits come from seats × plan quota (DESIGN §5) plus purchased packs, cached in `tenant_limits`.
- A Lua script performs **check-and-reserve** atomically. Settlement adjusts by the delta.
- A nightly job reconciles Valkey with the Postgres `usage_events` sums; Postgres is the source of truth.
- Thresholds 50/80/100% of a company's monthly tokens tell its active admins by email, and show a banner on every console screen. `console-api` checks about once a minute, and records each in `budget_alerts`, so each is told once. If the email fails, the next check retries. Department budgets are in USD, so they wait for a customer price to compare with (P1-37).

## 7. Observability

- **OpenTelemetry traces** per request. Spans: auth, policy, pii, route, upstream, settle.
- **Attributes:** `tenant.slug`, `model.alias`, `model.name`, `quota.class`, `pii.entities_count`. Never prompt text.
- **Prometheus metrics:**
  - `gw_requests_total{tenant,alias,model,status}`
  - `gw_tokens_total{tenant,class,dir}`
  - `gw_upstream_latency_seconds`
  - `gw_pii_entities_total{type}`
  - `gw_quota_denials_total{tenant,class}`
  - `gw_overhead_seconds{tenant}`: what the gateway adds before calling a model, for the 120 ms budget
  - `gw_upstream_errors_total{model}`
  - `gw_pii_detector_failures_total{tenant,action}`
- **`/metrics` asks for a token (`KATIP_METRICS_TOKEN`), on port 9464.** It isn't routed from outside, but every company's LibreChat can reach this container, and these numbers show every company's usage.
- **Labels are company slugs, model ids and fixed words.** An alias that isn't one of ours is counted as `explicit`, so nothing a caller types becomes a label.
- **The dashboard** is `infra/monitoring/grafana/dashboards/gateway.json`. `pnpm test:metrics` runs a real Prometheus for the length of the test, and checks every query in it. Nothing runs Prometheus or Grafana for good yet, or collects traces (P1-43). Traces go out when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set.

## 8. Acceptance criteria

- A LibreChat chat on `auto` uses DeepSeek V4 Flash. The usage row has correct tokens and cost (±1% vs provider usage).
- With the primary provider forced to 500, the response comes from the fallback; the audit row has `fallback=true`.
- A prompt containing a TCKN, an IBAN and a phone number reaches LiteLLM with placeholders (verified by a LiteLLM debug hook in the test env). The user sees the original values in the answer.
- A tenant at 100% with `block` gets HTTP 429 with an OpenAI-style error that LibreChat displays. `downgrade` routes `best` → standard.
- `GET /v1/models` for a tenant without the KVKK add-on does not list `tr-local`.
- Load test: 50 concurrent streaming chats through the gateway against a mock provider. Gateway CPU stays under 1 vCPU and p95 overhead under 120 ms.

### Load baseline (P1-16)

`pnpm test:load`, on the 12-core dev machine in WSL (3 Nov 2026), with a short new message each time, so nothing comes from the cache. The analyzer is limited to the CPUs shown and has 2 workers. The gateway has no CPU limit, and is measured.

| Chats at once | Answer length | Analyzer CPUs | Messages per second | Overhead within 120 ms | First byte p95 | Gateway CPU, average |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | about 17 s | 2 | 2.8 | 98.2% | 77 ms | 5% |
| 50 | about 2.7 s | 2 | 14.2 | 0% | 1.3 s | 23% |
| 50 | about 2.7 s | 4 | 20.2 | 95.1% | 125 ms | 31% |
| 100 | about 2.7 s | 2 | 14.2 | 0% | 5.0 s | 24% |

- **The target is met at realistic answer lengths.** At short ones it depends on the analyzer's CPUs. What limits this is new messages per second: about 14 on 2 CPUs. Past that, requests queue, and nothing fails.
- **The gateway itself isn't the limit.** The name model is (LLD-03 §5).
- **The p50 budget of 40 ms isn't met.** Under 0.1% of requests here were within 50 ms, and first byte is about 70 ms at p50. The model takes most of that.
- **A name check timing out sends a request without name masking** under the default `allow`. None failed in these runs, but messages were short and each chat waits for its answer, which limits the queue. Long pasted text under load wasn't measured. A company that needs names always masked should use `onDetectorFailure: block`.
- **LiteLLM isn't in this path,** and nor are real providers. The gateway calls the mock directly, to measure the gateway. Each run adds usage to the first company in the config.
