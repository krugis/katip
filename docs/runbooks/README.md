# Runbooks

Operations runbooks for Kâtip (tracker P1-48). Read this page first.

## Read this before anything else

- **Nothing here has been rehearsed on a real stack.** The commands were checked against `package.json` and the scripts in `scripts/setup/`. Each runbook says what is tested at the top. `deploy.md` and `rollback.md` have unit tests and a dump-and-restore test on throwaway containers. The rest have nothing.
- **There is no production.** No host (P0-09), no production profile (P0-22), no tunnel or Cloudflare setup (P1-44). What exists is the dev stack on one WSL machine. These pages describe that stack. Each page says what will change for production.
- **There are no backups (P1-42) and no monitoring or alerting (P1-43).** `pnpm dev:deploy` keeps copies on the same disk, for going back from a deploy. If the disk is lost, the data is gone. Nobody gets a phone alert.
- The acceptance for P1-48 is a tabletop exercise. It needs the owner. See [tabletop.md](tabletop.md).

## Pages

| Page                                     | Use it when                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| [deploy.md](deploy.md)                   | Starting the stack, rolling out a new version: `pnpm dev:deploy`         |
| [rollback.md](rollback.md)               | Going back a version: `pnpm dev:deploy-back`. **Also: what `pnpm dev:rollback` destroys** |
| [secret-rotation.md](secret-rotation.md) | A secret leaked, or the 90-day rotation (LLD-10 §3)                      |
| [restore.md](restore.md)                 | Data is lost or damaged. **Backups do not exist yet**                    |
| [incident.md](incident.md)               | Something is wrong and may involve personal data                         |
| [daily-job.md](daily-job.md)             | The provider console says the daily job failed, is late, or never ran    |
| [billing.md](billing.md)                 | Lago and billing-bridge: attaching a company, a failed run, reconciling  |
| [tabletop.md](tabletop.md)               | The scenario script for the exercise, and where to record the result     |

## Commands that destroy data

Know these before you type anything at 3 am.

| Command                                   | What it does                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm dev:rollback`                       | **Deletes every database, every company's chats and files, and every tenant secret.** Shows what first. If real data may exist, `--yes` isn't enough: it takes `--destroy-data <project name>` or typing the name. [rollback.md](rollback.md) |
| `pnpm dev:deploy-back --restore-data`         | **Replaces the governance database and every company's chats with the copy from before the last deploy.** Everything since is lost. Asks every time. [rollback.md](rollback.md) |
| `pnpm tenant:delete --slug X --confirm X` | Locks a company out. Its data is purged after 30 days. `tenant:resume` undoes it until then   |
| `pnpm tenant:purge-due`                   | Destroys the data of deleted companies whose 30 days are over. Cannot be undone               |
| Answering `r` when `pnpm dev:up` is interrupted | The same rollback as `dev:rollback`, with the same check. Answer `k` (keep)             |

Safe: `pnpm dev:status`, `pnpm dev:down` (stops everything, keeps data), `pnpm tenant:suspend`, `pnpm tenant:resume`, `pnpm dev:deploy-back` without `--restore-data` (keeps data).

## Where things are (dev stack)

Compose project `katip` (set by `project.name` in `katip.config.yaml`).

| What                             | Name                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| Platform containers              | `katip-<service>-1`, for example `katip-policy-gateway-1`, `katip-postgres-1`, `katip-mongodb-1`, `katip-keycloak-1`, `katip-traefik-1` |
| A company's containers           | `katip-<slug>-lc-<slug>-1` (LibreChat), `katip-<slug>-meili-<slug>-1`, `katip-<slug>-rag-<slug>-1`, `katip-<slug>-ragdb-<slug>-1` |
| Platform volumes                 | `katip_pgdata`, `katip_mongodata`, `katip_valkey`, `katip_traefik-certs`, and Lago's `katip_lago-pgdata`, `katip_lago-valkey`, `katip_lago-storage` |
| A company's volumes              | `katip-<slug>_lc-uploads-<slug>`, `katip-<slug>_meili-<slug>`, `katip-<slug>_ragdb-<slug>` |
| Platform secrets                 | `infra/env/katip.env` (not in git)                              |
| A company's secrets              | `infra/env/tenants/<slug>.secrets.env` (not in git)             |
| Bootstrap state and logs         | `.katip/setup-state.json`, `.katip/logs/`                       |
| Deploy records and copies        | `.katip/deploys.json`, `.katip/backups/` (not in git)           |
| Images kept by a deploy          | `ghcr.io/krugis/<image>:deploy-<sha>`                           |
| Daily job log                    | `.katip/logs/daily.log`                                         |
| Chat UI, console, Keycloak       | `https://<slug>.localhost`, `https://console.localhost`, `https://auth.localhost` |

Run every `pnpm` command from the repository root. Never print or paste the secret files.
