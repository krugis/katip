# Runbook: deploy

**Tested:** nothing. Written from `scripts/setup/main.mjs`, `steps.mjs` and `tenant-lifecycle.mjs`. Not rehearsed.
**Applies to:** the dev stack on WSL. Production does not exist yet.

## What a deploy is today

There are two commands, and they cover different parts.

| Command                          | Covers                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm dev:up`                    | The platform: Traefik, Postgres, Keycloak, Mongo, Valkey, Mailpit, LiteLLM, Presidio, policy gateway, console, console API, identity service. Also creates and starts the tenants listed in `katip.config.yaml` |
| `pnpm tenant:upgrade --slug X` or `--all` | Only the companies' stacks: LibreChat, Meilisearch, RAG API, vector database |

## Before you start

1. Take a copy of the data you cannot lose. There are no backups. See [restore.md](restore.md), "Take a copy by hand". Do this before a LibreChat upgrade especially (LLD-07 §4 asks for it).
2. Note the version you are leaving: `git rev-parse HEAD`. You need it to go back ([rollback.md](rollback.md)).
3. Check the stack is healthy now: `pnpm dev:status`. If it is already broken, fix that first.

## Deploy a new version of our code

`pnpm dev:up` skips every step it has already finished. It does **not** notice new code. After `git pull` or a checkout, plain `pnpm dev:up` rebuilds nothing. (It re-applies everything only when `katip.config.yaml` or `infra/env/katip.env` changed.)

1. Update the code: `git pull` (or `git checkout <tag>`), then `pnpm install --frozen-lockfile`.
2. Rebuild and restart. Pick one:
   - Know what changed in `apps/` or `packages/`: `pnpm dev:up --redo=build,governance-db,aiplane,tenant,smoke,isolation`
   - Not sure, or Keycloak realm settings or the provisioner changed: `pnpm dev:up --fresh`. It runs every step again. It keeps data. It is slow, because it pulls and rebuilds all images.
3. Wait. The terminal lists each step. It ends with "Kâtip dev stack is up."

What these steps do:

- `build` rebuilds all our images (LiteLLM, Presidio, gateway, provisioner, console, console API, mock) and tags them `:dev`.
- `governance-db` runs database migrations and sets the three service role passwords. Migrations only go forward.
- `aiplane` recreates the containers whose image changed and waits until the gateway answers `/readyz`.
- `tenant` starts each active company, runs a smoke check and the invite check.
- `smoke` and `isolation` log in with MFA, send a chat, a tool call and a file search through the gateway, and try to cross every tenant boundary. If one passes wrongly, the install fails.

Expect a short outage: containers are recreated.

## Change a setting or a secret

Edit `katip.config.yaml` or `infra/env/katip.env`, then run `pnpm dev:up`. It sees the change, and runs every step except `preflight` again. It also force-recreates LiteLLM and the tenants' containers. For rotating secrets, read [secret-rotation.md](secret-rotation.md) first, because some secrets need a step before the edit.

Changing `project.name` or removing a tenant from the config is refused while the stack exists. Do not work around it with `dev:rollback`.

## Roll out a new LibreChat, Meilisearch or RAG API version

1. Change the pinned image in `katip.config.yaml` (`images.librechat`, `images.meilisearch`, `images.rag_api`, `images.postgres`). Never use `latest`.
2. Take a Mongo copy of each company first ([restore.md](restore.md)).
3. Try one company: `pnpm tenant:upgrade --slug acme`. It renders the files, pulls the image, recreates the containers and runs the smoke check.
4. If it passes, run `pnpm tenant:upgrade --all`. It goes one company at a time and stops at the first failure. The ones before it are upgraded; the ones after it are untouched. The message says which.

`tenant:upgrade` refuses a company that is not `active`.

A chat image uploaded by a person is kept inside the LibreChat container, not on a volume (LLD-07 §2c). Recreating the container, which an upgrade does, removes the file. Its record stays. This is a known gap.

## How to check it worked

1. `pnpm dev:up` ended with "Kâtip dev stack is up." The `smoke` and `isolation` steps passed. This is the main check.
2. `pnpm dev:status` shows every step done and every container healthy.
3. Gateway ready: `docker exec katip-policy-gateway-1 wget -qO- http://127.0.0.1:8080/readyz` should print `"ok"`.
4. Open `https://console.localhost` and one company, for example `https://demo.localhost`. Log in.
5. After a deploy, `docker logs --since 10m katip-policy-gateway-1` should hold no error-level lines.

## If a step fails

- `pnpm dev:up` prints the failed step and the log path: `.katip/logs/<step>.log`. Read the last lines.
- Run `pnpm dev:up` again. It retries from the failed step.
- A pull failure is usually network. A build failure is in the log.
- A `governance-db` failure with a password error: someone changed a database password in `katip.env` without changing it in Postgres. See [secret-rotation.md](secret-rotation.md).
- **If you press Ctrl+C during `dev:up`, it asks keep or rollback. Answer `k`.** `r` deletes everything ([rollback.md](rollback.md)).
- Still broken after one retry: [rollback.md](rollback.md), "Going back a version". Do not use `dev:rollback`.

## Stop and start

- `pnpm dev:down` stops all containers and keeps all data. `pnpm dev:up` starts them again.
- If WSL or Docker restarted, run `pnpm dev:up`.

## What will change for production

- There is no host (P0-09), so there is nothing to deploy to. Images will need versioned tags and a registry. Today they are `:dev` and built on the same machine, so the previous image is overwritten.
- Secrets will be SOPS-encrypted (P0-22). Today `katip.env` is plaintext.
- `dev.yml` (mock model, dev certificates, host ports) will not be used. A production profile does not exist yet.
- Edge: Cloudflare and Traefik with origin certificates (P1-44). Not built.
- Backups before deploy (P1-42) and alerts during it (P1-43) will exist. Today they do not.
