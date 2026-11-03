# Runbook: secret rotation

**Tested:** nothing. Written from `scripts/setup/steps.mjs`, `tenants.mjs`, `db-seed.mjs`, the compose files, the provisioner code and LLD-10 §3. No secret was rotated to write this.
**Applies to:** the dev stack on WSL. Production does not exist yet.

## Read this first

- **There is no rotation command.** LLD-10 §3 names `tenant:rotate-secrets`. It does not exist. Rotation today means editing a secret file by hand and re-running other commands.
- **Some secrets cannot be rotated safely today.** They are marked "NOT POSSIBLE" below.
- **Some secrets live inside a database.** Changing the env file alone then breaks the service. Those are marked "Change it in the database first".
- **The files hold real secrets.** Never print them, paste them, or commit them. Use `sed` or an editor to change one line; do not `cat` the file.
- LLD-10 §3 asks for a 90-day rotation of the LiteLLM master key, provider API keys, Keycloak admin, database passwords and the Cloudflare token. Nothing reminds anyone. The Cloudflare token does not exist yet.

## How secrets are stored today

| File                                | Holds                         | How a value gets there                                                          |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `infra/env/katip.env`               | Platform secrets              | Generated once by `pnpm dev:up`. **An existing value is never overwritten**     |
| `infra/env/tenants/<slug>.secrets.env` | One company's secrets      | Generated once. A value missing from the file is generated on the next run. Its header says "Do not edit" |

To make the bootstrap generate a new value:

- `katip.env`: set the key to `AUTO` (or leave it empty). Only keys in `AUTO_KEYS` in `scripts/setup/steps.mjs` are generated. Or type your own value, letters, digits, `-` and `_` only.
- A company's file: delete that one line. The next run generates a value in the right format and writes the file back. This is the only way. Names are `KATIP_T_<SLUG>_<NAME>`, with the slug in capitals and `-` as `_`.

After editing `katip.env`, `pnpm dev:up` sees the change and re-applies everything, and recreates the containers. After editing a company's file, `dev:up` does **not** notice (only `katip.env` and `katip.config.yaml` are watched). Use the steps in the company table below.

Rotate in a quiet hour. Expect a short outage.

## Platform secrets (`katip.env`)

For every row: the rotation is `AUTO` or a new value in `katip.env`, then `pnpm dev:up`, unless the row says otherwise.

