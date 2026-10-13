# Wallet Cash-In

Top up a wallet balance through an external payment provider, without ever charging or crediting twice: across client retries, several pods, provider timeouts and duplicated or out of order webhooks.

NestJS service built with **DDD** and **CQRS** (`@nestjs/cqrs`) on **MongoDB**.

## Problem and assumptions

A digital wallet app tops up a user's wallet by charging an external payment provider. This service exposes `POST /cash-in` (charges the provider and credits the wallet) and `POST /webhooks/payment` (the provider's asynchronous notifications). The hard part is the guarantee: **a user is charged at most once and credited exactly once per operation**, under double clicks, automatic retries, several pods receiving the same request, provider timeouts (the charge outcome is unknown), duplicated or out of order webhooks, webhooks that arrive before the API answered, temporary database failures, restarts in the middle of an operation and concurrent credits to one balance.

The central question of the statement is: the provider charges S/100, a timeout happens before it answers, the client retries. How do you avoid charging twice? The short answer: the operation is persisted (unique per user and `Idempotency-Key`) **before** the provider is called, our operation id is the provider's idempotency key, an unknown outcome leaves the operation `pending` (the key is never released), and the retry, the webhook or the reconciler resolve it by re-submitting the same idempotent charge or applying the notification, with a single transactional credit.

### Decisions taken

| Decision | Choice |
|---|---|
| Persistence | DDD aggregates stored as versioned MongoDB documents, `@nestjs/cqrs` for commands. No event sourcing, no Redis, no message broker. |
| Provider timeout or unknown outcome | `202 Accepted` with `status: "pending"`. The client retries with the same key. |
| Credit | Synchronous in the request when the provider approves. The webhook is an idempotent confirmation that can also settle the operation if it arrives first, or if the API never got the answer. |
| Provider declines | `200 OK` with `status: "failed"` and `failure_reason`. A replay returns the same body. |
| `new_balance` | Present only when `status` is `completed` (the balance right after that credit, stored on the operation). Omitted for `pending` and `failed`: a `null` balance would read as "zero or unknown". |
| Same key while the first request is calling the provider | `202 pending`, without calling the provider again. |
| Wallet | Created on the first cash-in of a user. The demo user `usr_abc123` is seeded with 250.00 PEN (`npm run seed`). |
| HTTP contract | Exact paths of the statement (`/cash-in`, `/webhooks/payment`, no version prefix), snake_case fields, `amount` and `new_balance` as JSON numbers. No GET endpoints. |

### Assumptions

| # | Assumption | If it were wrong |
|---|---|---|
| A1 | `user_id` in the body is trusted (the statement has no authentication). | Take the user from the token; the idempotency scope becomes the authenticated principal. |
| A2 | One wallet per user, one currency, fixed by the first cash-in. A cash-in in another currency is rejected with 422 before charging. | The wallet becomes a set of balances keyed by currency. |
| A3 | Idempotency keys never expire: the operation document is the idempotency record and the audit trail. | A TTL index on terminal operations after N days. |
| A4 | JSON numbers cannot keep trailing zeros: `350.00` is serialized as `350`, the same numeric value as the statement's contract. | Render strings (a contract change the statement does not allow). |
| A5 | The provider supports idempotency keys (Stripe like): the same key returns the original result and never charges twice. Our `operation_id` is that key. Resolving a pending operation re-submits the charge with the same key instead of calling a status API. | If the provider has a status lookup, the reconciler uses it. If it has no idempotency at all, the design needs a status lookup before any re-submit. |
| A6 | The webhook contract and signature scheme are ours (Stripe like HMAC), since the statement only gives the path. | Adapt the DTO and the verifier to the real provider. |
| A7 | A notification's `amount` and `currency` must equal the operation's, otherwise it is rejected (422) and logged as an error. | Accept it and flag it for review. |
| A8 | Maximum amount per operation 1,000,000.00 (an input sanity limit, not a business rule). | Change the constant. |
| A9 | "Provider unavailable" (connection refused, 5xx) is an **unknown** outcome, never "failed": a 5xx may come after the charge was processed. | None: this is the safe side. |

Out of scope: GET endpoints (the client polls by retrying with the same key), authentication, refunds and chargebacks, multi currency wallets, a real provider integration (the provider is a simulated adapter behind a port), a wallet or ledger as a separate service, outbox and integration events.

## Proposed architecture

```
client ──► POST /cash-in ──► InitiateCashInHandler ──► CashInProcessor ──► PaymentProvider (simulated, port)
                                   │                          │
provider ─► POST /webhooks/payment ─► HandlePaymentNotificationHandler
                                   │                          ▼
reconciler (every pod, periodic) ─► ReconcilePendingOperationsHandler ─► CashInUnitOfWork
                                                              │            (one Mongo transaction)
                                                              ▼
                              MongoDB: cash_in_operations, wallets, ledger_entries, payment_notifications
```

