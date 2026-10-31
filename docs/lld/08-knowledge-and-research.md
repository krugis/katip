# LLD-08 — Knowledge, connectors and deep research (phase 2)

## 1. Two kinds of knowledge

| Kind | Implementation | Phase |
| --- | --- | --- |
| Files a user uploads into a chat | LibreChat built-in file search via the shared **RAG API** + pgvector. Embeddings go through the gateway `/v1/embeddings` (BGE-M3), so they are metered and governed | 1 |
| Company knowledge (SharePoint/OneDrive, Google Drive, Confluence, file shares) | Our **knowledge service** (`apps/knowledge`), exposed to LibreChat as an **MCP server** with tool `search_company_knowledge` | 2 |

## 2. Knowledge service

### 2.1 Components

- **Connectors** (BullMQ workers):
  - Microsoft Graph (delta queries on drives and sites);
  - Google Drive (changes API);
  - Confluence (REST);
  - SMB/WebDAV (later).
- **Ingestion:**
  - fetch file;
  - parse with **Docling** (Python container, unmodified; called over HTTP);
  - chunk (about 800 tokens with 100 overlap, heading-aware);
  - embed through the gateway;
  - store in pgvector (`kb_chunks`).
- **Permissions:** for each document, store the readers (users and groups from the source ACL) in **OpenFGA** as tuples `document:<id>#viewer@user:<email>` and `group:<id>#member@user:<email>`.
- **Retrieval:** hybrid search (pgvector cosine + Postgres full-text in the `turkish` config) → filter by OpenFGA `ListObjects` (or a per-user cached allowed-doc set) → rerank (optional, phase 2b) → top-k with citations (title, URL, modified date).

### 2.2 Tables (`knowledge` schema, RLS by tenant)

| Table | Columns |
| --- | --- |
| `kb_sources` | tenant_id, type, name, config (encrypted), status, last_sync_at |
| `kb_documents` | tenant_id, source_id, external_id, title, url, mime, hash, modified_at, acl_version |
| `kb_chunks` | tenant_id, document_id, ordinal, text, embedding vector(1024), tsv tsvector |

### 2.3 MCP server

- **Transport:** streamable-http at `http://knowledge:8090/mcp`.
- **Headers set by LibreChat:**
  - `X-User-Email: {{LIBRECHAT_USER_EMAIL}}`;
  - `Authorization: Bearer <tenant gateway key>` (tenant identification).
- **Tools:**
  - `search_company_knowledge(query, top_k=8, source?)` → chunks with citations;
  - `get_document(id)` → a longer excerpt, after a permission check.
- Every tool call is audited (`kb.search`) with the result count, never the query text unless the tenant opted in.

## 3. Deep research

- **Engine:** GPT Researcher (Python container, unmodified; verify the licence) configured to use our gateway as its OpenAI-compatible LLM (model `auto` or `fast`) and SearXNG for web search. Optionally add `search_company_knowledge` as an internal source.
- **Wrapper:** `apps/research` (TypeScript) exposes the MCP tool `deep_research(question, depth=standard|deep, include_company_knowledge=false)`. It then:
  1. calls the gateway `POST /v1/research/runs` to reserve a run (quota check → 429 if exhausted);
  2. starts the GPT Researcher job and streams progress;
  3. returns a Markdown report with sources;
  4. settles tokens through normal gateway metering, since all its LLM calls carry `X-Research-Run-Id`.
- **Limits:** standard depth at most 12 minutes and 200k tokens; deep at most 25 minutes and 600k tokens. Configurable per plan.

## 4. Acceptance criteria

- A user without access to a SharePoint file never gets chunks from it (test with two users, two folders, revoked access → removed within one sync cycle, at most 15 min).
- `search_company_knowledge` p95 under 800 ms for 100k chunks per tenant on the pilot host.
- A deep-research run decrements the run counter by 1 and its token usage appears under `source = research`.
- Turkish queries retrieve Turkish documents with recall@8 ≥ 0.8 on a 50-question internal test set.
