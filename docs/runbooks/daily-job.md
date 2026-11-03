# Runbook: the daily job

**Tested:** nothing. Written from `scripts/setup/tenant-lifecycle.mjs`, `schedule.mjs`, `tenant-cli.mjs`, LLD-07 §2c and the console's texts. Not rehearsed.
**Applies to:** the dev stack on WSL. Production does not exist yet.

## The schedule is OFF

**This is the owner's choice** (tracker P1-65). Until `jobs.daily_at` is set in `katip.config.yaml`, nothing runs the job. Approved person deletions, purges of deleted companies, retention and old-chat deletion wait until someone runs `pnpm tenant:daily`.

The provider console will say "never run" until then. That is expected, not a fault.

## What `pnpm tenant:daily` does

In this order. One part failing does not stop the next. Every part is safe to repeat.

1. **Deletions.** Carries out the deletions that company admins approved (`tenant:forget-due`): the person's search entries, vectors, uploads and database rows (details in LLD-07 §2b).
2. **Purges.** Destroys the data of deleted companies whose 30 days are over (`tenant:purge-due`). Cannot be undone.
3. **Retention.** Removes usage events older than 24 months and audit entries older than 5 years.
4. **Old chats.** Deletes each running company's chats older than its retention period (12 months by default, 1 to 120). At most 200 chats or 20,000 messages per batch, 25 batches per run, per company. A suspended company waits. Some files stay by design (LLD-07 §2c).
5. **Exchange rate.** Fetches the central bank's USD rate and stores it.
6. **Record.** Writes one `platform.daily` record to the audit log: counts and the number of failures. The console reads this.

It needs Docker on the host, and internet for step 5.

## Run it by hand

```
pnpm tenant:daily
```

On success it prints one line and exits 0:

```
2026-11-03T03:30:12.345Z People deleted: 0. Purged: none. Expired usage rows: 0, audit entries: 0. Old chats: 0, with 0 messages and 0 files (0 files kept). Companies with more chats waiting: 0. Exchange rate date: 2026-11-03.
```

(Example text; numbers will differ.) On failure it prints the same line, then `Failed:` and one line per failed part, and exits 1.

How to read it:

- `People deleted` and `Purged` should match what you expected to be due.
- `Companies with more chats waiting` above 0 means a company has more old chats than one run can remove. They go on the next runs. Not a failure.
- `Exchange rate date: none` means the rate could not be fetched. That part is counted as a failure.

A failed part: read the reason after `Failed:`, fix the cause, run the command again. Repeating is safe.

## Turn the schedule on

1. In `katip.config.yaml`, uncomment the block and choose a time (24-hour clock, this machine's local time):
   ```
   jobs:
     daily_at: '03:30'
   ```
2. Run `pnpm dev:up`. A change to the config makes it re-apply everything, and recreate LiteLLM and the companies' containers. Expect a short outage.
3. The `schedule` step adds one line to this user's crontab, ending in `# katip-daily <path of this checkout>`. Check:
   ```
   crontab -l | grep katip-daily
   ```
   The line runs `node scripts/setup/tenant-cli.mjs daily` (the same code as `pnpm tenant:daily`) under `flock`, and writes to `.katip/logs/daily.log`.

If `dev:up` says "no daily job scheduled: run pnpm tenant:daily yourself", this machine has no `crontab` program. Install `cron`.

**On WSL:** cron must be running (`service cron status`; it may not start by itself unless systemd is enabled for the distribution). If WSL is off at the chosen time, nothing runs. The next day's run picks up everything that was due. Choose a time when WSL is on.

To turn it off: comment out the block again and run `pnpm dev:up`. `pnpm dev:rollback` also removes the line, along with everything else. Do not use it for this.

## Read the log

```
.katip/logs/daily.log
```

- **Each run overwrites it.** Only the last run is kept. Copy it if you need it.
- It holds the one success line, or the failure text described under "Run it by hand". Anything else in it is an error from Docker or Node.
- Empty or missing: the job has not run from cron, or cron cannot write there. Check `crontab -l` and `service cron status`.
- The job uses `flock -n .katip/daily.lock`. If a run is still going, the next one exits quietly without writing.
- The per-step logs of `dev:up` are different files, in the same folder.

## What the provider console says

Shown to provider admins at `https://console.localhost`, by the company list. It reads the `platform.daily` records.

| State | Text (English) | Meaning | What to do |
| ----- | -------------- | ------- | ---------- |
| `ok` | The daily job last ran without problems on (date). | Last run had no failed part | Nothing |
| `never` | The daily job has never run. Approved deletions and purges are waiting. | No record exists. Expected while the schedule is off | Run `pnpm tenant:daily`, or turn the schedule on |
| `late` | The daily job has not run for over a day (last run: date). Approved deletions are waiting. | No record for more than about 26 hours (LLD-07 §2c) | Check cron and that WSL was on. Check `.katip/logs/daily.log`. Run `pnpm tenant:daily` |
| `failed` | The daily job had N failures in its last run (date). Check the log on the server. | A record exists with failures | Read `.katip/logs/daily.log`, fix, run `pnpm tenant:daily` |

Important:

- This is a notice on a screen someone has to look at. **Nothing alerts anyone** (P1-43).
- If the job cannot even write its record (for example Postgres is down), no record is written, and the console shows `late` a day later, not `failed`.
- `late` and `never` delay approved deletions. Do not leave that for long: people have asked to be deleted.

## What will change for production

- It will run on the production host, where cron is always on. The time should be in TRT and agreed.
- Alerts on failure or on a missed run (P1-43) will replace the screen notice.
- Backups (P1-42) hold deleted data until they age out after 30 days (LLD-10 §8).
