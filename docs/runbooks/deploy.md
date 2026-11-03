# Runbook: deploy

**Tested:** `pnpm run deploy` with fakes for git and Docker (`pnpm test:setup`), and its dump and restore commands against throwaway containers (`pnpm test:backup`). **It has not been run against a real stack, or real data.** The rest of this page is written from the scripts, not rehearsed.
**Applies to:** the dev stack on WSL. Production does not exist yet.

## What a deploy is today

There are three commands, and they cover different parts.

| Command                          | Covers                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm run deploy`                | A new version of our code: backs up, keeps the old images, rebuilds, migrates, checks. **Use this one** |
| `pnpm dev:up`                    | The platform: Traefik, Postgres, Keycloak, Mongo, Valkey, Mailpit, LiteLLM, Presidio, policy gateway, console, console API, identity service. Also creates and starts the tenants listed in `katip.config.yaml` |
| `pnpm tenant:upgrade --slug X` or `--all` | Only the companies' stacks: LibreChat, Meilisearch, RAG API, vector database |

## Deploy a new version of our code

**Type `pnpm run deploy`.** `pnpm deploy` without `run` is pnpm's own command for copying a workspace package, and it never reaches our script. (`pnpm deploy:back` doesn't have this problem.)

1. Check the stack is healthy now: `pnpm dev:status`. If it is already broken, fix that first.
2. Update the code: `git pull` (or `git checkout <tag>`), then `pnpm install --frozen-lockfile`.
3. `pnpm run deploy`. It does these, in this order:

| Step | What happens | If it fails |
| ---- | ------------ | ----------- |
| 1 | Refuses if the git tree has uncommitted changes, untracked files included. Says which commit it's deploying. HEAD is what gets deployed: it doesn't pull | Nothing changed |
| 2 | Dumps the governance database and each company's Mongo database to `.katip/backups/<timestamp>-<sha>/` (mode 700), and checks them | Nothing changed. It needs the stack running: start it with `pnpm dev:up` |
| 3 | Tags the running images with the commit they came from (`:deploy-<sha>`), so the rebuild can't take them away | Nothing rebuilt |
| 4 | `dev:up --redo=config,build,governance-db,aiplane,tenant,smoke,isolation` | The new version may be part-way in. `pnpm deploy:back`, see [rollback.md](rollback.md) |
| 5 | Records it in `.katip/deploys.json`, and prunes old copies and their image tags | |

Expect a short outage: containers are recreated.

What the `dev:up` steps do:

- `config` renders the files again, so changed templates take effect.
- `build` rebuilds all our images (LiteLLM, Presidio, gateway, provisioner, console, console API, mock) and tags them `:dev`.
- `governance-db` runs database migrations and sets the three service role passwords. Migrations only go forward.
- `aiplane` recreates the containers whose image changed and waits until the gateway answers `/readyz`.
- `tenant` starts each active company, runs a smoke check and the invite check. It covers companies from `tenant:create` too, so `tenant:upgrade` isn't needed for a new version of our code. A changed `katip.config.yaml` makes `dev:up` re-apply everything, and that pulls and recreates pinned images as well.
- `smoke` and `isolation` log in with MFA, send a chat, a tool call and a file search through the gateway, and try to cross every tenant boundary. If one passes wrongly, the install fails.

Ctrl+C during the rebuild reaches `dev:up`, which asks keep or rollback. Answer `k`. The deploy is then recorded as failed.

### The copy it takes

**It is not a backup in the sense of P1-42.** It sits on the same disk as the data, unencrypted, and goes when the disk goes. It's there for one thing: a way back from a bad deploy.

- It holds the governance database and each company's Mongo database, nothing else. Keycloak, uploads, vectors and secrets aren't in it. For those, see [restore.md](restore.md), "Take a copy by hand".
- It holds personal data. Directories are mode 700 and files 600. Don't copy it anywhere casual.
- **It keeps deleted people's chats until it's pruned.** LLD-10 §8 has rules for backups, and this counts.
- It keeps the last 5, deploys and `deploy:back` copies together. To change that, set `deploy.keep_backups` in `katip.config.yaml`. The copy of the latest deploy is never pruned.
- It's taken while the stack is running. `pg_dump` is consistent. Each company's `mongodump` is not a point-in-time snapshot if people are writing during it.
- "Checked" means the Postgres dump lists a `tenants` table through `pg_restore -l`, and each Mongo archive decompresses whole and lists its collections through `mongorestore --dryRun`. No restore happens at deploy time, so it can't prove every document is there. `pnpm test:backup` runs a real restore, but only on made-up data.

### The first deploy

Nothing says which commit the running images came from, so they're tagged `:deploy-unknown-<timestamp>`. Image pins of the earlier version aren't known either. `pnpm deploy:back` can still restore those images, but it can't check out the older compose files: it stays on the current ones, and says so. Note the commit yourself before the first one. The same happens if someone ran `dev:up --redo=build` since the last deploy, as the record no longer matches what's running.

### Without the deploy command

`pnpm dev:up` skips every step it has already finished. It does **not** notice new code. After `git pull` or a checkout, plain `pnpm dev:up` rebuilds nothing. (It re-applies everything only when `katip.config.yaml` or `infra/env/katip.env` changed.) If you must, `pnpm dev:up --redo=config,build,governance-db,aiplane,tenant,smoke,isolation` does the rebuild without the copy or the kept images. `pnpm dev:up --fresh` runs every step again and keeps data. It is slow, because it pulls and rebuilds all images. It's for Keycloak realm or provisioner changes.

## Change a setting or a secret

Edit `katip.config.yaml` or `infra/env/katip.env`, then run `pnpm dev:up`. It sees the change, and runs every step except `preflight` again. It also force-recreates LiteLLM and the tenants' containers. For rotating secrets, read [secret-rotation.md](secret-rotation.md) first, because some secrets need a step before the edit.

Changing `project.name` or removing a tenant from the config is refused while the stack exists. Do not work around it with `dev:rollback`.

## Roll out a new LibreChat, Meilisearch or RAG API version

1. Change the pinned image in `katip.config.yaml` (`images.librechat`, `images.meilisearch`, `images.rag_api`, `images.postgres`). Never use `latest`.
2. Take a Mongo copy of each company first ([restore.md](restore.md)). `tenant:upgrade` doesn't take one; `pnpm run deploy` does, and rolls out to all companies at once. To try one company first, use these steps.
3. Try one company: `pnpm tenant:upgrade --slug acme`. It renders the files, pulls the image, recreates the containers and runs the smoke check.
4. If it passes, run `pnpm tenant:upgrade --all`. It goes one company at a time and stops at the first failure. The ones before it are upgraded; the ones after it are untouched. The message says which.

`tenant:upgrade` refuses a company that is not `active`.

A chat image uploaded by a person is kept inside the LibreChat container, not on a volume (LLD-07 §2c). Recreating the container, which an upgrade does, removes the file. Its record stays. This is a known gap.

## How to check it worked

1. `pnpm run deploy` ended with "Deployed", after `dev:up` ended with "Kâtip dev stack is up." The `smoke` and `isolation` steps passed. This is the main check.
2. `pnpm dev:status` shows every step done and every container healthy.
3. Gateway ready: `docker exec katip-policy-gateway-1 wget -qO- http://127.0.0.1:8080/readyz` should print `"ok"`.
4. Open `https://console.localhost` and one company, for example `https://demo.localhost`. Log in.
5. After a deploy, `docker logs --since 10m katip-policy-gateway-1` should hold no error-level lines.

