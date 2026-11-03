# Tabletop exercise

This is the acceptance for tracker P1-48: "Tabletop exercise done". **It has not been done.** It needs the owner. Until the result is recorded at the bottom of this page, P1-48 stays at `review`.

LLD-10 §9 asks for the same: the incident runbook rehearsed once before the pilot.

## How to run it

- **Who:** the owner, plus anyone else who may be on call. One person reads the injects aloud and takes notes. The others answer using only the runbooks in this folder.
- **Time:** about 90 minutes. Stop each scenario after 30 minutes even if it is not finished. That is a result too.
- **Rule:** nobody uses knowledge that is not in the runbooks. When someone says "I would just...", ask where that is written. If it is not, it is a gap. Write it down.
- **Commands:** talk through them. Do not run `dev:rollback`, `tenant:delete` or `tenant:purge-due`. The dev stack's `acme` company may be suspended and resumed for real if everyone agrees the data is only dev data.
- **Before you start:** read [README.md](README.md). Have the repository open. Check `pnpm dev:status` first, so you know the stack's state.

## Scenario 1: incident

**Setting.** Sunday, 03:10. Nothing alerts, because there is no monitoring. The owner's phone shows a message.

| Time | Inject (read aloud) | Questions |
| ---- | ------------------- | --------- |
| 03:10 | A message from the IT contact of company `acme`: "An employee says she saw a chat answer that showed customer names she did not type. She thinks it came from someone else's chat." | Who are you? What do you write down first? Where? What do you look at, and what is lost if you restart a container? |
| 03:25 | The gateway log shows many `pii_detector_failed` lines for `acme`, `action: allowed`, for the last two days. The provider console says the daily job last ran 3 days ago. | What does `allowed` mean? What went to the provider? Is the daily-job notice related? What do you check about the "someone else's chat" report? |
| 03:40 | You cannot tell whether another company is affected. | What do you do first: suspend `acme`, or all companies? What is the command? What happens to `acme`'s data? How do you undo it? |
| 03:55 | `acme` is suspended. Their IT contact asks: "Was our personal data leaked? Do we have to tell the authority? By when?" | What does LLD-10 say? Who do you call? What will you not say yet? Is a data processing agreement in place? |
| 04:20 | A provider API key shows up in a screenshot in a public chat. | Which key? How do you revoke it, where? How do you rotate it? What breaks while you do? What happens if the key is left empty? |
| 09:00 | Counsel calls back. | What do you hand over? What is the post-mortem deadline, and where do you write it? |

**Pass looks like:**

- Suspension done and understood within 15 minutes of the report, from the runbook only.
- Logs saved before anything was restarted.
- Nobody ran `dev:rollback` or `tenant:delete`.
- Counsel called, and the 72 hours understood as "verify with counsel".
- Every question answered from the runbooks, or logged as a gap.

## Scenario 2: restore

**Setting.** Tuesday, 14:00. Backups do not exist, and everyone knows it, because this page says so.

| Time | Inject | Questions |
| ---- | ------ | --------- |
| 14:00 | Company `acme` reports that all their old chats are gone. Search shows nothing. | What do you check? What is in Mongo for this company? What could cause it? |
| 14:15 | `docker volume ls` shows `katip_mongodata` is empty. | What copies exist? (Answer today: none, unless someone took one by hand.) What do you tell `acme`? Who decides? |
| 14:30 | Now suppose a hand copy from last Friday exists (see [restore.md](restore.md), "Take a copy by hand"). | Walk through restore A. What do you suspend first? What command restores one company? What is lost? What do you tell `acme`? |
| 14:50 | The same day, the machine's disk fails. | Walk through restore C. What must you have kept that is not in git? What happens if `katip.env` is gone? |

**Before the day:** take the hand copy for real (`restore.md`, "Take a copy by hand"), and then try restore A on **a second machine**, not the live stack. It cannot run beside the live stack (ports 80, 443). Note every command that failed and every fix.

**Pass looks like:**

- Everyone can say what is and is not backed up, in one sentence.
- The restore steps were tried once on a second machine. The result is written below, including what failed.
- The gaps found go to `docs/TRACKER.md` as items, and to P1-42.

A restore that was not tried on a second machine is **not tested**, and the result below must say that.

## Record the result

When the exercise is done, add a dated section here, below this line, using this template. Do not put personal data or prompt text in it.

```
### Tabletop: YYYY-MM-DD

- People:
- Scenario 1 (incident): time to suspend `acme`: __ min. Stopped at: __ . Completed: yes / no
- Scenario 2 (restore): restore A tried on a second machine: yes / no. Result:
- Questions that could not be answered from the runbooks:
- Commands that failed or did not exist:
- Fixes made to the runbooks (commit):
- New tracker items (IDs):
- Decision: P1-48 done / not done, because:
```

Then set P1-48 to `done` in `docs/TRACKER.md` only if both scenarios passed. Otherwise leave it at `review` and list what remains in its Notes.

## Results

None yet. The exercise has not been held.
