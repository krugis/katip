# Runbook: restore

## Backups do not exist yet

**Nothing is backed up.** Backups are tracker item P1-42, and it is `todo`. No `pg_dump`, `mongodump`, restic or WAL archive job exists anywhere in this repository. There is no restore test. No alert fires when a backup is missing.

If the Docker volumes, the WSL disk or the secret files are lost, **the data is lost**. The only copy is the one on this machine.

**Tested:** nothing. Every command below is standard database tooling, written from the compose files. None was run. Treat the restore procedure as a plan that has not been tested. It will probably need fixing the first time it is tried.

**Applies to:** the dev stack on WSL. Production does not exist yet.

## What lives where

| Data | Where | Holds | Can it be rebuilt? |
| ---- | ----- | ----- | ------------------ |
| Governance database | Postgres `governance`, container `katip-postgres-1`, volume `katip_pgdata` | Companies, users, plans, limits, policies, gateway key hashes, usage events, audit log, privacy requests | **No.** Usage, audit and invoices are the record |
| Keycloak | Postgres `keycloak`, same container and volume | The realm, every user, password hashes, MFA enrolments, organizations, login clients | The realm settings can be re-applied by `dev:up` (identity step). **Users and MFA cannot** |
| LiteLLM database | Postgres `litellm`, same container | Nothing in dev (LiteLLM has no database configured) | Not needed |
| Chats, one database per company | Mongo `lc_<slug>`, container `katip-mongodb-1`, volume `katip_mongodata` | Conversations, messages, file records, users as LibreChat knows them | **No** |
| Search index, one per company | Container `katip-<slug>-meili-<slug>-1`, volume `katip-<slug>_meili-<slug>` | A copy of chats for searching | Believed yes: LibreChat fills it from Mongo (not tested). Do not back it up |
| Uploads, one volume per company | Volume `katip-<slug>_lc-uploads-<slug>`, mounted at `/app/uploads` in `katip-<slug>-lc-<slug>-1` | Files people uploaded | **No** |
| Images people uploaded in chat | Inside the LibreChat container, not on a volume (LLD-07 §2c) | Image files | **No. A container recreate loses them.** Known gap |
| File search, one vector database per company | Container `katip-<slug>-ragdb-<slug>-1`, volume `katip-<slug>_ragdb-<slug>` | Text chunks and vectors of uploaded files | Yes, by uploading the files again. It costs embedding calls |
| Secrets | `infra/env/katip.env`, `infra/env/tenants/<slug>.secrets.env` | Everything in [secret-rotation.md](secret-rotation.md) | **No.** Not in git. Without them the volumes cannot be used (see below) |
| Code and config | Git, plus `katip.config.yaml` | | Yes |
| Rendered files, `.katip/` | Repository directory | | Yes, `dev:up` makes them again |

