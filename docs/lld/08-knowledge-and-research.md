# LLD-08 — Knowledge, connectors and deep research (phase 2)

## 1. Two kinds of knowledge

| Kind | Implementation | Phase |
| --- | --- | --- |
| Files a user uploads into a chat | LibreChat built-in file search via **each tenant's own RAG API** and its own pgvector database (§1.1). Embeddings go through the gateway `/v1/embeddings` (BGE-M3), so they are metered and governed | 1 |
| Company knowledge (SharePoint/OneDrive, Google Drive, Confluence, file shares) | Our **knowledge service** (`apps/knowledge`), exposed to LibreChat as an **MCP server** with tool `search_company_knowledge` | 2 |

### 1.1 File search (P1-08)

The official RAG API (`librechat-rag-api-dev-lite`, MIT) and a Postgres with pgvector, in the tenant's compose project: `rag-<slug>` and `ragdb-<slug>`. LibreChat finds it through `RAG_API_URL`.

**Why one per tenant.** This design first had one shared service, which can't keep companies apart:

- It checks one `JWT_SECRET`, and each LibreChat signs with its own. Sharing it would let one company's LibreChat sign for anyone.
- In v0.9.0, the version LibreChat v0.8.7 can use, any valid token can list every file id (`GET /ids`) and read any file through `GET /documents`.
- Upstream fixes the second point in later builds, with chunks scoped to their owner. Those need a newer LibreChat first, because v0.8.7 doesn't send `entity_id` on delete, which would orphan agents' files. The fix wouldn't remove the first point.

So a token only ever opens the one tenant's files. Inside a tenant, LibreChat decides who may use a file, and `/query` also checks the owner. **This relies on only LibreChat holding that tenant's secret**: the RAG API has no route from outside, and its database isn't on any other tenant's network. The platform's Postgres stays off tenant networks, which is why the vectors aren't there.

**The path of a file:**

1. LibreChat posts it to `/embed` with a 5-minute token signed with its `JWT_SECRET`.
2. The RAG API cuts it into chunks of 1,500 characters and sends them to the gateway, 32 at a time, as text, on a service key (LLD-03 §1.3).
3. The gateway masks them per the company's policy, and sends them to the provider.
4. Postgres stores the **original** chunk text with the vector of the masked text.
5. A question arrives as the model's `file_search` tool call, already masked, and is embedded the same way. The chunks found go back to the model through chat masking.

**Deleting.** LibreChat deletes a file's chunks when someone deletes the file. One person's deletion removes their chunks and those of their files (LLD-07 §2b). A purge removes the containers and the volume.

**Limits, from reading the code and running it on its own (not yet through LibreChat):**

- Its logs hold the user id, file id and **file name**, and on a failed search the query. File names can hold personal data, and they're third-party logs we can't change. They stay in Docker's logs (at most 30 MB) until they rotate or the container is removed, and a person's deletion doesn't reach them.
- It keeps the last 128 queries' vectors in memory, so a repeated question isn't charged again.
- `/health` answers 200 even with its database down, so the health check reads the reply.
- Changing the embedding model means embedding every file again: old and new vectors can't be compared.
- `images.postgres` is also the image of these databases, so a new Postgres major version needs an upgrade of each one. They hold only what can be embedded again, but nothing does that yet.

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
