---
name: validate-implementation
description: Adversarially audit the implemented code against the approved docs/plans/PLAN.md and the original challenge statement (static gates, test suites, traceability, money movement rules), and write the verdict to docs/plans/IMPLEMENTATION-REVIEW.md. Read only on product code. Run in a session different from the one that implemented. Argument; plan path.
---

# Validate implementation (audit)

Role: **adversarial reviewer** of the code, not of the plan. The plan was approved by
`/validate-plan`; here you prove that the code does what the plan and the statement say, and you
hunt the shortcuts an agent takes by habit (in-memory state, float money, `withTransaction`,
version prefixes, blind retries). A claim counts only with evidence: a `path:line`, a test name
that runs green, or a command and its output. "Looks right" is not evidence. Time box: about 20
minutes.

## Sources (read all before judging)

1. The original challenge statement, as provided by the user in the session. The statement wins
   over everything.
2. The plan given as argument (default `docs/plans/PLAN.md`), including its "Implementation log".
3. `CLAUDE.md` (sections 5 and 11 above all), `README.md`, `docs/ai-log.md`.
4. `git log --oneline` and `git status`. Audit `HEAD`; if the tree is dirty, say so in the report.

## Process

### 1. Static gates (deterministic)

Run `.claude/skills/validate-implementation/checks.sh`. Every `FAIL` is a finding of severity
**blocker**. Every `WARN` must be read at its `path:line` and closed in the report as
"justified (why)" or "finding". Never edit the script to make a gate pass; if a gate is wrong,
report it as a gate defect and propose the fix to the user.

### 2. Suites

- `npm run check` (lint with layer rules, typecheck, unit, build).
- `npm run infra:up && npm run test:e2e`. Run it **twice**: concurrency tests that pass once and
  fail once are a blocker (flaky proof of the eliminatory area).
- If Docker is not available, mark every e2e based row as "pending user" instead of passing it.

Record counts (files, tests, duration) and any skipped or `.only` test
(`grep -rnE "\.(skip|only)\(|\bxit\(|\bxdescribe\(" src test` must be empty).

### 3. Statement traceability (what the challenge evaluates)

Build one table per block; each row needs code `path:line` **and** a test name that exists
(`grep -rn "<test name>" src test`) **and** ran green in step 2.

- The 10 scenarios of slide 6.
- The 6 mandatory deliverables of slide 8 (both endpoints, multi pod idempotency, state machine,
  duplicated and out of order webhooks, the 4 test kinds, README).
- The 7 red flags of slide 13: for each, the evidence that the code does **not** have it.
- The 6 README topics of slide 9 and the 4 defense questions of slide 14: the README section
  that answers each one, and whether that answer is true of the code (open the code it describes).
- Contract of slide 5: field names, types (`amount` and `new_balance` JSON numbers), 200 example
  `250 + 100 = 350` reproduced by the e2e test.

### 4. Plan traceability

- **Files**: every path listed in "Implementation order" exists (or the "Implementation log"
  explains why not). Every file under `src/modules/cash-in/` is either in the plan or in the log:
  an unplanned file is a finding (scope creep or undocumented decision).
- **Tests**: every test name in the scenario matrix and the test plan exists verbatim. A missing
  name, or a test whose body does not assert what its name claims, is a finding. Open the
  concurrency e2e tests and check that the parallel requests really run in parallel
  (`Promise.all`, two app instances for the "5 pods" test, assertions on provider `calls` and
  ledger count).
- **Contract**: compare the plan's request/response/error tables of each endpoint with the DTO
  decorators, the response mapper, `@ApiDomainErrors(...)` and the controller status logic.
- **State machine**: every (state, trigger) row of the plan has a unit test and the aggregate
  returns the result the table says (`applied`, `ignored`, `conflict`).
- **Invariants and exceptions**: every exception of the plan exists with its `staticCode`, base
  class and HTTP status; every one raised in the flow is listed in the endpoint's
  `@ApiDomainErrors`.
- **Config**: every key of the config table is in `env.validation.ts`, `AppConfigService`,
  `.env.example` and `k8s/` with the same default; e2e env matches the plan. No key without a
  caller.
- **Commits**: one Conventional Commit per plan step, messages as in the plan, no AI attribution
  (`git log --format=%B | grep -i co-authored` must be empty).

### 5. Money movement review (read the code, do not grep it)

Walk each flow through the real code, citing `path:line` at each hop:

1. **5 pods, same key, same instant**: where the unique index decides the winner, what the four
   losers execute and answer, and why the provider is called once. Confirm nothing in that path
   lives in process memory.
2. **Provider timeout then client retry**: the operation is persisted before the call, the key is
   not released, the retry re-submits with the **same** operation id, credit happens once.
3. **Webhook before the API response, and both settling concurrently**: version check plus
   unique ledger `_id`; who retries and how many times (bounded).
4. **Duplicated and out of order webhooks**: dedup by `event_id` inside the same transaction;
   terminal states never move.
5. **DB failure before and after calling the provider**: the status the client receives in each
   case and that no path answers 4xx/5xx after the provider was called.
6. **Restart mid operation**: lease expiry and reconciler claim; two pods never process one
   operation.

For each, check the six rules of `CLAUDE.md` section 5 and the "risks to watch" list of the plan.

### 6. Documentation truth

Every number, name and behavior the README states (defaults, status codes, retry counts, paths,
curl outputs) matches the code. `docs/ai-log.md` entries reference real commits or files. No
`TODO(reto)` left (`grep -rn "TODO(reto)" src test README.md k8s`), no em dash in docs.

## Report

Write `docs/plans/IMPLEMENTATION-REVIEW.md`:

```
# Implementation review
Verdict: VERIFIED | GAPS FOUND
Audited: <commit sha>, <date>, session different from the implementer: yes/no

## Static gates        (checks.sh output summary; every WARN closed)
## Suites              (check + e2e x2: counts, durations, flaky: none/...)
## Statement coverage  (tables of step 3)
## Plan conformance    (tables of step 4)
## Money movement walkthroughs (step 5, with path:line)
## Findings
| # | Severity (blocker / major / minor) | Where (path:line) | What is wrong | Evidence | Proposed fix |
## Pending user smoke  (what only the user can verify)
```

`VERIFIED` only with zero blocker and zero major findings. Then summarize in chat (Spanish): the
verdict, the findings by severity and the proposed order of fixes.

## Rules

- **Read only on product code.** You may write only `docs/plans/IMPLEMENTATION-REVIEW.md` and,
  when the audit catches a mistake the agent made during implementation, an entry in
  `docs/ai-log.md` (what was asked, what the agent produced, why it was wrong). Fixes go through
  the user: after the report, ask which findings to fix; each fix then follows `/implement-plan`
  rules (test first, `npm run check`, one commit).
- A finding that needs a product decision (contract, behavior) goes to the user with
  AskUserQuestion; never resolve it by editing the plan.
- Never mark a row as covered because a test with a similar name exists: open it.
- Never commit. Never push.
