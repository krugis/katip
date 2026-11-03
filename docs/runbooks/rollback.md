# Runbook: rollback

**Tested:** nothing. Written from `scripts/setup/main.mjs`, `steps.mjs` and `tenant-lifecycle.mjs`. Not rehearsed.
**Applies to:** the dev stack on WSL. Production does not exist yet.

## Do not confuse these two

|                      | Going back a version                       | `pnpm dev:rollback`                          |
| -------------------- | ------------------------------------------ | -------------------------------------------- |
| What it is           | Run the older code again                   | **Tear down the whole install**              |
| Data                 | Kept (but see "database changes" below)    | **Deleted**                                  |
| Use it for a bad deploy? | Yes                                    | **No. Never.**                               |

The name `dev:rollback` is misleading. It is not "go back one version". It undoes the bootstrap: it is the uninstall.

## WARNING: what `pnpm dev:rollback` destroys

It asks `[y/N]` once. With `--yes` it does not ask at all. It then runs the teardown of every step, last step first:

1. Removes the daily job's line from the crontab.
2. For **every company on this host** (every file `infra/env/tenants/*.secrets.env`, suspended and deleted ones too): `docker compose down -v`. **This deletes each company's uploads volume, search index volume and vector database volume.**
3. For the platform: `docker compose down -v`. **This deletes `katip_pgdata` (the governance database, Keycloak with all users and MFA enrolments, the LiteLLM database), `katip_mongodata` (every company's chats), `katip_valkey` and the Traefik volume.**
4. Removes the Docker networks (edge, backend, one per company).
5. Deletes the rendered files: compose files, LibreChat configs, every company's `.env`, `.meili.env`, `.rag.env`, `.ragdb.env`, **and every company's `<slug>.secrets.env`**, and the dev TLS certificates.
6. Resets `.katip/setup-state.json`.

**Lost for good:** all chats, files, users, MFA, usage records, audit log, gateway keys. Every company's secrets, including `LC_CREDS_KEY` and `LC_CREDS_IV`. There is no backup (P1-42).

**Kept:** `infra/env/katip.env`, the Docker images, the repository, `.katip/logs/`.

Also:

- Errors during the teardown are ignored. It can print "rollback complete" and leave things behind.
- It does not stop to look at what the stack holds. A real company's data goes the same as the demo data.
- Pressing `r` at the keep-or-rollback prompt after Ctrl+C during `pnpm dev:up` runs this same teardown.

Use it only on an install you want to throw away. If you are unsure, do not run it.

## Going back a version

Use this after a bad deploy ([deploy.md](deploy.md)).

1. Write down the bad version: `git rev-parse HEAD`. Write down the good one (the one you noted before the deploy).
2. Get a copy of the data first if you can ([restore.md](restore.md), "Take a copy by hand"). A bad version may have written bad data.
3. Check for database changes. Migrations only go forward; there are no down migrations:
   `git diff --stat <good> <bad> -- packages/db/drizzle`
   - No output: no migration was added. Continue.
   - Files listed: the database has the new schema. The old code may or may not work with it. Try step 4. If it fails, the only way back is a database restore from a copy taken before the deploy ([restore.md](restore.md), untested).
4. Check out the good version and rebuild:
   ```
   git checkout <good>
   pnpm install --frozen-lockfile
   pnpm dev:up --redo=build,governance-db,aiplane,tenant,smoke,isolation
   ```
   Our images are tagged `:dev`, so the old image is not kept. The good version is rebuilt from source.
5. If the bad deploy changed image pins in `katip.config.yaml` (LibreChat, Meilisearch, RAG API), step 4 restores the old pins. Then run `pnpm tenant:upgrade --all`. A newer LibreChat may have changed its Mongo data in a way the older one cannot read. If a company's chat does not load after this, restore its Mongo copy from before the upgrade.
6. Check it worked: [deploy.md](deploy.md), "How to check it worked".

If step 4 fails: read `.katip/logs/<step>.log` and run it again once. If it still fails, run `pnpm dev:down`, then `pnpm dev:up`. Data is kept by both.

## Stopping without losing anything

If you only need it to stop: `pnpm dev:down`. Data stays. `pnpm dev:up` brings it back.

To lock out one company: `pnpm tenant:suspend --slug X`. To bring it back: `pnpm tenant:resume --slug X`.

## What will change for production

- Images will carry version tags in a registry, so going back means starting the old tag. Today the old image is overwritten.
- `dev:rollback` does not belong on a production host. A production profile (P0-22) must not offer it, or must make it very hard to run. Today nothing stops it.
- A database restore from backups (P1-42) will be the way back from a migration. Today there is none.
