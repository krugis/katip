# Runbook: secret rotation

**Tested:** the commands themselves, on throwaway containers from the pinned images, with `pnpm test:secrets-real`: `ALTER ROLE` and Mongo's password change with awkward characters, a service connecting by URL afterwards, Meilisearch's master key on existing data, Keycloak's client secrets and admin password, and the order, failure, `--resume` and `--abort` on real Postgres and Mongo with a pretend restart. The order for every secret is in `scripts/setup/test/secret-rotation.test.mjs`.
**Not tested:** a rotation on the running stack, so compose recreating real services, the smoke checks, and how long each outage lasts.
**Applies to:** the dev stack on WSL. Production does not exist yet.

## The commands

```
pnpm secrets:rotate --list                      # each secret, can it rotate, when it last did
pnpm secrets:rotate --list --tenant acme        # the platform's, and one company's
pnpm secrets:rotate <NAME>                      # one platform secret
pnpm secrets:rotate <NAME> --tenant acme        # one company's secret
pnpm secrets:rotate --resume                    # finish one that stopped
pnpm secrets:rotate --abort                     # or go back to the old value
```

- A secret that disturbs people prints a warning and asks. `--yes` answers for you, and without a terminal it is required.
- A provider's new key comes from a hidden prompt or stdin, never an argument: `pnpm secrets:rotate ANTHROPIC_API_KEY < file-holding-the-key`.
- `--list` marks a secret `due` if it was never rotated here or last rotated over 90 days ago (LLD-10 §3). That is the only reminder. The dates are in `.katip/rotations.json`, by name and date, never a value. A rotation done by hand is not on it.
- **`GATEWAY_KEY` needs a provisioner image with the `gateway-key` action.** An older image refuses it, and nothing changes. `pnpm dev:up --redo=build` builds it.

Rotate in a quiet hour.

## What a rotation does

For every secret, in this order:

1. **Check.** The stack is up, a company is active and passes its smoke check, and the store accepts the value in the env file. If they were already out of step it stops here, and changes nothing.
2. **Write down old and new** in `infra/env/rotation-pending.env`, mode 600. Mongo and Keycloak need the current password to change it, so a crash without this could lock you out.
3. **Change the store**, then log in with the new value.
4. **Write the env file**, in one step, mode 600.
5. **Restart what uses it**, and wait for its health check.
6. **Check again**, and only then record the date and delete the pending file.

**If it fails:**

| Where | What it leaves | What to do |
| ----- | -------------- | ---------- |
| The store refused the change | The old value, everywhere | Nothing. Fix the cause and run it again |
| The new value did not work, or the env file could not be written | The store is put back. The old value, everywhere | Nothing. If putting it back also fails, it says so, and it is as below |
| The restart or its check failed | The new value in the store and the file | `pnpm secrets:rotate --resume` to try the restart again, or `--abort` to put the old value back everywhere. The message says so too |

While a rotation is unfinished, another one and `secrets:backup` refuse. **`rotation-pending.env` holds real secrets.** It goes when the rotation finishes or is aborted. Do not delete it by hand: it may hold the only copy of a working password.

**Afterwards:**

- **Take a new secrets backup.** Earlier ones hold the old value, which no longer opens the database.
- The next `pnpm dev:up` sees that `katip.env` changed, and re-applies everything, recreating the containers. That is expected and harmless, and it is also when Postgres's container gets its new environment. It does not need it: Postgres only reads its passwords the first time it starts.

## Platform secrets (`infra/env/katip.env`)

| Secret | Where it's changed first | What restarts | What people notice |
| ------ | ------------------------ | ------------- | ------------------ |
| `LITELLM_MASTER_KEY` | Nowhere else | `litellm`, `policy-gateway` | Short outage of chats |
| `KATIP_PII_TOKEN_KEY` | Nowhere else | `policy-gateway` | **Asks first. Placeholders change in ongoing conversations.** The same name gets a different placeholder than before. Where an old tool call or tool result holds an old placeholder, the gateway cannot restore it, and a user may see `⟦PERSON_…⟧` in an answer. New conversations are fine. Nothing is exposed and nothing is lost. Do it out of hours, and tell companies. From LLD-03 §5, not tested |
| `KATIP_METRICS_TOKEN` | Nowhere else | `policy-gateway` | Nothing. Update any scraper when one exists (P1-43) |
| `VALKEY_PASSWORD` | Nowhere else: it is a start option | `valkey`, `policy-gateway`, `console-api` | Short outage |
| `KATIP_GATEWAY_DB_PASSWORD` | `ALTER ROLE katip_gateway` | `policy-gateway` | Short outage |
| `KATIP_CONSOLE_DB_PASSWORD` | `ALTER ROLE katip_console` | `console-api` | Short outage of the console |
| `KATIP_PROVIDER_DB_PASSWORD` | `ALTER ROLE katip_provider` | Nothing: the provisioner runs once per action | Nothing |
| `KATIP_PROVISIONER_KC_SECRET` | Keycloak client `katip-provisioner` | `identity` | Identity actions in the console fail for a moment |
| `KATIP_IDENTITY_TOKEN` | Nowhere else | `identity`, `console-api` | Short outage of identity actions |
| `MOCK_LLM_KEY` | Nowhere else | `litellm` | Dev only |
| `POSTGRES_PASSWORD` | `ALTER ROLE` on `POSTGRES_USER` | Nothing: only host scripts use it | Nothing |
| `KC_DB_PASSWORD` | `ALTER ROLE keycloak` | `keycloak` | **Asks first.** Nobody can log in while Keycloak restarts |
| `LITELLM_DB_PASSWORD` | `ALTER ROLE litellm` | Nothing: nothing uses it in dev | Nothing. `LITELLM_DATABASE_URL` is rewritten in the same write, unless someone wrote their own |
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | Keycloak, the admin user | Nothing: Keycloak reads it only at its first start | Nothing |
| `MONGO_PASSWORD` | Mongo's `changeUserPassword`, on the root user | `mongodb` | **Asks first.** Every company loses chats for a few seconds. It restarts because the backup commands in [restore.md](restore.md) read the password from its container |
| `DEEPINFRA_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GCP_VERTEX_KEY`, `VLLM_TR_KEY`, `KATIP_LOCAL_LLM_KEY` | **Create it at the provider first.** It comes from stdin, and is never generated | `litellm` | Short outage. Check a chat, **then revoke the old key at the provider** |

