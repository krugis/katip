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

## 3. LiteLLM configuration (`infra/litellm/config.yaml`)

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
| `PERSON` | NER model: start with spaCy `xx_ent_wiki_sm` (multilingual); evaluate a Turkish BERT NER model (verify licence) | Ayşe Yılmaz |
| `TR_VKN` (tax no) | 10 digits + checksum, context words "VKN", "vergi" | – |

Policy modes per tenant:

- `off`
- `mask` (default for Business and Studio)
- `block` (reject when any listed entity is found)

Per-entity overrides are allowed, for example `PERSON: off` for HR tenants who need names.

Test set: `packages/pii/test/fixtures/tr-*.json` with at least 200 Turkish sentences. Target recall ≥ 0.95 for TCKN/IBAN/phone/email and ≥ 0.80 for PERSON before GA.

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
- Thresholds 50/80/100% raise events: `budget.threshold` → notifications (email + console banner).

## 7. Observability

- **OpenTelemetry traces** per request. Spans: auth, policy, pii, route, upstream, settle.
- **Attributes:** `tenant.slug`, `model.alias`, `model.name`, `quota.class`, `pii.entities_count`. Never prompt text.
- **Prometheus metrics:**
  - `gw_requests_total{tenant,alias,model,status}`
  - `gw_tokens_total{tenant,class,dir}`
  - `gw_upstream_latency_seconds`
  - `gw_pii_entities_total{type}`
  - `gw_quota_denials_total`

## 8. Acceptance criteria

- A LibreChat chat on `auto` uses DeepSeek V4 Flash. The usage row has correct tokens and cost (±1% vs provider usage).
- With the primary provider forced to 500, the response comes from the fallback; the audit row has `fallback=true`.
- A prompt containing a TCKN, an IBAN and a phone number reaches LiteLLM with placeholders (verified by a LiteLLM debug hook in the test env). The user sees the original values in the answer.
- A tenant at 100% with `block` gets HTTP 429 with an OpenAI-style error that LibreChat displays. `downgrade` routes `best` → standard.
- `GET /v1/models` for a tenant without the KVKK add-on does not list `tr-local`.
- Load test: 50 concurrent streaming chats through the gateway against a mock provider. Gateway CPU stays under 1 vCPU and p95 overhead under 120 ms.