One bounded context, `src/modules/cash-in/`, with Clean Architecture layers (`domain`, `application`, `infrastructure`, `api`) enforced by the linter. Wallet and ledger live in the same context so the credit is one local transaction; splitting them into a wallet service is an evolution (see the end).

| Piece | Responsibility |
|---|---|
| `CashInOperation` aggregate | One top up attempt, unique per (user, idempotency key). Owns the state machine and the rule that a replay must carry the same request. |
| `Wallet` aggregate | The balance in one currency. `credit` records a `LedgerEntry`; the balance can never go negative because only positive credits exist. |
| Commands | `InitiateCashIn`, `HandlePaymentNotification`, `ReconcilePendingOperations`. One handler each; handlers orchestrate, rules live in the aggregates. |
| `CashInProcessor` | Shared orchestration: submit the charge, map the provider outcome to an aggregate method, persist through the unit of work. |
| `CashInUnitOfWork` | Persists operation, wallet, ledger entry and notification atomically (a Mongo transaction) or none. |
| `PaymentProvider` port | `SimulatedPaymentProvider` adapter with a timeout and bounded retries. The simulated provider keeps its own state in Mongo (never in memory), so every pod talks to the same provider. |

### Operation state machine

States: `pending` (initial), `completed` and `failed` (terminal and absorbing).

| From | Trigger | To | Effect | Result |
|---|---|---|---|---|
| pending | approved, or `payment.succeeded` | completed | credit the wallet, write the ledger entry, store charge id and `balanceAfter` (one transaction) | applied |
| pending | declined, or `payment.failed` | failed | store `failureReason` | applied |
| pending | provider outcome unknown | pending | release the lease, answer 202 | no transition |
| pending | `payment.processing` | pending | record the notification | ignored |
| completed | approved, `payment.succeeded`, `payment.processing` | completed | none (duplicate or late) | ignored |
| completed | declined, `payment.failed` | completed | none, logged as `error` "conflicting provider outcome" | conflict |
| failed | declined, `payment.failed`, `payment.processing` | failed | none | ignored |
| failed | approved, `payment.succeeded` | failed | none, logged as `error`: charged but not credited, manual review | conflict |

A transition that a terminal state does not allow is **ignored or reported as a conflict, never rejected**: duplicated, late and out of order notifications are expected, and a rejection would make the provider retry forever. Conflicts are still acknowledged with 200 and surface as error logs.

### Request flow of `POST /cash-in`

1. Look the operation up by (`user_id`, `Idempotency-Key`). Found: it is a **replay** (below).
2. Load the wallet or create it, and fail fast with 422 if the currency does not match (nothing charged yet).
3. Insert the operation as `pending` with a lease. The unique index decides who owns the key: a loser of that insert becomes a replay.
4. Call the provider with `operation_id` as its idempotency key, under a timeout.
5. Settle in one transaction: operation completed (or failed), wallet balance, ledger entry. Answer 200.
6. If the outcome is unknown, or settling cannot be persisted, release the lease and answer **202 pending**. From the moment the provider may have been called, this endpoint only answers 200 (final) or 202 (pending): never a 4xx or 5xx that would invite the client to use a new key.

Replay: a different amount, currency or payment method for the same key is a 422. A final operation answers its stored result. A pending one is claimed atomically: if the lease is free the charge is re-submitted with the same provider key, otherwise the provider is not called and the answer is the operation's current state, re-read from the database: 202 while another request is still on it, or the final 200 if it settled in the meantime (for example by a webhook).

## Idempotency strategy

- **The database is the source of truth.** The idempotency key is scoped per user and protected by a unique index `{ userId, idempotencyKey }` on `cash_in_operations`. A duplicate insert means "this operation already exists": the handler loads it and answers from its current state. Nothing is kept in memory (no variable, `Map` or per process cache), so it holds across pods and restarts.
- **The operation is persisted before the provider is called**, so there is always a record to resume from, whatever dies afterwards.
- **The key is never released once the provider may have been called.** A failure before the provider (for example Mongo down) answers 500 and the retry is new, because nothing was charged. An unknown outcome (timeout, connection reset, 5xx) keeps the operation `pending`.
- **The provider deduplicates too.** Our `operation_id` is the provider's idempotency key, so re-submitting a charge is safe by construction: the answer to the central question is that a retry never creates a second charge, it asks the provider again with the same key and gets the recorded result.
- **The credit is exactly once.** The ledger entry is unique by operation id, and the wallet balance and the ledger entry change in the same transaction as the operation state.
- Idempotency records never expire (they double as the audit trail).