**Refused, and why:**

- `LITELLM_DATABASE_URL`: made from `LITELLM_DB_PASSWORD`. Rotate that.
- **A provider key that is empty.** Empty means that model silently routes to the mock (it echoes), so the tool never clears a key. Setting one for the first time changes which model answers: put it in `katip.env` and run `pnpm dev:up`.
- A value with a space or any of `` # $ ' " \ ` ``, which an env file would change.

Not in `katip.env`, and not covered here:

- Keycloak realm keys, SMTP settings and every user's password and MFA: managed in Keycloak.
- The dev TLS certificate (`infra/traefik/dev-certs`, self-signed, valid 825 days). It is regenerated if its hostnames change. There is no renewal command. Dev only.
- Cloudflare token and origin certificates: not built (P1-44).

## A company's secrets (`infra/env/tenants/<slug>.secrets.env`)

Add `--tenant <slug>`. Every one of these recreates the company's containers, and passes its smoke check, so **each asks first.** A suspended or deleted company refuses: resume it first. `tenant:rotate-secrets` in LLD-10 was never built. This is what replaced it, and it needs no `--redo=provision` or `tenant:upgrade` afterwards.

| Secret | Where it's changed first | What people notice |
| ------ | ------------------------ | ------------------ |
| `GATEWAY_KEY` | The gateway's hash, through the provisioner. The old key is revoked as this runs, though the gateway caches keys for 60 s | Chats fail until LibreChat restarts |
| `RAG_GATEWAY_KEY` | The gateway's hash: every start stores it | File search and chats stop during the restart |
| `LC_OIDC_CLIENT_SECRET` | Keycloak client `lc-<slug>` | Login fails until LibreChat restarts. Existing sessions continue |
| `MONGO_PASSWORD` | Mongo's `changeUserPassword`, on `lc_<slug>` | Chats stop during the restart |
| `LC_JWT_SECRET` | Nowhere else. LibreChat and the company's RAG API share it | **Everyone in that company is logged out** and signs in again through Keycloak. Chats are not affected |
| `LC_JWT_REFRESH_SECRET`, `LC_OIDC_SESSION_SECRET` | Nowhere else | Everyone in that company is logged out |
| `MEILI_KEY` | Nowhere else: the new one takes effect as Meilisearch restarts. Tested on v1.56.0: existing data stays searchable, and the old key is refused | Chats stop during the restart |
| `RAG_DB_PASSWORD` | `ALTER ROLE rag` in the company's vector database | File search and chats stop during the restart |
| `DEMO_USER_PASSWORD` | The demo users in Keycloak, which `keycloak-dev-users.mjs` does not do for a user who exists | Dev only |

### `LC_CREDS_KEY`, `LC_CREDS_IV`: refused

Read from LibreChat v0.8.7's code, in its image. It encrypts with these, in three formats: a fixed IV (`encrypt`), a random IV (`encryptV2`) and AES-CTR (`encryptV3`). Among what it encrypts: users' own API keys and tool credentials (`PluginService`, `methods/key`, `agents/auth`), agent action credentials (`ActionService`), MCP server secrets and OAuth tokens (`mcp/registry/db/ServerConfigsDB`, `mcp/oauth/tokens`, `oauth/tokens`), skill sync tokens (`methods/skillSync`) and two-factor secrets (`TwoFactorController`).

A safe re-encryption would have to find every such field in every collection, tell the formats apart, and be kept in step with each LibreChat upgrade. A miss makes that data unreadable with no way back. There is no such tool, so the command refuses.

**If one leaked:** the values it protects are exposed only to someone who also has that company's Mongo data. Rotate that company's `MONGO_PASSWORD` and suspend the company if needed ([incident.md](incident.md)). To change them anyway, accept the loss: stored credentials become unreadable and people enter them again, and anyone with two-factor set up in LibreChat loses it. Keep `LC_CREDS_KEY` at 64 hex characters and `LC_CREDS_IV` at 32, edit the file by hand, and run `pnpm tenant:upgrade --slug <slug>`.

## If a secret leaked

1. Rotate it with the commands above.
2. For a provider key, revoke it at the provider as well, whatever else happens.
3. Take a new secrets backup, and destroy older ones if the leak could reach them.
4. If personal data may be involved, start [incident.md](incident.md).
5. If you cannot rotate it (`LC_CREDS_*`), say so in the incident note. Suspending the company ([incident.md](incident.md)) is the containment.

## Backing up the secrets

`pnpm secrets:backup --to <path>` and `pnpm secrets:restore --from <path>`: see [restore.md](restore.md).

## What will change for production

- Secrets will be SOPS and age encrypted (P0-06, P0-22). `updateEnvFile` in `scripts/setup/secret-rotation.mjs` is the one place that writes them, and is what changes.
- OpenBao for per-company encryption keys is planned for phase 2 (LLD-10 §3).
- The Cloudflare token (LLD-10 §3) will be added when the edge exists.
- Today's values are also in each container's environment. A rotated value is replaced as its container is recreated (P1-71 lists moving them out).
