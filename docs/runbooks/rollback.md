# Runbook: rollback

**Tested:** the checks, with fakes for Docker and the database (`pnpm test:setup`). The dump and restore commands, against throwaway containers of the pinned images (`pnpm test:backup`). **Neither `pnpm dev:rollback` nor `pnpm dev:deploy-back` has been run against a real stack, or against real data.**
**Applies to:** the dev stack on WSL. Production does not exist yet.

## Do not confuse these two

|                      | Going back a version                       | `pnpm dev:rollback`                          |
| -------------------- | ------------------------------------------ | -------------------------------------------- |
| What it is           | Run the older code again                   | **Tear down the whole install**              |
| Data                 | Kept (but see "database changes" below)    | **Deleted**                                  |
| Use it for a bad deploy? | Yes: `pnpm dev:deploy-back`                 | **No. Never.**                               |

The name `dev:rollback` is misleading. It is not "go back one version". It undoes the bootstrap: it is the uninstall.

## WARNING: what `pnpm dev:rollback` destroys

It runs the teardown of every step, last step first:

1. Removes the daily job's line from the crontab.
2. For **every company on this host** (every file `infra/env/tenants/*.secrets.env`, suspended and deleted ones too): `docker compose down -v`. **This deletes each company's uploads volume, search index volume and vector database volume.**
3. For the platform: `docker compose down -v`. **This deletes `katip_pgdata` (the governance database, Keycloak with all users and MFA enrolments, the LiteLLM database), `katip_mongodata` (every company's chats), `katip_valkey` and the Traefik volume.**
4. Removes the Docker networks (edge, backend, one per company).
5. Deletes the rendered files: compose files, LibreChat configs, every company's `.env`, `.meili.env`, `.rag.env`, `.ragdb.env`, **and every company's `<slug>.secrets.env`**, and the dev TLS certificates.
6. Resets `.katip/setup-state.json`.

**Lost for good:** all chats, files, users, MFA, usage records, audit log, gateway keys. Every company's secrets, including `LC_CREDS_KEY` and `LC_CREDS_IV`. There is no backup (P1-42).

**Kept:** `infra/env/katip.env`, the Docker images, the repository, `.katip/logs/`.

## What stops it running on real data

Before deleting anything it prints each company by slug, with its users, LibreChat accounts and chats, read from the databases with what's already running. Nothing is started to do this.

**The rule.** A company counts as test data only if all of these hold:

- It is listed under `tenants:` in `katip.config.yaml`.
- Every user in the governance database is one the bootstrap seeds: `demo@example.com`, `smoke-member@<slug>.<base_domain>`, `admin@`, `manager@` and `user@<slug>.localhost`, and the `admin_email` from the config if it's at a reserved domain (`.localhost`, `.test`, `.example`, `.invalid`, `example.com`).
- Every LibreChat account in `lc_<slug>` is one of those too, and every chat belongs to one of them.

The whole install counts as test data only if every company does, `project.base_domain` is `localhost` or ends in `.localhost`, and everything could be read. **Anything else may be real data.** That includes a company not in the config, a Mongo database or secrets file nobody can account for, and a stack that's stopped, because then nothing can be read.

Two cases hold nothing, so they don't count against it: a company already purged (status `deleted`, every user anonymised, no Mongo database, no secrets file), which the e2e tests leave behind; and an install with no data volumes yet, or a database with no schema yet.

| What it finds | `--yes` | No flag, at a terminal | No flag, no terminal | `--destroy-data <project name>` |
| ------------- | ------- | ---------------------- | -------------------- | ------------------------------- |
| Only test data, or nothing | Goes ahead | Asks `[y/N]` | Reads `y` from standard input. If the input ends, refuses | Goes ahead |
| Maybe real data | **Refuses, exit 1** | You type the project name | **Refuses, exit 1** | Goes ahead |

A wrong `--destroy-data` value always refuses. `pnpm dev:rollback --destroy-data katip` is the only way to run it on real data without a person typing.

**Answering `r` at the Ctrl+C prompt during `pnpm dev:up` gets the same check.** On test data it now asks `[y/N]` as well. If it's refused or you say no, the state is kept, and `pnpm dev:up` resumes.

What the rule can't see:

- Someone doing real work while logged in as a seeded user such as `user@demo.localhost`. It counts as test data, though the chat count is on screen.
- People who exist only in Keycloak, with no row in the governance database and no LibreChat account. Keycloak isn't read.
- Files. Uploads and vectors aren't counted, only users and chats.

Nothing in the repository runs `dev:rollback`, the CI workflow included (`e2e.yml` runs `pnpm dev:up --yes`). A script that runs `pnpm dev:rollback --yes` keeps working on a demo stack that's running. On a stopped stack, or one where an e2e test failed before purging its company, it now needs `--destroy-data`.

## If the teardown fails

It no longer hides errors. Afterwards it asks Docker what is left of this project: containers, volumes and networks. If a step failed or something is left, it lists it, says "rollback did NOT finish", exits 1, and **keeps the rendered files and company secrets**, so running it again can finish the job. The state file is reset either way. A re-run may be treated as real data, as the databases may be gone or unreadable by then: it will tell you what it needs.

Use it only on an install you want to throw away. If you are unsure, do not run it.

## Going back a version

Use this after a bad deploy ([deploy.md](deploy.md)). `pnpm dev:deploy` kept what's needed.

```
pnpm dev:deploy-back                  # the images from before the last deploy; the data stays
pnpm dev:deploy-back --restore-data   # and the database copy from before it
```

It prints where it's going from and to, the images, which migrations differ and which image pins change, then asks. `--yes` skips the question for images alone. Nothing skips it for `--restore-data`, and without a terminal that's refused. It then:

1. Refuses a tree with uncommitted changes, and checks the kept images, the commit and, with `--restore-data`, every file of the copy against its checksum. If any fails, nothing has changed.
2. With `--restore-data`: copies the data as it is now to `.katip/backups/<timestamp>-<sha>-before-back/`, stops every company's containers and the services that write (LibreChat, the gateway, console API and others; Postgres, Mongo and Keycloak stay up), and restores.
3. Tags the kept images back as `:dev`. Checks out the earlier commit with a detached HEAD, so the compose files and pins match the images.
4. Runs `dev:up --redo=config,governance-db,aiplane,tenant,smoke,isolation --skip=build,images`. Nothing is built or pulled. The `smoke` and `isolation` steps are the check.

A deploy that stopped at its backup or its tagging changed nothing, so it isn't gone back from. Running `pnpm dev:deploy-back` again after a success goes one deploy further back. If it fails part-way, fix the cause and run it again: it goes to the same place.

Afterwards you're on a detached HEAD. Check out a branch with the fix before the next `pnpm dev:deploy`.

### Across a migration you need the restore

Migrations only go forward. If the database holds a migration from after the kept version, or that can't be read, or LibreChat's pinned version changes (it migrates its own data), **`pnpm dev:deploy-back` alone refuses**, and names what differs. There's no override. The older code has never seen that schema.

### What `--restore-data` costs

**Everything written since the copy is lost:** chats, users, usage, audit entries. Say so to the affected companies, and see [restore.md](restore.md), "Who decides".

- **People and companies deleted since the copy come back.** That's a KVKK matter: deletions made after the copy must be carried out again, and nothing does that for you.
- A company created since the copy loses its governance row, and is left otherwise: its Mongo database stays, and it's named on screen. Its containers stay stopped. Removing it is by hand.
- **The copy holds only the governance database and each company's Mongo database.** Keycloak, uploads, file search's vectors and the search indexes stay as they are, so they can be ahead of the restored data: a person made since has a login and no row, and a file's record can be gone while its vectors remain. **A Keycloak pin change can't be undone this way**: its database is not in the copy. It's only warned about, as a pin that differs.
- The daily job isn't stopped. If it's scheduled, make sure it can't run during a restore.

**This has not been tried on real data.** Restoring over a live database needs care, and the first real use may find something. How it restores, as tested against throwaway containers:

- **Governance:** into a new database, then swapped in by name, and the replaced one dropped. If `pg_restore` fails, the live database hasn't been touched. `pg_restore --clean` is deliberately not used: it leaves what the newer migration added, and that migration then fails on the next deploy. The service roles live outside the database, so their passwords stay; the `governance-db` step sets them again anyway.
- **Mongo:** each company's database is dropped, then restored. If that fails part-way, that company has lost data until it's run again, and the copy made in step 2 holds what was there. Its login is kept, since it lives in `admin`.

### Doing it by hand

If `pnpm dev:deploy-back` can't help (`.katip/deploys.json` is gone, or no deploy went through `pnpm dev:deploy`), rebuild from source. Going back across a migration still needs a restore from a copy ([restore.md](restore.md)).

```
git checkout <good>
pnpm install --frozen-lockfile
pnpm dev:up --redo=config,build,governance-db,aiplane,tenant,smoke,isolation
```

If a step fails: read `.katip/logs/<step>.log` and run it again once. If it still fails, run `pnpm dev:down`, then `pnpm dev:up`. Data is kept by both.

## Stopping without losing anything

If you only need it to stop: `pnpm dev:down`. Data stays. `pnpm dev:up` brings it back.

To lock out one company: `pnpm tenant:suspend --slug X`. To bring it back: `pnpm tenant:resume --slug X`.

## What will change for production

- Images will carry version tags in a registry, so going back means starting the old tag. Today the kept tags are only on this machine.
- `dev:rollback` does not belong on a production host. A production profile (P0-22) must not offer it. Today the only thing in its way is the check above, and the project name.
- A database restore from off-site backups (P1-42) will be the way back from a lost machine. The copy `pnpm dev:deploy` takes sits on the same disk as the data, and is no use for that.