**The secret files matter as much as the data.** Passwords are stored inside the volumes the first time a database starts (Postgres, Mongo root, each company's vector database). A new `katip.env` does not match the old volumes. A company's `LC_CREDS_KEY` and `LC_CREDS_IV` decrypt what LibreChat stored in Mongo. Keep a copy of `infra/env/` somewhere else, encrypted, not in git.

## Take a copy by hand (do this before a deploy)

Do it today, because nothing else does. Put the files on a different disk than the Docker volumes. They hold personal data and password hashes: encrypt them, keep them private, and delete them when you no longer need them. Replace `acme` with each company. Nothing here prints a secret.

1. Governance and Keycloak (the container knows its own admin user):
   ```
   docker exec katip-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -Fc governance' > governance.dump
   docker exec katip-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -Fc keycloak' > keycloak.dump
   ```
2. One company's chats:
   ```
   docker exec katip-mongodb-1 sh -c 'mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db lc_acme --archive --gzip' > lc_acme.archive.gz
   ```
3. One company's vector database:
   ```
   docker exec katip-acme-ragdb-acme-1 pg_dump -U rag -Fc rag > ragdb_acme.dump
   ```
4. One company's uploads (reads the volume through a throwaway container):
   ```
   docker run --rm -v katip-acme_lc-uploads-acme:/data:ro -v "$PWD":/out busybox tar czf /out/uploads_acme.tgz -C /data .
   ```
5. The secrets: copy `infra/env/katip.env` and `infra/env/tenants/*.secrets.env` into an encrypted archive stored elsewhere.
6. Check each file is not empty. Opening a dump with `pg_restore -l governance.dump` lists its contents without restoring.

If a command fails because a container name is wrong, run `docker ps` and use the real name.

## Restore: a plan, not tested

**Do not run this on the live stack to "see if it works".** `--clean` and `--drop` overwrite data.

### Who decides

The owner. Restoring replaces what is there with an older state, so everything people did after the copy is lost. Say so to the affected companies.

### A. One company's chats (Mongo) are lost or corrupted

1. Suspend the company so nobody writes: `pnpm tenant:suspend --slug acme`.
2. Make sure `lc_acme.archive.gz` is the copy you want, and when it was taken.
3. Restore into Mongo:
   ```
   docker exec -i katip-mongodb-1 sh -c 'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop --nsInclude "lc_acme.*"' < lc_acme.archive.gz
   ```
   The company's Mongo login (`lc_acme`) is a user in that database. Whether `--drop` removes it is not checked. If LibreChat cannot connect afterwards, run `pnpm dev:up --redo=provision` for a company in the config, or `pnpm tenant:create` again with the same arguments, which re-creates the login with the password in its secrets file.
4. `pnpm tenant:resume --slug acme`. It starts the containers and runs the smoke check.
5. Log in and open a conversation. The search index may be out of step; restarting the company's LibreChat should re-sync it (not tested).

### B. The governance or Keycloak database is lost

1. `pnpm dev:down`.
2. Start Postgres on its own and restore:
   ```
   docker exec -i katip-postgres-1 sh -c 'pg_restore -U "$POSTGRES_USER" -d governance --clean --if-exists' < governance.dump
   ```
   and the same with `keycloak.dump` and `-d keycloak`. The service roles (`katip_gateway` and others) are not in the dump. They are created by the migrations and their passwords are set by `dev:up`. Whether ownership and row-level security come back correctly has not been checked.
3. `pnpm dev:up`. Check [deploy.md](deploy.md).

### C. The whole machine is lost

1. Install Docker, Node 22, pnpm; clone the repository at the version that made the copy.
2. Put back `infra/env/katip.env` and `infra/env/tenants/*.secrets.env` **before** the first `pnpm dev:up`. A fresh `dev:up` makes new secrets otherwise.
3. `pnpm dev:up`. It builds an empty stack and creates the companies in `katip.config.yaml` with fresh data.
4. Restore as in B (governance, Keycloak), then A for each company, then the vector databases (`pg_restore -U rag -d rag --clean --if-exists` in the `ragdb` container) and uploads (extract the tar into the volume with a throwaway container).
5. Companies made with `tenant:create` and not in the config do not come back by themselves. Their containers are created from the restored governance database and secret files: run `pnpm tenant:upgrade --slug <slug>`.

**Likely trouble, not tested:** the empty stack created in step 3 already holds demo companies and a Keycloak realm with different ids from the restored ones. Restoring over them may need the demo companies removed first. Work this out in the tabletop on a different machine.

### What a restore cannot check today

- Whether the dumps are complete. There is no restore test.
- Time to restore. The LLD-10 §4 targets (RPO 24 h for Mongo, 15 min for Postgres, RTO 4 h) are not met and not measurable. There is no WAL archive, so the Postgres RPO is as old as your last manual copy.

### Rehearsal limits

LLD-10 §4 asks for a monthly restore into a scratch compose project. That cannot run next to the live stack on one host today: both want ports 80 and 443, and the project name `katip`. Rehearse on a second machine or a second WSL distribution.

## What will change for production

- P1-42 will add: `pg_dump` per database plus WAL archiving (pgBackRest or wal-g), `mongodump` per company, restic for uploads, to a Hetzner Storage Box (EU) or Turkish storage for the TR region, with a monthly automatic restore test and an alert if it fails or is missing (LLD-10 §4).
- Secrets will be SOPS-encrypted in git (P0-22), so they will be recoverable from git and the age keys. Today they are not.
- SeaweedFS replaces the uploads volume (P1-35, per LLD-07).
- Backups keep deleted chats for 30 days after they are deleted (LLD-10 §8). Once backups exist, a restore must not bring back data that a company or a person had deleted. How to prevent that is not designed.