## Concurrency handling

**"5 pods receive the same `Idempotency-Key` at the same instant: what guarantees only one processes it?"** All five miss the initial lookup. One `insertOne` wins the unique index, the other four get a duplicate key error, load the winner and try to `claim` it: an atomic `findOneAndUpdate` on `{ status: 'pending', leaseUntil: free or expired }`. The winner holds the lease, so the four answer `202 pending` without calling the provider: exactly one provider call. If a loser arrives after the winner finished, it gets the final 200.

Layers of protection, from cheapest to the one that actually carries the money guarantee:

1. **Lease** (`leaseUntil`, 15 s): an efficiency guard that saves provider calls. It depends on the pod clock and a slow provider call can outlive it, so it is **not** what makes the system correct.
2. **Provider idempotency key**: if two processes do submit the same operation, the provider returns the same charge.
3. **Versioned settlement**: the operation and the wallet are updated with `{ _id, version: expected }` and `$inc: { version: 1 }` inside one Mongo transaction. Zero matched documents means someone else changed it.
4. **Unique ledger entry** (`_id` = operation id) and **unique notification** (`_id` = provider event id).

**Race on the balance.** Five concurrent credits to one wallet: each settlement reloads the wallet, applies the credit and commits with the wallet version it read. A version mismatch or a transient write conflict between two transactions raises a `ConcurrencyException`, and the settlement reloads and re-applies (up to 5 attempts, with jittered backoff). Every round at least one settlement lands, so N concurrent credits need at most N attempts. The transaction is driven by hand rather than with `session.withTransaction`, whose internal retry loop can run for 120 s: the retry here is bounded and owned by the caller.

## Retry strategy

| What | Retried | Policy | Why it is safe |
|---|---|---|---|
| Provider charge, provider unavailable | yes, inside the request | 3 attempts in total, exponential backoff with full jitter (50 ms base, 1 s cap) | same idempotency key every time |
| Provider charge, timeout (3 s) | no, inside the request | the client retries with the same key, or the webhook or the reconciler resolves it | same key; never a new key for the same operation |
| Settlement on a version conflict | yes, reload and re-apply | 5 attempts, same backoff | conditional on `pending` plus version; unique ledger id |
| Database failure before the provider call | no | 500, the client retries | nothing was charged |
| Database failure after an approval | no | 202 pending, resolved later | the operation is still pending, the provider remembers the charge |
| Reconciler re-submission | yes, every 15 s | until 10 provider submissions per operation, then it stays pending for manual review | same key |
| Client (documented) | `202` or `5xx`: retry with the **same** key. `4xx`: do not retry | | |

Never: a new charge with a new key for an existing operation, releasing the key, retrying a declined charge, an unbounded retry loop. Every external call has a timeout (`PROVIDER_TIMEOUT_MS`). The lease must outlast the worst in-request provider time, so the app refuses to boot when `OPERATION_LEASE_MS <= PROVIDER_TIMEOUT_MS * PROVIDER_MAX_ATTEMPTS + RETRY_MAX_DELAY_MS * (PROVIDER_MAX_ATTEMPTS - 1)`.

**Reconciler.** Every pod runs a periodic job (`RECONCILER_INTERVAL_MS`) that claims stale pending operations atomically in Mongo (so two pods never take the same one) and re-submits them with the same provider key. This covers a process that died after inserting the operation or after the provider charged. Within one run an operation is handled at most once (its id is excluded from the next claim), so a provider that keeps failing does not burn an operation's submission budget in a single pass.

## Webhook handling

Webhooks are treated as untrusted, repeated and unordered.

- **Authenticated.** `x-provider-signature: t=<unix seconds>,v1=<hex>`, where `v1 = HMAC_SHA256(secret, "<t>.<raw body>")`. It is verified on the **raw** bytes with a constant time comparison, and the timestamp must be within 5 minutes of now (replay window). A guard checks it before validation, so an unsigned body never reaches the handler: 401. The scheme is our own (the statement defines none) and mirrors the usual provider pattern.
- **Deduplicated.** The provider `event_id` is the `_id` of `payment_notifications`. The notification is inserted in the same transaction that applies it, so a repeated event aborts the transaction and answers `duplicate`, and a crash before the commit leaves nothing recorded so the provider's retry is processed normally.
- **Idempotent transitions.** `payment.succeeded`, `payment.failed` and `payment.processing` are applied through the state machine above. Out of order or late ones answer `ignored` or `conflict` and never move a terminal operation.
- **Webhook before the API response.** The operation exists (it was inserted before the provider was called), so the notification completes it and credits the wallet. When the provider's answer reaches the API, the settlement finds the operation already completed, ignores the duplicate confirmation and answers 200 with the stored balance. If both commit at the same moment, the second fails the version check, retries, and sees `completed`: one credit.
- **Validated.** The amount and currency must match the operation (422 otherwise, not recorded). An unknown operation is 404 (not recorded, so a later retry is processed). Unknown fields are a 400.
- Always `200` with `{ "result": "applied" | "ignored" | "conflict" | "duplicate" }` on acknowledgement. Transient failures (version conflicts after the retries, database down) answer 409 or 500 so the provider retries later. The webhook route is not rate limited.