| Secret | Used by | How to rotate | What breaks or changes |
| ------ | ------- | ------------- | ---------------------- |
| `LITELLM_MASTER_KEY` | LiteLLM, and the gateway (as its key to LiteLLM) | Edit, `pnpm dev:up` | Short outage while both restart. LiteLLM has no database in dev, so nothing else stores it |
| `KATIP_PII_TOKEN_KEY` | Gateway. The secret behind conversation placeholders (an HMAC of company, conversation and value, LLD-03 §5) | Edit, `pnpm dev:up` | **Placeholders change in ongoing conversations.** The same name gets a different placeholder than before. Where an old tool call or tool result in a conversation holds an old placeholder, the gateway cannot restore it, and the user may see `⟦PERSON_…⟧` in an answer. New conversations are fine. Nothing is exposed and nothing is lost. Do it out of hours, and tell companies. From LLD-03 §5, not tested |
| `KATIP_METRICS_TOKEN` | Gateway's metrics port (9464). No scraper exists yet | Edit, `pnpm dev:up` | Nothing today. Update any scraper when one exists (P1-43) |
| `VALKEY_PASSWORD` | Valkey (set as a start option), gateway, console API | Edit, `pnpm dev:up` | Short outage. Valkey's password is not stored in its data, so nothing else to change. I did not check what Valkey keeps (caches and counters, per the LLDs). Losing them is expected to be harmless; confirm before production |
| `KATIP_GATEWAY_DB_PASSWORD`, `KATIP_CONSOLE_DB_PASSWORD`, `KATIP_PROVIDER_DB_PASSWORD` | Postgres roles `katip_gateway`, `katip_console`, `katip_provider` | Edit, `pnpm dev:up`. The `governance-db` step runs `ALTER ROLE` with the new value | Value must be 32 or more characters of letters, digits, `-`, `_` (`db-seed.mjs` refuses others). Between that step and the container restarts, the running gateway and console API can fail on new connections for a short while |
| `KATIP_PROVISIONER_KC_SECRET` | Keycloak client `katip-provisioner`; the identity service; the provisioner | Edit, `pnpm dev:up`. The `identity` step writes it into Keycloak | The identity service fails until it restarts with the new value (short) |
| `KATIP_IDENTITY_TOKEN` | Console API and the identity service (shared) | Edit, `pnpm dev:up` | Short outage of identity actions in the console |
| Provider keys: `DEEPINFRA_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GCP_VERTEX_KEY`, `GCP_PROJECT`, `VLLM_TR_KEY` | LiteLLM | Create the new key at the provider, put it in `katip.env`, `pnpm dev:up`, check a chat, then revoke the old key at the provider | **If a key is left empty, that model silently routes to the mock model (it echoes).** Never clear a key to "turn it off". Not set by us: the provider's own console |
| `MOCK_LLM_KEY` | Mock model, LiteLLM. Dev only | Edit, `pnpm dev:up` | Nothing |
| `KATIP_LOCAL_LLM_KEY` | Local model relay. Dev only | Edit, `pnpm dev:up` | Nothing |
| `POSTGRES_PASSWORD` | Postgres role `katip` (admin). Set only the first time Postgres starts. Host scripts connect with it (database setup, tenant tidy-up) | **Change it in the database first.** (1) `docker exec -it katip-postgres-1 psql -U katip -d governance`, then `\password katip` and type the new value. (2) Put the same value in `katip.env`. (3) `pnpm dev:up` | Edit alone: `governance-db` and `tenant:create` fail with a password error. Use letters, digits, `-`, `_` only |
| `KC_DB_PASSWORD` | Postgres role `keycloak`. Created with this password the first time only | **Change it in the database first.** `docker exec -it katip-postgres-1 psql -U katip -d governance`, `\password keycloak`. Then `katip.env`, then `pnpm dev:up` | Edit alone: **Keycloak cannot reach its database after it restarts, so nobody can log in** |
| `LITELLM_DB_PASSWORD` | Postgres role `litellm`. Nothing uses the database in dev (no `database_url` in the LiteLLM config) | As `KC_DB_PASSWORD`, with `\password litellm`. **Also set `LITELLM_DATABASE_URL` to `AUTO`**, because it is derived once and keeps the old password | Nothing today |
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | Keycloak's first admin, created only on Keycloak's first start. Also used by our scripts to administer Keycloak (identity step, tests) | **Change it in Keycloak first.** Log in at `https://auth.localhost`, change the password of the admin user, then put the same value in `katip.env` | Edit alone: the `identity` step fails to log in, so `dev:up` fails. Keycloak itself keeps working |
| `MONGO_PASSWORD` | Mongo root user. Set only the first time Mongo starts. Used by the provisioner. Companies do not use it | **Change it in Mongo first.** `docker exec -it katip-mongodb-1 mongosh -u katip --authenticationDatabase admin admin`, then `db.changeUserPassword("katip", passwordPrompt())`. Then `katip.env`, then `pnpm dev:up` | Edit alone: provisioning, suspend, purge and chat retention fail. Chats keep working |

Not in `katip.env`, and not covered here:

- Keycloak realm keys, SMTP settings and every user's password and MFA: managed in Keycloak.
- The dev TLS certificate (`infra/traefik/dev-certs`, self-signed, valid 825 days). It is regenerated if its hostnames change. There is no renewal command. Dev only.
- Cloudflare token and origin certificates: not built (P1-44).

## A company's secrets (`infra/env/tenants/<slug>.secrets.env`)

The provisioner copies several of these into other systems (Keycloak, Mongo, the gateway database). It copies them again each time `create` runs for that company, so the file is the source of truth. LibreChat only reads its new values when its containers are recreated. So most rotations are two steps: copy the new value to where it lives, then recreate the containers.

**Procedure for rows marked "A"** (the value is stored elsewhere too):

