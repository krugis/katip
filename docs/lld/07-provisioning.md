# LLD-07 — Tenant provisioning (instance per tenant)

`apps/provisioner` makes tenant lifecycle operations repeatable and idempotent. It's a TypeScript CLI today; the internal HTTP API for console-api comes when the console needs it, and needs the Docker socket proxy (P1-35) first.

**How it runs.** `pnpm tenant:create` runs on the host and does the Docker work. It then starts the provisioner in a container on the `backend` network, for Postgres (as `katip_provider`), Keycloak (as the `katip-provisioner` service account, limited to our realm) and Mongo. So that container needs no Docker socket. `pnpm dev:up` uses the same path for the tenants in `katip.config.yaml`, so every install tests it.

**Where tenants live.** The database is the source of truth. The config only lists which tenants dev should create. On a host, `infra/env/tenants/<slug>.secrets.env` marks a tenant as known, so tenants made by the CLI keep their network across `dev:up` re-runs and are removed by rollback.

**Secrets.** You edit `infra/env/katip.env` for the platform. Each tenant's secrets are generated into `infra/env/tenants/<slug>.secrets.env`, gitignored and readable only by its owner, and never edited by hand. Production will encrypt these with SOPS (P0-22).

## 1. Commands

```bash
pnpm tenant:create  --slug acme --name "ACME A.Ş." --plan business --seats 10 --admin-email it@acme.com.tr [--region eu] [--kvkk] [--domain ai.acme.com.tr]
pnpm tenant:suspend --slug acme
pnpm tenant:resume  --slug acme
pnpm tenant:delete  --slug acme --confirm acme      # soft delete; data purge after 30 days via job
pnpm tenant:upgrade --slug acme | --all             # roll LibreChat version / config
pnpm tenant:render  --slug acme                     # re-render config only (dry run shows diff)
```

## 2. `tenant:create` steps

Each step is idempotent, checks for existing state, and records progress in the `jobs` table. A re-run finishes a failed attempt. On a complete tenant it changes nothing and says "already exists". **Built so far (P1-21, P1-22):** steps 1 to 4, 6, 8 and 10 to 12. Lago (7) and Cloudflare (9) come with their own milestones. The admin's invite goes out last, after the smoke test, so nobody gets a link to something that isn't running.

1. Validate the slug (unique, `^[a-z0-9-]{3,32}$`) and plan; insert `tenants`, `subscriptions`, `seats`, a default `tenant_policies`, and `access_rules` (MFA required, countries TR + EU).
2. **Keycloak:**
   - create organization `<slug>`;
   - create client `lc-<slug>` (redirect URIs, web origins) and client role `member`;
   - create the first tenant admin user (`--admin-email`) and send the invite email: set a password and enrol MFA. The DB row is written after the email goes out, so a re-run resends a failed invite, and only then.

   A tenant's limits start as the plan's quotas × seats, pooled across the company.
3. **MongoDB:** create database `lc_<slug>` and a user with `readWrite` on that database only.
4. **Network and search:** create the network `<project>_t_<slug>` with a subnet from the tenant's slug, and attach Traefik, the gateway and Mongo to it. Generate a key for the tenant's own Meilisearch, which starts with its compose project: LibreChat has no index prefix setting (LLD-01 §2.2).
5. **LiteLLM (deferred, P1-64):** a team `<slug>` with a max budget (backstop = 150% of the plan's expected monthly cost) and a virtual key for the gateway. LiteLLM has no database today, so it has no teams or keys. The gateway enforces quotas, and LibreChat can't reach LiteLLM. What's missing is a second, independent spending limit.
6. **Gateway key:** generate `sk-sme-t-…` and store its hash in `gateway_keys`. The plaintext goes into the tenant's secrets file only. If the two ever disagree, the secrets file wins: the old key is revoked, and the new hash stored.
7. **Lago:** create the customer and subscription (from milestone M3).
8. **Render files:**
   - `infra/env/tenants/<slug>.env` (SOPS-encrypted), containing Mongo URI, OIDC client, gateway key, `CREDS_KEY`/`CREDS_IV`/`JWT_SECRET` (random per tenant, never shared), and `RAG_API_URL`;
   - `infra/env/tenants/<slug>.meili.env`, holding only that Meilisearch key;
   - `infra/librechat/rendered/<slug>.librechat.yaml` from `librechat.tmpl.yaml`, with endpoints (LLD-03 §1.2), interface settings, the MCP servers enabled by plan, and the file upload limits of the plan;
   - `infra/compose/tenants/<slug>.yml` from `tenant.tmpl.yml`;
   - Traefik middleware `<slug>-ipallow` from `access_rules`.
9. **Cloudflare:** DNS record `<slug>.<domain>` (proxied) and the WAF country rule (API token with limited zone scope).
10. **Start:** `docker compose -p <project>-<slug> -f tenants/<slug>.yml up -d`. Wait for `GET /health` (verify the LibreChat health route), timeout 180 s.
11. **Smoke test:**
    - OIDC discovery reachable;
    - the gateway accepts the tenant's key, and once the admin exists serves them `/v1/models`. A real chat call waits until the gateway can count a system event without billing it. `dev:up` runs a full login and chat for its own tenants.
12. Write an audit entry and mark the job done.

**Never delete and recreate a Keycloak user.** A new user gets a new id, and LibreChat refuses a known email arriving with a new id, which locks that person out. Disable users instead.

Rollback: if a tenant's first attempt fails before the invite, everything it made is removed in reverse: containers and volumes, Mongo database and login, Keycloak client and organization, governance rows, network, files. The job ends `failed` with the step name, and a `tenant.rollback` job records why. The rows go through the admin role from the host, because the provisioner's role can't delete anything. Failure on a tenant that already existed changes nothing, and a tenant with users is never rolled back, whatever the caller believes. If an undo step fails too, for instance with Keycloak down, the secrets file stays, and running the same command again finishes the tenant.

## 2a. Suspend, resume, delete and purge (P1-23)

| Command | What happens | Data |
| --- | --- | --- |
| `tenant:suspend` | Status `suspended`, containers stopped. The gateway refuses it within a minute, its key cache being 60 s | Kept |
| `tenant:resume` | Status `active`, containers started, smoke test. Also restores a deleted tenant until its purge starts | Kept |
| `tenant:delete --confirm <slug>` | Status `deleted`, containers stopped, a `tenant.purge` job due in 30 days. Refuses a tenant listed in the config | Kept for the 30 days |
| `tenant:purge-due` | Runs the purges whose wait is over | See below |

**A purge destroys:** the tenant's containers and volumes (chats' search index, uploads), its Mongo database and login, its Keycloak organization and client, members who belong to no other company, its network, and its files and secrets.