## Scenarios covered

Concurrency claims are proven with real parallel requests against a real MongoDB (`test/*.e2e-spec.ts`), not argued. Unit tests use in-memory doubles that keep the same semantics (unique keys, atomic lease, version checks).

| # | Scenario | Mechanism | Tests |
|---|---|---|---|
| 1 | Double click | unique (`userId`, `idempotencyKey`) plus lease | e2e `charges once when 5 requests share a key`; unit `answers pending without calling the provider when the key is in flight` |
| 2 | Automatic app retry | replay of the final result; re-submission of a pending one with the same provider key | e2e `returns the same body on a retry with the same key`; unit `replays a completed operation without calling the provider`, `re-submits a pending operation with the same operation id when the lease is free` |
| 3 | Concurrent pods | all state in Mongo (unique index, atomic claim, versioned transactions), nothing in memory | e2e `charges once when 5 requests share a key` (requests spread over **two app instances**, provider called once, one ledger entry); e2e `grants the lease to exactly one of 5 parallel claims` |
| 4 | Provider timeout | timeout becomes an `unknown` outcome, 202 pending, lease released, key kept | unit `returns unknown on timeout without retrying`, `leaves the operation pending and releases the lease when the outcome is unknown`; e2e `completes a timed out charge on retry without charging twice` |
| 5 | Duplicated webhook | unique `payment_notifications._id` in the same transaction | unit `answers duplicate for a repeated event id and credits once`; e2e `credits once when the same notification arrives twice` and `...5 times in parallel` |
| 6 | Out of order webhook | absorbing terminal states, `ignored` and `conflict` | unit `ignores processing after completed`, `reports conflict for failed after completed...`, `reports conflict for succeeded after failed...`; e2e `keeps a completed operation when a failed notification arrives late` |
| 7 | Webhook before the API response | operation persisted before the provider call; both paths settle through the versioned transaction | unit `credits once when the notification settles before the provider answers`; e2e `credits once when the webhook arrives while the provider call is in flight` |
| 8 | Temporary DB failure | before the charge: 500 and nothing charged; after an approval: 202 pending, resolved later; transactions are all or nothing | unit `propagates a data source failure before calling the provider`, `answers pending when settlement cannot be persisted after an approval`; e2e `rolls back operation and wallet when the ledger entry already exists` |
| 9 | Restart in the middle | every step is persisted before the next; lease expiry plus the reconciler | e2e `reconciler completes an operation whose process died before calling the provider`, `reconciler completes a timed out operation` |
| 10 | Race on the balance | wallet version check inside the transaction plus bounded retry | e2e `applies 5 concurrent cash-ins of one user exactly once each`; unit `retries settlement on a concurrent wallet update` |
| | Example of the statement (250 + 100 = 350) | | e2e `returns the statement contract for a completed cash-in` |
| | Provider failure | `markFailed` | unit `fails the operation when the provider declines`; e2e `returns failed without new_balance when the provider declines` |
| | Provider unavailable | bounded retry with backoff, then unknown | unit `retries an unavailable provider up to the max attempts, then returns unknown`; e2e `answers pending after the provider stays unavailable` |
| | Key reused with another payload | invariant of the aggregate | unit `rejects a reused key with a different amount`; e2e `rejects a reused key with another payload` |
| | Invalid signature | guard plus verifier | unit verifier cases; e2e `rejects an unsigned notification` |

## Use of AI (what I asked the agent and what I corrected)

The statement evaluates the specs given to the agent and what I corrected when it was wrong, so the whole workflow is versioned in this repo.

**What I gave the agent**

