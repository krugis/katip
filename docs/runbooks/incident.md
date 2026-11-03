# Runbook: incident

**Tested:** nothing. Written from LLD-10 §7, the gateway source and `scripts/setup/`. Not rehearsed.
**Applies to:** the dev stack on WSL. Production does not exist yet.

## Read this first

- **There is no monitoring and no alerting** (P1-43 is `todo`). Nothing will wake you. You will hear of an incident from a person, from the provider console's daily job notice, or by looking.
- **There are no backups** (P1-42). Recovery is limited. See [restore.md](restore.md).
- This page is not legal advice. For anything that may involve personal data, call counsel (see step 3).

## 0. Stay calm. Start a note

1. Write down the time, who reported it, and what they said. Use a private text file. The repository has no `incidents/` folder or template yet, though LLD-10 §7 names one.
2. Put no personal data and no prompt text in the note. Use ids, company slugs and times.
3. Do not restart containers yet. `docker compose` recreates a container on restart and **its logs go with it**. First save what you need (step 1).

## 1. Look

Save logs before you change anything. Logs rotate at 10 MB times 3 files per container, so old lines vanish fast.

```
pnpm dev:status
docker logs --since 2h katip-policy-gateway-1 > gateway.log 2>&1
docker logs --since 2h katip-keycloak-1 > keycloak.log 2>&1
docker logs --since 2h katip-<slug>-lc-<slug>-1 > librechat.log 2>&1
docker logs --since 2h katip-traefik-1 > traefik.log 2>&1
```

Replace `<slug>` with the company, for example `acme`. The log files hold ids, not prompts, by design (CLAUDE.md rule 5). Treat them as private anyway.

What to look for:

| Where | What | Meaning |
| ----- | ---- | ------- |
| Gateway log | `"event":"pii_detector_failed"` with `tenant_id`, `user_id`, `action` | The name detector (Presidio) failed on a request. `action` is `allowed` (sent on with structured masking only: **names may have gone to the provider unmasked**) or `blocked` (the user got an error). Depends on the company's `pii.on_detector_failure` |
| Gateway log | `"event":"request_fields_dropped"` (warning) | A request carried fields not on the allow list |
| Gateway log | Level 50 (error) lines | Gateway failures |
| Keycloak log | Login errors, many failures | Possible attack on logins, or Keycloak down |
| Traefik log | Many requests from one address | Possible scan or attack |
| `.katip/logs/daily.log` | Errors | The daily job failed: [daily-job.md](daily-job.md) |
| Provider console | The daily job notice | [daily-job.md](daily-job.md) |

Find the detector failures:
```
docker logs katip-policy-gateway-1 2>&1 | grep pii_detector_failed
```

Gateway metrics (counts since the gateway last started; they reset on restart). The token is read inside the container, so you do not see it:
```
docker exec katip-policy-gateway-1 sh -c 'wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics' | grep '^gw_'
```

| Metric | Look for |
| ------ | -------- |
| `gw_requests_total` (labels tenant, alias, model, status) | A rise in failed statuses |
| `gw_upstream_errors_total` (label model) | A provider failing |
| `gw_pii_detector_failures_total` (labels tenant, action) | Same event as `pii_detector_failed`, counted |
| `gw_quota_denials_total` (labels tenant, class) | A company hitting its limit |
| `gw_tokens_total`, `gw_upstream_latency_seconds`, `gw_overhead_seconds`, `gw_pii_entities_total` | Unusual volume or slowness |

No dashboard runs yet. A Grafana dashboard definition exists in `infra/monitoring/` but Grafana does not run (P1-43).

If a service is down: `pnpm dev:up` retries what failed. If you do not know why it is down, find out before restarting it.

## 2. Contain

Pick the smallest action that stops the harm. Write down each action and its time.

| Situation | Action |
| --------- | ------ |
| One company is affected, or may leak | `pnpm tenant:suspend --slug <slug>`. Containers stop. The gateway refuses the company within a minute. **Data is kept.** Undo: `pnpm tenant:resume --slug <slug>` |
| A provider key leaked | Revoke it at the provider first. Then rotate it: [secret-rotation.md](secret-rotation.md) |
| A company's gateway key leaked | Rotate `GATEWAY_KEY`: [secret-rotation.md](secret-rotation.md). Or suspend the company |
| Some other secret leaked | [secret-rotation.md](secret-rotation.md). Some cannot be rotated safely today. It says which |
| Everything must stop | `pnpm dev:down`. All data is kept. `pnpm dev:up` starts it again |
| Block an address | **No tool exists.** Cloudflare is not set up (P1-44). In dev the stack is not public |

**Do not use** `pnpm dev:rollback` ([rollback.md](rollback.md)), or `pnpm tenant:delete`. `tenant:delete` locks the company out and schedules a purge in 30 days. Suspend is the right containment.

If `tenant:suspend` fails: run it once more. If it still fails, stop that company's containers by hand: `docker compose -p katip-<slug> stop`. The gateway still serves the company until its status is `suspended`, so keep trying the command, and consider `pnpm dev:down`.

## 3. Assess personal data

Ask: did personal data of any person leave, or reach someone who should not see it?

Where personal data is in this system:

- Chat content: in each company's Mongo database `lc_<slug>`, and its search index, uploads and vectors.
- The gateway does not store prompts unless a company opted in. It stores ids and counts in `usage_events`.
- Providers received masked text. A `pii_detector_failed` with action `allowed` is the case where names were not masked.
- People's emails and names: governance database and Keycloak.

Write down: which company, which people if known, what data, from when to when.

**KVKK breach notification.** LLD-10 §7 says: if personal data is affected, notify the KVKK Board within **72 hours**, "verify the current rule with counsel", and notify the affected companies. That is all the documents say.

- This page does not give legal advice. Call counsel now, not after you have finished investigating.
- The documents do not say when the 72 hours start, or who must notify whom (us or the company). Ask counsel.
- The data processing agreement and sub-processor list (P1-49) are not done. The company's contract may add duties. Ask counsel.
- Do not tell a company or the Board anything that counsel has not seen, unless the owner decides to.

Notify affected companies: the owner decides what to say and when. No template exists.

## 4. Recover

1. Remove the cause. Rotate keys, fix or roll back the code ([rollback.md](rollback.md)).
2. Bring the company back: `pnpm tenant:resume --slug <slug>`. It starts the containers and runs the smoke check.
3. If data was damaged or lost: [restore.md](restore.md). Backups do not exist, so check what copy you have.
4. Check with [deploy.md](deploy.md), "How to check it worked".

## 5. After

1. Write the post-mortem within 5 days (LLD-10 §7): what happened, when, how it was found, what was done, what to change. Ids only.
2. Put each fix in `docs/TRACKER.md`.
3. Fix these runbooks where they were wrong or unclear.

## What will change for production

- Alerts will go to phone and email (P1-43), including on `pii_detector_failed` and a failed provisioner job. Today they do not.
- Cloudflare will allow blocking addresses and enforcing country rules (P1-44).
- Backups (P1-42) make step 4 possible.
- The `incidents/` folder and its template will need to exist.
- The host will be reachable over Tailscale only (P0-09). Commands will run there, not on a WSL machine.