**A purge keeps**, for the periods in LLD-10 §8: `usage_events`, invoices and the audit log. So they stay usable but say nothing about who it was, the tenant's `users` rows are anonymised (email, name, Keycloak id), `requests.payload` is emptied and export links in `privacy_requests` are cleared. Its gateway keys are revoked. The owner decided this on 2 Nov 2026; counsel should confirm it's enough for KVKK (P1-49). IP addresses in the audit log stay for its 5 years, and backups age out after 30 days.

**A slug is never reused.** The tenant's row stays with status `deleted`, so old links and audit entries can't appear to belong to a new company.

The purge has two stages so a resume can't race it: once it starts, a tenant can't be restored. If it stops part-way, a re-run finishes it. The daily job below runs it.

## 2b. One person's deletion (P1-69)

1. **They ask** in the portal. Nothing is deleted yet.
2. **The company's admin approves it**, after a warning that it can't be undone. Login stops at once, and they stop managing any department. A company's last admin is refused. Only the job below can mark a deletion as done.
3. **`pnpm tenant:forget-due` carries it out.** It skips a suspended company, whose containers are stopped, until it's resumed. The daily job below runs it. It's safe to repeat if it stops part-way.

| Where | What happens |
| --- | --- |
| Search index (Meilisearch) | Their messages and conversations are removed, and the job waits until that has really happened |
| Uploaded files | Their folders are removed |
| LibreChat (Mongo) | Everything they own, in every collection: chats, files' records, presets, memories, agents, prompts, shared links, keys, and their account. Where they only granted someone else access, the access stays without their name. They leave shared groups |
| Keycloak | Their login is removed. If they also belong to another company, only this membership ends. Platform staff are refused |
| Our database | Their row is anonymised and marked `deleted`, which hides it from the users list. Their requests are emptied, export links cleared and keys revoked |

**What stays:** usage rows under the id, so the company's totals still add up, and audit entries, which hold ids and no names or emails. The audit log's IP addresses stay for its 5 years. **Backups** still hold them until they age out after 30 days.

**Agents and prompts they wrote are deleted too**, including ones their colleagues use. Moving them to a colleague would be a later feature.

## 2c. The daily job (P1-65)

`pnpm tenant:daily` carries out approved deletions, runs the purges that are due, removes data past its retention period (LLD-10 §8), that is usage after 24 months, audit entries after 5 years and each company's old chats, and stores the central bank's USD rate. **The schedule is off by default.** Until someone sets `jobs.daily_at` in the config, nothing runs it and someone has to run the command. When it's set, `dev:up` adds one line to this user's crontab, and rollback takes it out. It needs Docker on the host, which is why it isn't in a container. Each part is safe to repeat, and one failing doesn't stop the rest.

Each run is recorded in the audit log, and the provider console's company list says if the job failed, has never run, or hasn't run for 26 hours. **That's a notice on a screen someone has to look at.** A phone alert needs monitoring (P1-43). A machine that's off at that time, such as WSL, runs nothing until the next day, when everything still due is picked up.

The retention function holds its periods itself, so the provisioner's role can call it without being able to delete anything newer, or to delete at all.

### Old chats (P1-70)