- **Standing specs:** [CLAUDE.md](CLAUDE.md) is the engineering contract every session starts from: layer dependency rules (enforced by the linter), the aggregate and state machine conventions, error taxonomy, testing policy, and a section of non negotiable money movement rules (no in-memory state for correctness, the database is the idempotency source of truth, never release a key after the provider may have been called, never retry a charge blindly, credit exactly once, webhooks are untrusted and unordered, every external call has a timeout).
- **A four step flow, each step a skill in `.claude/skills/`:** `/challenge-plan` turns the statement into a plan and must ask me every open decision; `/validate-plan` attacks that plan **in a fresh session** as an adversarial auditor with a fintech checklist, until it is stamped `APPROVED FOR IMPLEMENTATION`; `/implement-plan` executes the approved plan literally, one commit per step, and **stops and asks** when it would have to assume something; `/validate-implementation` audits the finished code **in a fresh session** against the plan and the statement (deterministic gates in `checks.sh` for the shortcuts an agent takes by habit: in-memory idempotency, float money, `withTransaction`, version prefixes, Redis; both test suites run twice; a code walkthrough of every money path), and only reports: I decide which findings get fixed. The plan, with its decisions table and validation log, is in [docs/plans/PLAN.md](docs/plans/PLAN.md); the audit and its fixes are in [docs/plans/IMPLEMENTATION-REVIEW.md](docs/plans/IMPLEMENTATION-REVIEW.md).
- **Guardrails:** hooks that block pushes, hook bypass flags and reading secrets, plus husky (gitleaks, lint, commitlint, `npm run check` before a push). The agent commits, I push.

**What I corrected or redesigned** (full table with the reasoning in [docs/ai-log.md](docs/ai-log.md))

- The agent's first idempotency design was a Redis interceptor with a `SET NX` lock that **released the key on any error**: exactly the double charge of the central question. I replaced it with MongoDB as the source of truth and the "never release after the provider may have been called" rule.
- The agent had prepared an event sourcing, RabbitMQ and Redis base before the statement existed. I measured the cost per requirement and removed all of it for versioned documents with transactions, because event sourcing made the atomic credit harder (two streams) for no gain in what is evaluated.
- It had made amounts decimal strings and added `/v1`, against the statement's binding contract (`/cash-in`, JSON numbers). It proposed `new_balance: null` for non completed operations, which I changed to omitting the field.
- The adversarial validation in a fresh session found a plan that would answer 5xx after the provider may have charged, a default webhook secret that would have broken `docker compose up`, a "5 pods" test that ran on one app instance, and flaky e2e design.
- During implementation, the agent noticed that the reconciler loop would claim the same stuck operation again right after releasing its lease and exhaust its submission budget in one run. It stopped and asked instead of improvising; I chose to pass the already handled ids to the claim.

## How to run

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker Desktop | running | `docker compose` v2.23+ |
| Node.js | 24 | `nvm use` reads `.nvmrc` |
| npm | 11 | ships with Node 24; npm 10 has a resolver bug with this dependency tree |
| jq | any | only for the pretty log view |

First time:

```bash
nvm use
npm install
```

No `.env` is needed: defaults point to the local containers. Copy `.env.example` to `.env` only to override something.

### Option A: everything in Docker (closest to production)

```bash
docker compose up --build            # foreground: logs of every service in this terminal, Ctrl+C stops all
# or
docker compose up -d --build --wait  # background, returns when every service is healthy
npm run logs                         # follow the API logs, human friendly (Ctrl+C stops following only)
```

### Option B: local development with hot reload

```bash
npm run infra:up                     # Mongo in Docker, waits until healthy
npm run start:dev:pretty             # API on the host, restarts on save, readable logs
# npm run start:dev                  # same, raw JSON logs
```

If the API container from option A is still running, port 3000 is taken: `docker compose stop api` first.

### URLs

| What | URL |
|---|---|
| API | http://localhost:3000 |
| Try requests in the browser (Scalar) | http://localhost:3000/reference |
| Swagger UI | http://localhost:3000/docs |
| OpenAPI document (Postman, Insomnia, Bruno) | http://localhost:3000/docs-json |
| Health | http://localhost:3000/health/ready |
| MongoDB (Compass) | `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true` |

### Logs

The API writes one JSON object per line (the format a log collector expects). Locally, `scripts/pretty-logs.sh` renders them in a readable form.

| Want to see | Command |
|---|---|
| API logs, readable (Docker) | `npm run logs` |
| API logs, raw JSON (Docker) | `docker compose logs -f api` |
| One request end to end | send `x-trace-id: my-id` and search `trace=my-id` |
| Everything | `docker compose logs -f` |
| MongoDB (logs to a file) | `docker compose exec mongo tail -f /var/log/mongodb/mongod.log` |

Infrastructure is quiet on stdout on purpose (warnings and errors only); health probes are not logged.

### Tests

```bash
npm test            # unit tests. No infrastructure needed
npm run test:e2e    # e2e against real Mongo (npm run infra:up first)
npm run check       # lint (layer rules) + typecheck + unit tests + build: same gate as CI
.github/scripts/security-gate.sh   # secrets, dependency CVEs, SAST (needs gitleaks, osv-scanner, semgrep)
```

### Stop and reset

