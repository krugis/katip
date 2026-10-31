# LLD-09 — Studio: flow designer and agentic flows (phase 2)

Studio lets builders (Studio seats) design flows visually and run them on triggers. Business users can run flows that have been published to them. All LLM calls go through the policy gateway with the flow's identity.

## 1. Components

| Component | Tech | Role |
| --- | --- | --- |
| `apps/studio` | React + React Flow + shadcn (inside the console shell, Studio tab) | Designer, versioning, test runs, run history |
| `apps/studio-api` | Fastify routes in console-api | CRUD flows, publish, approvals, triggers, run queries |
| `apps/studio-runner` | BullMQ workers + LangGraph.js | Compiles flow JSON → StateGraph; executes; persists state |
| `studio` MCP server | Part of studio-api | Exposes published flows as MCP tools in LibreChat ("run flow X") |

## 2. Flow definition (JSON, versioned, Zod-validated)

```ts
type Flow = {
  id: string; tenantId: string; name: string; version: number;
  status: 'draft' | 'published' | 'archived';
  inputs: JsonSchema;                // shown as a form when run manually / via MCP
  nodes: Node[]; edges: Edge[];
  limits: { maxSteps: number; maxTokens: number; timeoutSec: number; budgetUsd: number };
  runAs: 'invoker' | 'service';      // whose permissions and quota
};
type Node =
  | { id: string; type: 'trigger'; kind: 'manual' | 'schedule' | 'webhook' | 'email' | 'file'; config: object }
  | { id: string; type: 'llm'; alias: 'auto' | 'fast' | 'best' | 'tr-local'; system: string; prompt: string; outputSchema?: JsonSchema }
  | { id: string; type: 'agent'; instructions: string; tools: string[]; maxIterations: number }   // tool-calling loop
  | { id: string; type: 'tool'; tool: string; args: object }           // MCP tool or connector action
  | { id: string; type: 'condition'; expression: string }              // JSONata over state
  | { id: string; type: 'loop'; over: string; body: string[] }
  | { id: string; type: 'human_approval'; approvers: string[]; message: string; timeoutH: number }
  | { id: string; type: 'http'; method: string; url: string; headers?: object; body?: string }   // allowlisted hosts per tenant
  | { id: string; type: 'output'; to: 'chat' | 'email' | 'webhook' | 'file' };
type Edge = { from: string; to: string; when?: 'true' | 'false' | string };
```

Templates (seeded):

- invoice e-mail → extract fields → ERP draft (human approval);
- customer reply draft;
- meeting notes summary;
- lead qualification.

## 3. Runtime

- On publish, the runner compiles the flow to a LangGraph.js `StateGraph`. Each node becomes a function that receives `{state, ctx}`. `ctx` carries:
  - `tenantId`, `flowRunId`, `actor`;
  - a gateway client with headers `X-Flow-Run-Id` and `X-Task: flow`.
- **Execution:** BullMQ queue `flows:<tenant>` (per-tenant concurrency limit, default 2). Each node step is a job. State is checkpointed to Postgres `flow_run_steps` after every node, so runs survive restarts.
- **Human approval:**
  - the node writes a `requests` row (type `flow_approval`) and notifies approvers (console + email);
  - the run is paused (BullMQ delayed job as a timeout);
  - approval resumes the run from the checkpoint.
- **Triggers:**
  - schedule = BullMQ repeatable job (cron, tenant timezone);
  - webhook = `POST /hooks/<flowId>/<secret>` through Traefik (rate-limited);
  - email = IMAP poller (phase 2b);
  - file = connector change event.
- **Guards:**
  - `limits` are enforced per run;
  - the gateway enforces tenant and flow budgets (`flow_budget_usd`);
  - HTTP node hosts are allowlisted per tenant;
  - secrets for tools are stored encrypted (OpenBao or SOPS-wrapped) and referenced by name only.

## 4. Data (`studio` schema, RLS by tenant)

| Table | Columns |
| --- | --- |
| `flows` | id, tenant_id, name, current_version, status, owner_id |
| `flow_versions` | flow_id, version, definition jsonb, published_by, published_at, approved_by |
| `flow_runs` | id, tenant_id, flow_id, version, trigger, actor_id, status, started_at, finished_at, tokens_std, tokens_prem, cost_usd_micro, error |
| `flow_run_steps` | run_id, node_id, attempt, status, input jsonb (redacted), output jsonb (redacted), started_at, finished_at |
| `flow_triggers` | flow_id, kind, config, secret_hash, enabled |

## 5. Permissions

| Action | Who |
| --- | --- |
| Create or edit flows | Studio seat |
| Publish to the department | dept_manager approval |
| Publish company-wide | tenant_admin approval (setting) |
| Run a published flow | any user in the audience. `runAs: invoker` uses the user's quota and knowledge permissions; `service` uses the flow's service identity with its own budget |

## 6. Acceptance criteria

- The four templates run end to end on the test stack.
- The invoice template pauses for approval and resumes after approval.
- Killing the runner mid-flow and restarting it resumes from the last checkpoint without repeating completed LLM nodes.
- A flow exceeding `limits.maxTokens` stops with status `limit_exceeded`, and the usage is still billed correctly.
- A published flow appears as a tool in LibreChat for users in its audience only.