## If a step fails

- `pnpm dev:up` prints the failed step and the log path: `.katip/logs/<step>.log`. Read the last lines.
- Run `pnpm dev:up` again. It retries from the failed step.
- A pull failure is usually network. A build failure is in the log.
- A `governance-db` failure with a password error: someone changed a database password in `katip.env` without changing it in Postgres. See [secret-rotation.md](secret-rotation.md).
- **If you press Ctrl+C during `dev:up`, it asks keep or rollback. Answer `k`.** `r` shows what it would delete and asks, and then deletes everything ([rollback.md](rollback.md)). Stopping this way now exits with 130, not 0.
- Still broken after one retry: `pnpm deploy:back`. See [rollback.md](rollback.md), "Going back a version". Do not use `dev:rollback`.

## Stop and start

- `pnpm dev:down` stops all containers and keeps all data. `pnpm dev:up` starts them again.
- If WSL or Docker restarted, run `pnpm dev:up`.

## What will change for production

- There is no host (P0-09), so there is nothing to deploy to. Images will need versioned tags and a registry. Today they are `:dev` and built on the same machine. `pnpm run deploy` keeps the previous ones under a tag, on this machine only.
- Secrets will be SOPS-encrypted (P0-22). Today `katip.env` is plaintext.
- `dev.yml` (mock model, dev certificates, host ports) will not be used. A production profile does not exist yet.
- Edge: Cloudflare and Traefik with origin certificates (P1-44). Not built.
- Off-site backups (P1-42) and alerts during a deploy (P1-43) will exist. Today they do not.