```bash
docker compose down        # stop everything, keep data
docker compose down -v     # stop and delete data
```

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot connect to the Docker daemon` | Docker Desktop is not running: open it and retry |
| `ECONNREFUSED 127.0.0.1:27017` on `start:dev` | Infrastructure not up: `npm run infra:up` (the API fails fast after 5 s) |
| `EADDRINUSE :3000` | The API container is running: `docker compose stop api` |
| `Cannot read properties of null (reading 'edgesOut')` on install | npm 10: `nvm use` (Node 24 ships npm 11) |

## API examples

Start the stack and seed the demo wallet (`usr_abc123`, 250.00 PEN):

```bash
docker compose up -d --build --wait
npm run seed
```

The simulated provider reacts to `payment_method`: `card_declined` (declines), `card_timeout` (charges, but the first response takes too long), `card_slow` (answers after 1.5 s, useful for concurrent duplicates), `card_unavailable` (refuses connections). Anything else is approved.

**The example of the statement** (balance 250.00, top up 100.00)

```bash
KEY=$(uuidgen)
curl -i -X POST http://localhost:3000/cash-in \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"user_id":"usr_abc123","amount":100.00,"currency":"PEN","payment_method":"card_xyz"}'
# 200 {"operation_id":"op_...","status":"completed","amount":100,"new_balance":350}
```

**Same key again (retry or double click):** run the same command with the same `$KEY`. Same body, no second charge.

**Same key, another payload:** change the amount, keep `$KEY`. Answer `422` with code `idempotency-key-reused-exception`.

**Provider timeout, then retry with the same key**

```bash
KEY=$(uuidgen)
BODY='{"user_id":"usr_abc123","amount":100.00,"currency":"PEN","payment_method":"card_timeout"}'
curl -s -X POST localhost:3000/cash-in -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" -d "$BODY"
# 202 {"operation_id":"op_...","status":"pending","amount":100}
curl -s -X POST localhost:3000/cash-in -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" -d "$BODY"
# 200 {"operation_id":"op_...","status":"completed","amount":100,"new_balance":...}  (charged once)
```

If nobody retries, the reconciler completes it on its own after about 30 to 45 seconds (`npm run logs` shows it).

**Provider declines:** `"payment_method":"card_declined"` answers `200 {"status":"failed","failure_reason":"insufficient_funds",...}` with no `new_balance`.

**Five parallel requests with the same key**

```bash
KEY=$(uuidgen)
BODY='{"user_id":"usr_abc123","amount":100.00,"currency":"PEN","payment_method":"card_slow"}'
seq 5 | xargs -P5 -I{} curl -s -X POST localhost:3000/cash-in -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" -d "$BODY"; echo
# one 200 and four 202, all with the same operation_id
docker compose exec -T mongo mongosh --quiet wallet --eval 'printjson(db.simulated_provider_charges.find({}, {calls: 1}).sort({createdAt: -1}).limit(1).toArray())'
# calls: 1  (the provider was called once)
```

**Webhooks.** `scripts/send-webhook.mjs` builds and signs the notification (with the compose demo secret by default; for `npm run start:dev` use `WEBHOOK_SIGNING_SECRET=dev-only-webhook-signing-secret`):

```bash
# 1. create a pending operation (card_timeout above) and take its operation_id
node scripts/send-webhook.mjs op_<uuid> payment.succeeded 100.00 PEN evt_demo_1   # 200 {"result":"applied"}
node scripts/send-webhook.mjs op_<uuid> payment.succeeded 100.00 PEN evt_demo_1   # 200 {"result":"duplicate"}
node scripts/send-webhook.mjs op_<uuid> payment.failed 100.00 PEN                 # 200 {"result":"conflict"} (late, contradicts completed)
# retry the cash-in with its key: 200 completed, balance credited once