Each running company has a period, `tenant_policies.chat_retention_months`: 12 by default, and 1 to 120 as its admin sets it on the policy page, with the database refusing anything else. There is no "never". A suspended company waits until it's resumed.

A chat goes when its conversation's `updatedAt` is older than the period, in calendar months back in UTC, and neither it nor any of its messages has a date since then. LibreChat moves `updatedAt` on each message. A conversation with no date is left alone, and so is one whose id another person's recent conversation shares. Pinned, archived and bookmarked chats go like any other, and a shared link to one stops working.

For each company, in batches:

1. The provisioner picks the oldest chats past the period. It reads the period itself, so the host can't ask for anything younger to go. It returns ids and counts, never a title, text or file name.
2. The host removes them from the search index, and waits until that's done. LibreChat's indexes can be filtered only by `user`, so this goes by id: `messageId` in `messages` and `conversationId` in `convos`.
3. The host removes the files that can go, by id, from the LibreChat container.
4. The provisioner checks again that nothing has come back to life, then deletes the file records, then every document with that `conversationId` in any collection, the conversation last, then writes one `chat.retention` audit entry with counts. LibreChat's bookmark and project counts are recounted.

If it stops anywhere, the next run finds the same chats and finishes. A failure in one company doesn't stop the others, and nothing reaches Mongo until steps 2 and 3 are done.

**Limits:** 200 chats or 20,000 messages a batch and 25 batches a run, so 5,000 chats a day for each company. The rest wait for the next run, and `chatBacklog` in the `platform.daily` record counts the companies with more waiting. That record holds counts only: `expiredChats`, `expiredChatMessages`, `expiredChatFiles`, `chatFilesKept`.

**A file goes with its chat only if all of these hold:** it was made for a chat (`message_attachment`, `image_generation`, `execute_code`), it hasn't been used since the cutoff, it has no vectors, it's stored locally under its owner's folder with a name starting with its id or is only text in the database, and no other chat, shared link, preset, assistant or agent, including an agent's old versions, points at it. Anything else stays, with its record, and is counted in `filesKept`.

**Not covered:**

- A chat image uploaded by a person is named after the original file rather than its id, so two uploads of the same name can share one file, and it stays. It lives in the container, not on a volume, so it does go when the container is recreated, but its record stays.
- Messages whose conversation no longer exists, as nothing selects them.
- An old file no chat points at any more, such as one from a chat a person deleted themselves. LibreChat leaves those for them to delete in "My files".
- Backups hold deleted chats until they age out after 30 days (LLD-10 §8).
- A chat imported with old dates counts as old, and goes in the next run.

## 3. librechat.tmpl.yaml (key parts)

```yaml
version: 1.x.x            # match pinned LibreChat config version
cache: true
interface:
  privacyPolicy: { externalUrl: "https://<domain>/gizlilik", openNewTab: true }
  termsOfService: { externalUrl: "https://<domain>/kosullar", openNewTab: true }
  # hide endpoints other than ours; verify available interface flags for pinned version
endpoints:
  custom: [ ...LLD-03 §1.2... ]
fileConfig:
  serverFileSizeLimit: 20       # MB, by plan
mcpServers:
  # phase 2, enabled by plan:
  # company-knowledge: { type: streamable-http, url: "http://knowledge:8090/mcp", headers: { X-User-Email: "{{LIBRECHAT_USER_EMAIL}}", Authorization: "Bearer ${SME_GATEWAY_KEY}" } }
  # deep-research:     { type: streamable-http, url: "http://research:8091/mcp", headers: { ... } }
```

Also in the tenant env:

- `ENDPOINTS=custom,agents`, so only our gateway and agents are shown.
- Web search through SearXNG (`SEARXNG_INSTANCE_URL`).

Verify the exact env names on the pinned version.

## 4. Upgrades

- Each LibreChat version upgrade is first rolled to `test` tenants, then pilot, then all.
- `tenant:upgrade --all` does the following:
  - renders the new files;
  - pulls the image;
  - recreates containers one tenant at a time;
  - health-checks each tenant and stops on the first failure.
- A Mongo backup snapshot runs before every major LibreChat upgrade. **Not yet:** backups come with P1-42, so do this by hand until then.

## 5. Resource notes

- Limit per LibreChat container: 1 GB RAM, 1 vCPU. Measure real idle and peak in the pilot (open question).
- Idle tenants (no login for 14 days, Starter plan): optional scale-to-zero with a Traefik "wake" page in phase 2 (Sablier or a similar proxy plugin; verify the licence).

## 6. Acceptance criteria

- `tenant:create` on the dev stack completes in under 3 minutes and the tenant admin can log in.
- Running `tenant:create` twice with the same slug is a no-op (idempotent), with exit code 0 and the message "already exists".
- `tenant:delete` followed by the purge job removes the Mongo database, the Keycloak org and client, and the compose project, and later the LiteLLM team (P1-64) and DNS. The audit trail remains.
- A failed step 5 leaves no orphaned Keycloak client or Mongo database (compensation tested).
