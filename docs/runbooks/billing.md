# Billing: Lago and billing-bridge

Lago bills companies for seats and overage (LLD-06). It runs once per platform, for the provider only. `billing-bridge` feeds it from the governance database every hour.

**What is tested:** `pnpm test:lago` runs Lago and billing-bridge on throwaway containers with made-up companies: setup, test customers, usage, a replay of every event, late usage, a seat change, and reconciliation. Unit tests cover the same rules. Nothing on this page has been rehearsed on the running stack, and no real customer has been billed.

**What doesn't exist yet:** invoices in TRY, e-Fatura and payment (P1-38, P1-39, both waiting on the owner). Lago's invoices are in USD and go nowhere. Lago's database isn't in `pnpm dev:deploy`'s copies, or in any backup.

## Where things are

| What | Name |
| --- | --- |
| Lago's containers | `katip-lago-api-1`, `katip-lago-worker-1`, `katip-lago-clock-1`, `katip-lago-db-1` (its own Postgres), `katip-lago-redis-1` (its own Valkey) |
| billing-bridge | `katip-billing-bridge-1`: on the `backend` network and on Lago's |
| Lago's network | `katip_billing`: internal, so nothing on it can reach the internet. No port is published and Traefik has no route |
| Lago's volumes | `katip_lago-pgdata`, `katip_lago-valkey`, `katip_lago-storage` |
| Lago's secrets | `LAGO_*` and `KATIP_BILLING_DB_PASSWORD` in `infra/env/katip.env` |
| What was sent | `billing_usage_sent` and `billing_seat_sent` in the governance database |
| Settings | `billing:` in `katip.config.yaml`. Seat prices: the `plans` table |

Lago's UI isn't deployed. To look at Lago, use its API from billing-bridge's container, which has the key in its environment:

```bash
docker exec katip-billing-bridge-1 sh -c 'wget -qO- --header "Authorization: Bearer $LAGO_API_KEY" http://lago-api:3000/api/v1/plans/katip_monthly'
```

Don't paste the key anywhere. The Sidekiq web page is off.

## Commands

All of them run in billing-bridge's container and print one `billing-result=` line:

```bash
docker compose -p katip exec billing-bridge node dist/cli.js setup
docker compose -p katip exec billing-bridge node dist/cli.js attach --slug acme --email fatura@acme.com.tr [--since 2026-11-01T00:00:00Z]
docker compose -p katip exec billing-bridge node dist/cli.js run
docker compose -p katip exec billing-bridge node dist/cli.js reconcile
```

(Or `docker exec katip-billing-bridge-1 node dist/cli.js …`.)

- **setup** creates Lago's metrics and the `katip_monthly` plan. `pnpm dev:up` runs it. Once they exist it only compares, and stops on any difference.
- **attach** gives a company its Lago customer (`external_id` = its slug) and subscription (`<slug>-monthly`), and records the subscription in `subscriptions.lago_subscription_id`. From then on, every run bills it. **Nothing attaches a company by itself**: in dev, `pnpm dev:up` attaches the companies in `katip.config.yaml` as test customers, with made-up addresses. On any other domain, attaching is the provider's decision, company by company. Only `billing_cycle = monthly` can be attached.
- **run** is one hourly run, now. The service runs one at start and then every hour. Two never overlap.
- **reconcile** runs, then compares, for this month: overage in `usage_events` against what was sent for the same hours (must be exact), and what was sent into Lago's current period against Lago's own count (within 0.1%, LLD-06 §7).

## How a run works

For each active, attached company: first anything left pending by an earlier run, then seats, then overage.

- **Overage**: tokens (input + output) of `usage_events` with `overage = true`, summed per UTC hour and per quota class. Premium is premium; standard, tr and embedding are standard, as the gateway's quota counts them. An hour goes 10 minutes after it ends (`grace_minutes`). The event's `transaction_id` is `<slug>-<yyyymmddhh>-<class>`.
- **Late usage**: if more usage arrives for an hour already sent (the gateway's Valkey outbox can hold events back while Postgres is down), the next run sends the difference as `<slug>-<hour>-<class>-1`, then `-2`, and so on. Up to `lookback_days` (35) back. Lago refuses a `transaction_id` it has seen, so nothing is billed twice. While the hour's month is open, the event is dated in that hour. Once the month is over it's dated now, so it goes on the current month's invoice: the month's last hour always does, as it goes 10 minutes into the next month.
- **Seats**: each change in `seats` (and the KVKK add-on, when `tenants.kvkk_addon`) goes as the difference: `<slug>-seats_<plan>-<n>`. Seats are invoiced at the start of the month (`seats_in_advance`). One added mid-month is charged for the rest of the month; one removed isn't refunded, and is gone from the next month.
- A row is written as `pending` before its event goes and marked `sent` after. A run that stops anywhere leaves at worst pending rows, which the next run sends again under the same id.

## When something is wrong

| Sign | What to do |
| --- | --- |
| billing-bridge's `/readyz` fails, or its log says `billing run failed for this company` | Read the log line: it names the company by id. `node dist/cli.js run` again shows the same error. If Lago is down, nothing is lost: the next run sends everything since |
| `setup` stops with "Lago's catalog differs" | Someone changed a price in the config or the plans table, or in Lago. Nothing was changed. Decide which is right. Changing a price in Lago changes it for every company on the plan, from their next invoice: it's the owner's decision, made in Lago's API, then the config made to match |
| `reconcile` says `usage` and `sentForHours` differ | A run hasn't caught up (wait for the next hour), or usage older than `lookback_days` arrived. Look at `billing_usage_sent` for the company |
| `reconcile` says `sentInPeriod` and `lago` differ | Lago lost or refused events. Check Lago's API logs (`docker logs katip-lago-api-1`) |
| `usage is now below what was billed for this hour` | Usage events were deleted after being billed. Nothing is taken back from Lago automatically |

## Secrets

`pnpm secrets:rotate` handles `KATIP_BILLING_DB_PASSWORD` and `LAGO_REDIS_PASSWORD`. It refuses the others, because changing the env file wouldn't rotate them:

- `LAGO_API_KEY`: Lago adds a new key at its start but keeps the old one. Rotating it means removing the old key in Lago too, which isn't scripted.
- `LAGO_ADMIN_PASSWORD`: set only when Lago creates its user.
- `LAGO_DB_PASSWORD`: needs `ALTER ROLE lago` in `katip-lago-db-1` first, which the tool doesn't do yet.
- `LAGO_ENCRYPTION_*`: Lago encrypts columns with them. A new value makes them unreadable.
- `LAGO_SECRET_KEY_BASE`, `LAGO_RSA_PRIVATE_KEY`: sessions and login tokens of Lago's UI, which isn't deployed.

## Production

Same as dev, except that `pnpm dev:up` attaches no company. Before billing anyone, the owner's decisions in LLD-06 §8 are needed, and P1-38 and P1-39. Lago's database needs its own backup (P1-42).