curl -i -X POST http://localhost:3000/webhooks/payment -H 'Content-Type: application/json' -d '{}'   # 401 without signature
```

**Trace a request end to end:** add `-H 'x-trace-id: demo-1'` and search `demo-1` in `npm run logs`. Every log line of the flow carries it.

### Configuration

All keys are validated at boot (the app refuses to start with an invalid value). Defaults work with the local containers.

| Key | Default | Purpose |
|---|---|---|
| `PROVIDER_TIMEOUT_MS` | 3000 | budget of one charge submission |
| `PROVIDER_MAX_ATTEMPTS` | 3 | submissions when the provider is unavailable |
| `RETRY_BASE_DELAY_MS`, `RETRY_MAX_DELAY_MS` | 50, 1000 | jittered backoff |
| `OPERATION_LEASE_MS` | 15000 | exclusive right to call the provider (must outlast the provider budget, checked at boot) |
| `SETTLEMENT_MAX_ATTEMPTS` | 5 | settlement retries on a version conflict |
| `WEBHOOK_SIGNING_SECRET` | dev value | HMAC key; the default is rejected when `NODE_ENV=production` |
| `WEBHOOK_TOLERANCE_SECONDS` | 300 | accepted distance between the signed timestamp and now |
| `RECONCILER_ENABLED`, `RECONCILER_INTERVAL_MS` | true, 15000 | the periodic job |
| `RECONCILER_MIN_AGE_MS` | 30000 | a pending operation younger than this is left to its own request, webhook or retry |
| `RECONCILER_BATCH_SIZE`, `RECONCILER_MAX_PROVIDER_CALLS` | 20, 10 | per run, and submissions per operation before manual review |

## Code organization

Organized by bounded context, with Clean Architecture dependency rules enforced by the linter. The engineering rules given to the AI agent are in [CLAUDE.md](CLAUDE.md).

```
src/
  modules/<context>/
    domain/          aggregates, value objects, exceptions, repository ports (framework free)
    application/     commands/ (one handler each), ports
    infrastructure/  Mongo repositories, mappers, adapters, in-memory doubles
    api/             controllers (CommandBus only), request/response DTOs, mappers
  shared/            same layering: kernel (Money, exceptions), ports, adapters (Mongo, logging),
                     HTTP pieces (filter, middleware, decorators)
  config/            validated environment + typed AppConfigService
  modules/health/    readiness as a query over DependencyHealthCheck ports