1. Delete that one line from the company's secrets file.
2. Copy the new value to where it lives:
   - A company listed in `katip.config.yaml` (such as `demo`, `acme`): `pnpm dev:up --redo=provision`
   - Any other company: run `pnpm tenant:create` again with the same `--slug --name --plan --seats --admin-email`. For an existing company it changes nothing except re-syncing these secrets, and prints "already exists".
3. Recreate the company's containers: `pnpm tenant:upgrade --slug <slug>`.
4. Log in to the company and send a chat to check.

Between steps 2 and 3 the company's LibreChat still holds the old value. Chat or login may fail for that gap. Do 2 and 3 back to back.

**Procedure for rows marked "B"** (the value is only in the company's files): delete the line, then step 3 only.

| Secret | Used by | Procedure | What breaks or changes |
| ------ | ------- | --------- | ---------------------- |
| `GATEWAY_KEY` | LibreChat's key to the gateway (in its rendered `librechat.yaml`). The gateway keeps a hash | A | The old key is revoked as soon as step 2 runs. The gateway caches keys for 60 s, so the old key may still work for a minute. Chats fail until step 3 |
| `RAG_GATEWAY_KEY` | The company's RAG API, which can only embed. The gateway keeps a hash | B. `tenant:upgrade` stores the new hash itself (every start does) | File search fails for the gap between the hash and the container restart |
| `LC_OIDC_CLIENT_SECRET` | Keycloak client `lc-<slug>`; LibreChat | A | Login fails for the gap. Existing sessions continue |
| `MONGO_PASSWORD` (the company's) | Mongo user `lc_<slug>`; LibreChat | A | A restarted LibreChat cannot reach its chats until step 3 |
| `LC_JWT_SECRET` | LibreChat and the company's RAG API (shared) | B | **Everyone in that company is logged out** and signs in again through Keycloak. Chats are not affected |
| `LC_JWT_REFRESH_SECRET`, `LC_OIDC_SESSION_SECRET` | LibreChat | B | Everyone in that company is logged out |
| `MEILI_KEY` | The company's Meilisearch, and LibreChat | B | Believed to work with existing data; Meilisearch derives its own keys from it. **Check the Meilisearch v1.56.0 documentation before relying on this.** If search fails afterwards, restarting LibreChat re-syncs it from Mongo (not tested) |
| `RAG_DB_PASSWORD` | The company's vector database role `rag` (set only at its first start), and its RAG API | **Change it in the database first**: `docker exec -it katip-<slug>-ragdb-<slug>-1 psql -U rag -d rag`, `\password rag`. Then put the same value in the secrets file (replace the line, do not delete it), then step 3 | Without the database change, **file search stops working** and nothing says why |
| `DEMO_USER_PASSWORD` | Dev demo user in Keycloak. Dev only | Delete the line, `pnpm dev:up --redo=provision` | I did not check whether the script resets an existing user's password |
| `LC_CREDS_KEY`, `LC_CREDS_IV` | LibreChat encrypts credentials it stores for users (such as keys and tokens for tools people add) with these | **NOT POSSIBLE today.** There is no tool to decrypt with the old key and re-encrypt | If you change them, every stored credential in that company becomes unreadable, and people must enter them again. LibreChat behaviour from memory; verify on v0.8.7. If one leaks, change it only if you accept that loss. Format if you do: key 64 hex characters, IV 32 |

## If a secret leaked

1. Rotate it with the rows above.
2. For a provider key, revoke it at the provider as well, whatever else happens.
3. If personal data may be involved, start [incident.md](incident.md).
4. If you cannot rotate it safely (marked NOT POSSIBLE), say so in the incident note. Suspending the company ([incident.md](incident.md)) is the containment.

## What will change for production

- Secrets will be SOPS and age encrypted (P0-06, P0-22). The files and the edit steps above change. Today they are plaintext.
- A `tenant:rotate-secrets` command is planned (LLD-10 §3) and should replace the manual steps for company secrets.
- OpenBao for per-company encryption keys is planned for phase 2 (LLD-10 §3).
- The Cloudflare token (LLD-10 §3) will be added when the edge exists.