test/                e2e tests (against docker compose)
k8s/                 Deployment, Service, ConfigMap, Secret example
```

| Layer | May import | Must never import (fails `npm run lint`) |
|---|---|---|
| `domain/` | `shared/domain` | `@nestjs/*`, drivers, validation libs, other layers |
| `application/` | `domain/`, ports, `@nestjs/cqrs` | other `@nestjs/*`, drivers, `express`, `infrastructure/`, `api/` |
| `api/` | `application/`, `shared/api` | drivers, `infrastructure/` |

Business rules live in aggregates; handlers only orchestrate. Ports are `abstract class`es: they survive compilation, so they double as the Nest DI token and consumers inject them by type.

### Money

`Money` stores integer minor units in a `bigint` with an explicit currency (`PEN`, `USD`). Floating point is never used for arithmetic. Operations between different currencies throw.

### Errors

Every error is a `DomainException` subclass with a stable kebab-case `staticCode`. Subclasses inherit the HTTP status of their closest base class, and a single `GenericExceptionFilter` renders every error (domain, validation, framework, unknown) with the same shape:

```json
{
  "statusCode": 400,
  "code": "data-input-exception",
  "errorMessage": "Bad Request",
  "errorMessageDescription": "...",
  "path": "/cash-in",
  "timestamp": "2026-10-06T03:50:55.871Z",
  "traceId": "c6d92a80-..."
}
```

| Base exception | HTTP |
|---|---|
| `DataInputException` (validation included) | 400 |
| `AuthenticationException` | 401 |
| `DataNotFoundException` | 404 |
| `DataConflictException`, `ConcurrencyException` | 409 |
| `BusinessRuleViolationException` | 422 |
| `ServiceException` | 503 |
| `DataSourceException`, `DefaultException`, unknown errors | 500 |

4xx responses expose the exception message (actionable for the client); 5xx responses only carry a generic description, with details in the logs. Each endpoint documents its possible errors in Swagger with `@ApiDomainErrors(...)`, generated from the same mapping.

### Security

- `class-validator` DTOs with `whitelist` and `forbidNonWhitelisted`: unknown fields are rejected.
- Environment validated at boot; the app refuses to start with an invalid config.
- Non root container, read only root filesystem and dropped capabilities in Kubernetes.
- CI security job: gitleaks over the whole history, osv-scanner on `package-lock.json` (blocks on CVSS >= 9) and Semgrep SAST (blocks on ERROR). Also runs weekly so new advisories surface without a commit.

### Observability

- Structured JSON logs through a `LogsService` port, with request start/finish and duration. Nest's internal logs are routed through the same port, so every line shares one schema. Probe endpoints are not logged.
- `x-trace-id` is accepted from the gateway or generated per request, returned in the response, and propagated to commands and every log line.
- Error logs include the full `cause` chain down to the driver error.
- Every response is `Cache-Control: no-store` with ETags disabled: balances and payment states are never served from a cache.
- Fail fast on outages: Mongo server selection times out at 5 s (instead of the driver's 30 s) and each readiness check has an 800 ms budget.
- `/health/live` (process) and `/health/ready` (Mongo; `503` with the failing dependency when down) for Kubernetes probes, not rate limited.
- API docs (Scalar at `/reference`, Swagger UI at `/docs`, OpenAPI at `/docs-json`) are disabled in production unless `SWAGGER_ENABLED=true`.

## Decisions and trade-offs

- **Versioned documents instead of event sourcing.** Completing the operation and crediting the wallet are two aggregates, and an event store has no atomic multi stream append. The reconciler also needs "operations stuck in pending", which an in-process projection can lose on a crash. A Mongo transaction over versioned documents gives the atomic credit directly. Event sourcing would be a reasonable evolution if an audit history of every state change became a requirement.
- **No Redis, no message broker.** The flow needs neither: idempotency and locks live in MongoDB, and there is no consumer for integration events yet.
- **Wallet and ledger inside the cash-in context.** It keeps the credit a single local transaction. The price is that a separate wallet service would need an outbox or a saga.
- **Unknown is not failed.** A timeout or a 5xx after the charge was sent never marks the operation failed, because the charge may have happened.
- **Settle in the request, webhook as confirmation.** The client usually gets the final answer immediately; the webhook and the reconciler exist for the cases where it cannot.
- **Replies are tolerant to the provider.** Late and contradicting notifications are acknowledged and logged as errors instead of rejected, so the provider never retries forever.
- **Rate limiting is per pod.** The counters live in memory, so with several replicas the limit multiplies; a shared storage (Redis) fixes it. The webhook route is exempt.

### Redis or database for idempotency?

For a flow that moves money, the database. The key must be durable and must be in the same consistency domain as the operation it protects: here a unique index and the operation document are the record, and settlement is transactional with it. A Redis key can be evicted, lost on failover or expire while the provider call is still running, and it can disagree with the database (key stored, operation not, or the reverse). Redis fits where a duplicate is cheap and the answer can be rebuilt: a short window deduplication of idempotent reads, a rate limiter, or a cache in front of the database record to answer replays faster. If used, it is an optimization in front of the database check, never the source of truth.

### What changes at 1 million operations a day?

1M a day is about 12 per second on average, perhaps 100 to 200 at peak: well within one replica set, so the first changes are operational rather than architectural.

- **Hot path:** indexes already serve every query (unique key lookup, partial index for pending operations). Add TTL or archival for old terminal operations and notifications, and keep the `pending` partial index small.
- **Reconciler:** move it out of the API pods to a dedicated worker or a Kubernetes CronJob, with a smaller query surface, metrics and alerting on operations that reach the submission cap.
- **Wallet contention:** a user doing many concurrent cash-ins serializes on one wallet document. If that matters, move to an append only ledger with a periodically folded balance, which is where the wallet and ledger become their own service (with an outbox to publish events).
- **Provider:** per provider rate limits and a circuit breaker so a slow provider does not hold every request thread; connection pooling and bulkheads.
- **Observability:** metrics and traces (time to settle, pending age, retries, conflicts, duplicate webhooks), and an alert on conflicting provider outcomes, which signal charged but not credited money.
- **Scale out:** stateless pods behind an autoscaler; MongoDB sharded if one replica set stops being enough. `cash_in_operations` and `wallets` shard by `userId`, which keeps the idempotency index (`userId`, `idempotencyKey`) enforceable. `payment_notifications` and `ledger_entries` deduplicate by `_id` (event id, operation id), and a sharded collection only enforces `_id` uniqueness per shard, so they shard by `_id`. The settlement transaction then spans shards: it still works, at a higher latency, and that is the real cost to measure first.

## What I would do with more time

- **Outbox and integration events** (`cash_in.completed`, `cash_in.failed`) published reliably to a broker, and the split of wallet and ledger into their own service with a saga if the credit stops being local.
- **Authentication:** take the user from the token instead of the body, and make the authenticated principal the idempotency scope.
- **Idempotency record expiry** (TTL index on terminal operations) and archival.
- **A status endpoint** (`GET /cash-in/:operation_id`) so clients can poll instead of retrying the POST.
- **Manual review tooling** for conflicting provider outcomes (charged but not credited), with an alert, instead of only an error log.
- **Reconciler as a Kubernetes CronJob** with metrics, and a provider status lookup if the real provider offers one.
- **Shared rate limiting** (Redis) instead of per pod counters.
- **Production Kubernetes:** HPA, PodDisruptionBudget, network policies, secrets from a secret manager through External Secrets, and a managed MongoDB.
- **Serverless:** `POST /cash-in` and the webhook map to functions behind an API gateway, with the reconciler as a scheduled function; state is already all in MongoDB, so nothing in the design depends on a long lived process.
- **Event sourcing** if a full audit history of every state change becomes a requirement.

## Contributing

- Conventional Commits enforced by commitlint (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`, `style`, `revert`; lowercase subject, no trailing period, 100 chars max).
- Git hooks (husky): `pre-commit` runs a gitleaks scan of staged changes and the linter; `pre-push` runs `npm run check`.
