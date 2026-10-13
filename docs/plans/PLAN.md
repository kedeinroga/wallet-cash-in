# Wallet Cash-In - Plan

Status: APPROVED FOR IMPLEMENTATION

Source: `../challenge-statement.md` (transcription of the PDF, 15 slides). The statement wins over
this plan; `CLAUDE.md` governs how the code is written.

---

## 1. Problem

A digital wallet app tops up a user's wallet by charging an external payment provider. We build the Cash-In
service: `POST /cash-in` charges the provider and credits the wallet; `POST /webhooks/payment`
receives the provider's asynchronous notifications. The hard part is not the happy path but
guaranteeing that **a user is charged at most once and credited exactly once per operation**
under: double click, automatic app retries, several pods receiving the same request, provider
timeouts (charge outcome unknown), duplicated / out of order webhooks, webhooks arriving before
the API answered, temporary DB failures, process restarts mid operation and concurrent credits
to the same balance.

Central question of the statement: *the provider charges S/100, a timeout happens before it
answers, the client retries: how do you avoid charging twice?* Our answer, in one line: the
operation is persisted (unique per user + `Idempotency-Key`) **before** calling the provider, our
operation id is the provider's idempotency key, an unknown outcome leaves the operation `pending`
(never released), and the retry, the webhook or the reconciler resolve it by re-submitting the
same idempotent charge or applying the notification, with a single transactional credit.

Mandatory deliverables (statement slide 8): both endpoints, real multi pod idempotency, operation
state machine, duplicated and out of order webhooks, tests (idempotency, duplicity, success,
provider failure), README with architecture and decisions, and the AI usage section.

## 2. Decisions already taken and assumptions

### Decisions (with the user)

| # | Date | Decision |
|---|---|---|
| D1 | 2026-10-06 | Versioned MongoDB documents + DDD aggregates + `@nestjs/cqrs`. No event sourcing, no Redis, no broker (ai-log #2). |
| D2 | 2026-10-06 | Provider timeout / unknown outcome -> `202 Accepted` with `status: "pending"`. |
| D3 | 2026-10-06 | Credit is synchronous in the request when the provider approves; the webhook is an idempotent confirmation that can also settle the operation if it arrives first or if the API never got the answer. |
| D4 | 2026-10-06 | Exact paths `POST /cash-in` and `POST /webhooks/payment`, no version prefix, no GET endpoints. |
| D5 | 2026-10-06 | Wallet auto created on the first cash-in of a user; demo seed `usr_abc123` with 250.00 PEN. |
| D6 | 2026-10-06 | Provider declines -> `200 OK` with `status: "failed"` and `failure_reason`. A replay returns the same body. |
| D7 | 2026-10-06 | `new_balance` is present **only** when `status` is `completed` (balance right after this credit, stored on the operation). Omitted for `pending` and `failed` (user corrected the agent's proposal of `null`; see section 16). |
| D8 | 2026-10-06 | Same `Idempotency-Key` while the first request is calling the provider -> the others answer `202 pending` without calling the provider (atomic lease in Mongo). |
| D9 | 2026-10-06 | Reconciler included: in process periodic job, each stale pending operation claimed atomically in Mongo so two pods never process the same one. |
| D11 | 2026-10-06 | Reconciler claims pass the ids already handled in the run (`excludedIds`), so an operation whose outcome stays unknown is submitted once per run instead of being re-claimed at once and burning its submission cap (found while implementing step 8, decided with the user; ai-log #9). |
| D10 | 2026-10-06 | New shared base exception `AuthenticationException` (401) for invalid webhook signatures; added to the kernel, the HTTP mapping, `CLAUDE.md` section 8 and the README. |

### Assumptions

| # | Assumption | Why | If wrong |
|---|---|---|---|
| A1 | `user_id` in the body is trusted (no authentication in scope). | Statement has no auth. | Take the user from the token; the idempotency scope becomes the authenticated principal. |
| A2 | One wallet per user, one currency, fixed by the first cash-in. A cash-in in another currency is rejected (422) before charging. | Statement has one currency per example; no FX in scope. | Wallet becomes a set of balances keyed by currency. |
| A3 | Idempotency keys never expire: the operation document is the idempotency record and the audit trail. | Simplest correct option; no TTL edge cases. | TTL index on terminal operations after N days. |
| A4 | JSON numbers cannot keep trailing zeros: `350.00` is serialized as `350`. Same numeric value as the statement contract. | JSON semantics. | Render strings (contract change, not allowed by the statement). |
| A5 | The provider supports idempotency keys (Stripe like): the same key returns the original result and never charges twice. Our `operation_id` is that key. Resolving a pending operation re-submits the charge with the same key instead of calling a status API. | Industry standard; one port method instead of two. | If the provider offers a status lookup, the reconciler uses it; if it has no idempotency at all, the design needs a status lookup before any re-submit. |
| A6 | The webhook contract and signature scheme are ours (Stripe like HMAC), since the statement defines none. | Statement gives only the path. | Adapt the DTO and verifier to the real provider. |
| A7 | A notification's `amount` and `currency` must equal the operation's; otherwise it is rejected (422) and logged as error. | A mismatch means a provider bug or forgery. | Accept and flag for review. |
| A8 | Max amount per operation 1,000,000.00 (input sanity limit, not a business rule). | DTOs need explicit limits (`CLAUDE.md` section 7). | Change the constant. |
| A9 | Provider "unavailable" (connection refused / 5xx) is an **unknown** outcome, never "failed": a 5xx may come after the charge was processed. | Rule 5.3. | None: this is the safe side. |
| A10 | Webhooks use the global `ValidationPipe` (`forbidNonWhitelisted`): unknown fields in a notification are a 400. | Global rule; our own simulated contract. | Per route pipe with `whitelist` only, for a real provider that adds fields. |

## 3. Out of scope

- GET endpoints (operation status, balance, history). The client polls by retrying with the same key.
- Authentication and authorization of the app (A1). Shared rate limiting (per pod, documented).
- Refunds, chargebacks, reversals, partial captures, multi currency wallets, FX.
- A real HTTP provider integration: the provider is a simulated adapter behind the port.
- Wallet / ledger as a separate service, outbox, integration events, sagas (README "with more time").
- Manual review tooling for conflicting notifications (they are logged as `error`).
- Idempotency record expiry (A3). Snapshots, event sourcing (D1).

## 4. Ubiquitous language

| Term | Meaning |
|---|---|
| Cash-in operation | One top up attempt identified by `operation_id`, unique per (`user_id`, `Idempotency-Key`). Aggregate `CashInOperation`. |
| Idempotency key | Client generated UUID (header). Same key + same user = same operation, forever. |
| Request fingerprint | The (`amount`, `currency`, `payment_method`) of the original request; a replay must match it. |
| Charge | The provider debiting the user's payment method. Submitted with our `operation_id` as the provider idempotency key. |
| Provider outcome | Result of a charge submission: `approved` (with `providerChargeId`), `declined` (with reason) or `unknown` (timeout, unavailable). |
| Payment notification | A webhook from the provider about an operation: `payment.processing`, `payment.succeeded`, `payment.failed`. Identified by the provider `event_id`. |
| Settle | Apply a known provider outcome to the operation: complete (and credit) or fail. |
| Credit | Increase of the wallet balance by the operation amount, recorded as one ledger entry. |
| Ledger entry | Immutable record of one credit, unique by `operation_id`. |
| Wallet | The user's balance in one currency. Aggregate `Wallet`. |
| Lease | Time bounded, exclusive right of one process to call the provider for a pending operation (`leaseUntil` in Mongo). Not domain state. |
| Reconciler | Periodic job that claims stale pending operations and resolves them with the provider. |
| Transition result | What applying a trigger to an operation did: `applied`, `ignored` (already in that terminal state, or no-op) or `conflict` (contradicts the terminal state). |

## 5. Domain model

Module: `src/modules/cash-in/` (one bounded context; wallet and ledger live in it so the credit
is one local transaction. README explains the split into a wallet service as an evolution).

### 5.1 `CashInOperation` aggregate (`domain/cash-in-operation.aggregate.ts`)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | `op_<randomUUID()>`, generated by the application. |
| `userId` | `string` | |
| `idempotencyKey` | `string` | Lowercased UUID. |
| `amount` | `Money` | |
| `paymentMethod` | `string` | |
| `status` | `CashInStatus` | `'pending' \| 'completed' \| 'failed'` (`domain/cash-in-status.ts`, `CASH_IN_STATUSES` const + type). |
| `providerChargeId` | `string \| null` | Set on completion. |
| `failureReason` | `string \| null` | Set on failure. |
| `balanceAfter` | `Money \| null` | Wallet balance right after this credit; set on completion only (D7). |
| `createdAt`, `updatedAt` | `Date` | |
| `version` | `number` | Optimistic concurrency; incremented by the persistence adapter only. |

Methods (all return types explicit):

- `static initiate(props: { id; userId; idempotencyKey; amount: Money; paymentMethod }): CashInOperation`
  -> status `pending`, version `0`, nulls, dates `new Date()`. Validates O1, O2.
- `static rehydrate(props: CashInOperationProps): CashInOperation` (no validation).
- `assertSameRequest(amount: Money, paymentMethod: string): void` -> O3.
- `assertNotificationAmount(amount: Money): void` -> O6.
- `markCompleted(providerChargeId: string, wallet: Wallet): CompletionResult` where
  `CompletionResult = { result: 'applied'; ledgerEntry: LedgerEntry } | { result: 'ignored' | 'conflict' }`.
  `pending`: calls `wallet.credit(this.amount, this.id)` (W1, W2 apply), sets `completed`,
  `providerChargeId`, `balanceAfter = ledgerEntry.balanceAfter`, `updatedAt`; returns `applied`.
  `completed`: returns `ignored`, wallet untouched. `failed`: returns `conflict`, wallet untouched.
- `markFailed(reason: string): TransitionResult` -> `pending`: sets `failed`, `failureReason`,
  `updatedAt`, returns `applied`. `failed`: `ignored`. `completed`: `conflict`.
- `isFinal(): boolean` (`completed` or `failed`). Getters for every field.

`TransitionResult = 'applied' | 'ignored' | 'conflict'` in `domain/transition-result.ts`.

| Inv. | Rule | Broken by | Exception (file `cash-in-operation.exceptions.ts`) | Base | HTTP |
|---|---|---|---|---|---|
| O1 | Amount strictly positive | `initiate` | `InvalidCashInAmountException` (`invalid-cash-in-amount-exception`) | `DataInputException` | 400 |
| O2 | Payment method non empty, max 64 chars | `initiate` | `InvalidPaymentMethodException` (`invalid-payment-method-exception`) | `DataInputException` | 400 |
| O3 | A replay of a key carries the same amount, currency and payment method | `assertSameRequest` | `IdempotencyKeyReusedException` (`idempotency-key-reused-exception`), message names the operation id | `BusinessRuleViolationException` | 422 |
| O4 | Terminal states are absorbing; credit only on `pending -> completed` | `markCompleted`, `markFailed` | none: returns `ignored` / `conflict` (statement requires tolerance) | | |
| O5 | Exactly one credit per operation | `markCompleted` (once) + unique ledger `_id` | `LedgerEntryAlreadyRecordedException` (`ledger-entry-already-recorded-exception`), raised by the adapter, defensive | `DataConflictException` | 409 |
| O6 | Notification amount and currency equal the operation's | `assertNotificationAmount` | `PaymentNotificationMismatchException` (`payment-notification-mismatch-exception`) (file `payment-notification.exceptions.ts`) | `BusinessRuleViolationException` | 422 |

Other exceptions of the operation (same file `cash-in-operation.exceptions.ts`):

| Exception | staticCode | Base | HTTP | Raised by |
|---|---|---|---|---|
| `InvalidIdempotencyKeyException` | `invalid-idempotency-key-exception` | `DataInputException` | 400 | `@IdempotencyKey()` decorator: header missing or not a UUID |
| `CashInOperationNotFoundException` | `cash-in-operation-not-found-exception` | `DataNotFoundException` | 404 | notification for an unknown operation |
| `DuplicateCashInOperationException` | `duplicate-cash-in-operation-exception` | `DataConflictException` | 409 | Mongo repo on unique (`userId`, `idempotencyKey`) violation. Always caught by the initiate handler (replay path); never reaches HTTP |
| `CashInOperationConcurrentlyModifiedException` | `cash-in-operation-concurrently-modified-exception` | `ConcurrencyException` | 409 | Unit of work: version mismatch on the operation, or a Mongo `TransientTransactionError` (write conflict) |

### 5.2 `Wallet` aggregate (`domain/wallet.aggregate.ts`)

| Field | Type | Notes |
|---|---|---|
| `userId` | `string` | Also the identity (`_id`). |
| `balance` | `Money` | Its currency is the wallet currency (A2). |
| `createdAt`, `updatedAt` | `Date` | |
| `version` | `number` | |

- `static open(userId: string, currency: Currency): Wallet` -> balance `Money.zero(currency)`, version 0.
- `static rehydrate(props)`.
- `assertCanBeCredited(amount: Money): void` -> W1, W2 (used before charging, fail fast).
- `credit(amount: Money, operationId: string): LedgerEntry` -> asserts W1, W2, `balance = balance.add(amount)`,
  `updatedAt`, returns `LedgerEntry.record({ operationId, userId, amount, balanceAfter: balance })`.

| Inv. | Rule | Broken by | Exception (`wallet.exceptions.ts`) | Base | HTTP |
|---|---|---|---|---|---|
| W1 | Credited currency equals the wallet currency | `assertCanBeCredited`, `credit` | `WalletCurrencyMismatchException` (`wallet-currency-mismatch-exception`) | `BusinessRuleViolationException` | 422 |
| W2 | Credited amount strictly positive | same | `InvalidCreditAmountException` (`invalid-credit-amount-exception`) | `DataInputException` | 400 |
| W3 | Balance never negative | holds by construction (only positive credits) | none | | |

Other wallet exceptions: `WalletNotFoundException` (`wallet-not-found-exception`, `DataNotFoundException`, 404;
defensive, a settled operation always has a wallet since it is created before the operation),
`WalletConcurrentlyModifiedException` (`wallet-concurrently-modified-exception`, `ConcurrencyException`, 409).

### 5.3 Value objects

- `LedgerEntry` (`domain/ledger-entry.ts`): `operationId`, `userId`, `amount: Money`, `balanceAfter: Money`,
  `createdAt`. Private constructor, `static record(...)`.
- `PaymentNotification` (`domain/payment-notification.ts`): `notificationId` (provider `event_id`),
  `operationId`, `type: PaymentNotificationType`, `result: TransitionResult`, `receivedAt`.
  `PAYMENT_NOTIFICATION_TYPES = ['payment.processing', 'payment.succeeded', 'payment.failed'] as const`.
  `static record(...)`.
- `payment-notification.exceptions.ts`: `PaymentNotificationMismatchException` (O6),
  `DuplicatePaymentNotificationException` (`duplicate-payment-notification-exception`, `DataConflictException`, 409;
  raised by the unit of work on unique `_id` violation, caught by the notification handler -> `duplicate`),
  `InvalidWebhookSignatureException` (`invalid-webhook-signature-exception`, `AuthenticationException`, 401).

### 5.4 Repository ports (domain, `abstract class`, JSDoc on each method)

`domain/cash-in-operation.repository.ts` -> `CashInOperationRepository`:

| Method | Semantics |
|---|---|
| `insertClaimed(operation: CashInOperation, leaseMs: number): Promise<void>` | Inserts with `leaseUntil = now + leaseMs`, `providerCallCount = 1`. Unique violation on (`userId`, `idempotencyKey`) -> `DuplicateCashInOperationException`. |
| `findById(id: string): Promise<CashInOperation \| null>` | |
| `findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<CashInOperation \| null>` | |
| `claim(id: string, leaseMs: number): Promise<CashInOperation \| null>` | Atomic `findOneAndUpdate({ _id, status: 'pending', $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { $set: { leaseUntil: now + leaseMs }, $inc: { providerCallCount: 1 } }, { returnDocument: 'after' })`. `null` = someone else holds it or it is final. Does **not** change `version`. |
| `claimNextStale(createdBefore: Date, maxProviderCalls: number, leaseMs: number, excludedIds: readonly string[]): Promise<CashInOperation \| null>` | Same atomic claim, filter adds `_id $nin excludedIds`, `createdAt < createdBefore` and `providerCallCount < maxProviderCalls`, sort `{ createdAt: 1 }`. `excludedIds` are the operations already handled in this run (D11). |
| `releaseLease(id: string): Promise<void>` | `updateOne({ _id, status: 'pending' }, { $set: { leaseUntil: null } })`. Called when the provider call finished with an unknown outcome, so an immediate client retry can re-submit. |

`domain/wallet.repository.ts` -> `WalletRepository`:

| Method | Semantics |
|---|---|
| `findByUserId(userId: string): Promise<Wallet \| null>` | |
| `insertIfAbsent(wallet: Wallet): Promise<Wallet>` | `updateOne({ _id }, { $setOnInsert: doc }, { upsert: true })` then `findOne`; a concurrent upsert raising 11000 is followed by `findOne`. Returns the persisted wallet (existing or new). |

Wallet balance and operation state are written only through the unit of work (section 7).

The lease is an **efficiency** guard, not the money guarantee: `leaseUntil` is computed from the
pod clock (`new Date()`), so clock skew or a provider call that outlives the lease can let a second
process submit the same operation. That is still safe: the provider deduplicates by our operation
id (A5) and settlement is conditional on `pending` + version with a unique ledger `_id`. The
README states this explicitly (defense question "5 pods").

## 6. Operation state machine

States: `pending` (initial), `completed` (terminal), `failed` (terminal).

Triggers: `approved` (provider answer to a charge submission: initial call, client retry,
reconciler), `declined` (same sources), `unknown` (timeout / unavailable), and notifications
`payment.succeeded`, `payment.failed`, `payment.processing`.

| From | Trigger | To | Effect | Result |
|---|---|---|---|---|
| pending | approved / `payment.succeeded` | completed | credit wallet + ledger entry, store `providerChargeId`, `balanceAfter` (one transaction) | applied |
| pending | declined / `payment.failed` | failed | store `failureReason` | applied |
| pending | unknown | pending | release lease; log `warn` | (no transition) |
| pending | `payment.processing` | pending | notification recorded | ignored |
| completed | approved / `payment.succeeded` | completed | none (duplicate confirmation); log `info` | ignored |
| completed | declined / `payment.failed` | completed | none; log `error` "conflicting provider outcome" | conflict |
| completed | `payment.processing` | completed | none (late, out of order) | ignored |
| completed | unknown | completed | happens when a webhook settled the operation during the provider call: `releaseLease` is a no-op (filters `status: 'pending'`); the response is built from the in-request snapshot (202 pending); the next retry replays the final result | (no transition) |
| failed | approved / `payment.succeeded` | failed | none; log `error` "conflicting provider outcome" (charged but not credited: manual review) | conflict |
| failed | declined / `payment.failed` | failed | none | ignored |
| failed | `payment.processing` | failed | none | ignored |
| failed | unknown | failed | same as `completed` + unknown | (no transition) |

Not allowed transitions are **ignored**, never rejected with an error: rule 5.6 and the statement
(duplicated, out of order, late notifications) require tolerance; a rejection would make the
provider retry forever. `conflict` is still acknowledged (200) and surfaced as an `error` log.

## 7. Persistence model

`MongoClient` gets `useBigInt64: true` (`src/shared/infrastructure/mongo/mongo.module.ts:14`) so
int64 fields round trip as `bigint` (minor units); counters and versions stay int32 numbers.

### `cash_in_operations`

| Field | Type |
|---|---|
| `_id` | string (`op_<uuid>`) |
| `userId`, `idempotencyKey`, `paymentMethod`, `currency` | string |
| `amountMinor` | int64 |
| `status` | `'pending' \| 'completed' \| 'failed'` |
| `providerChargeId`, `failureReason` | string \| null |
| `balanceAfterMinor` | int64 \| null |
| `leaseUntil` | Date \| null (persistence only) |
| `providerCallCount` | int32 (persistence only) |
| `version` | int32 |
| `createdAt`, `updatedAt` | Date |

Indexes (created in `MongoCashInOperationRepository.onModuleInit`):
- `uniq_user_idempotency_key`: `{ userId: 1, idempotencyKey: 1 }` **unique**. Protects: one operation per key per user across all pods (the idempotency guarantee).
- `pending_by_age`: `{ status: 1, createdAt: 1 }`, `partialFilterExpression: { status: 'pending' }`. Serves the reconciler.

### `wallets`

`_id` (userId), `currency`, `balanceMinor` int64, `version` int32, `createdAt`, `updatedAt`. Unique by `_id`.

### `ledger_entries`

`_id` (operationId, **unique by construction**: credit exactly once), `userId`, `amountMinor`,
`currency`, `balanceAfterMinor`, `createdAt`.

### `payment_notifications`

`_id` (provider `event_id`, **unique**: deduplication), `operationId`, `type`, `result`
(`applied | ignored | conflict`), `receivedAt`.

### `simulated_provider_charges` (the simulated provider's own storage, not ours)

`_id` (provider idempotency key = our operation id), `outcome` (`approved | declined`),
`providerChargeId` string | null, `declineReason` string | null, `amountMinor`, `currency`,
`calls` int32 (`$inc` on every submission; lets tests prove "the provider was called once"),
`createdAt`. Stored in Mongo, not in a `Map`, so several pods see one provider.

### Transactions and optimistic concurrency

Port `CashInUnitOfWork` (`application/ports/cash-in-unit-of-work.port.ts`):

```ts
export interface CashInChanges {
  readonly operation?: CashInOperation;     // updated with version check
  readonly wallet?: Wallet;                 // updated with version check
  readonly ledgerEntry?: LedgerEntry;       // inserted
  readonly notification?: PaymentNotification; // inserted
}
export abstract class CashInUnitOfWork {
  /** Persists every change atomically (one Mongo transaction) or none. */
  abstract commit(changes: CashInChanges, traceId: string): Promise<void>;
}
```

`MongoCashInUnitOfWork.commit` (manual `startSession` / `startTransaction` with
`writeConcern: { w: 'majority' }`, `readConcern: { level: 'snapshot' }`; **not**
`session.withTransaction`, whose internal retry loop runs up to 120 s): in this order
1. `notification` -> `insertOne`; 11000 -> `DuplicatePaymentNotificationException`.
2. `operation` -> `updateOne({ _id, version: expected }, { $set: { status, providerChargeId, failureReason, balanceAfterMinor, updatedAt }, $inc: { version: 1 } })`;
   `matchedCount === 0` -> `CashInOperationConcurrentlyModifiedException`. The `$set` lists **only** these
   fields: `leaseUntil` and `providerCallCount` are never overwritten from a stale aggregate.
3. `wallet` -> `updateOne({ _id, version: expected }, { $set: { balanceMinor, updatedAt }, $inc: { version: 1 } })`;
   0 matched -> `WalletConcurrentlyModifiedException`.
4. `ledgerEntry` -> `insertOne`; 11000 -> `LedgerEntryAlreadyRecordedException`.
5. `commitTransaction`.

Errors: `abortTransaction` (if active), then: `DomainException` rethrown as is; Mongo error with
label `TransientTransactionError` (write conflict between two transactions) ->
`CashInOperationConcurrentlyModifiedException` with `cause`; anything else ->
`DataSourceException('Cash-in transaction failed', { cause })`. `endSession` in `finally`.

The three money writes (operation completed, wallet balance, ledger entry) plus the notification
record are **one transaction**. Failing an operation writes the operation (and notification) only.

## 8. External provider

Port `application/ports/payment-provider.port.ts`:

```ts
export interface ChargeRequest {
  readonly operationId: string;   // sent as the provider idempotency key
  readonly userId: string;
  readonly amount: Money;
  readonly paymentMethod: string;
}
export type ChargeOutcome =
  | { readonly kind: 'approved'; readonly providerChargeId: string }
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly cause: string };   // 'timeout' | 'unavailable' | 'error'
export abstract class PaymentProvider {
  /** Submits a charge. Idempotent by operationId. Never throws: failures are `unknown`. */
  abstract charge(request: ChargeRequest, traceId: string): Promise<ChargeOutcome>;
}
```

Adapter `infrastructure/simulated-payment-provider.ts` (`SimulatedPaymentProvider extends PaymentProvider`):
- Each attempt: `withTimeout(backend.submit(request), config.providerTimeoutMs)`.
- `TimeoutExceededError` -> `unknown` (`cause: 'timeout'`), **no in-request retry** (latency budget spent).
- `ProviderUnavailableError` -> retried with `retryWithBackoff` (section 12), at most
  `PROVIDER_MAX_ATTEMPTS` total; exhausted -> `unknown` (`cause: 'unavailable'`).
- Any other error -> `unknown` (`cause: 'error'`), logged `error`.
- Logs `info` 'Provider charge submitted' / 'Provider charge outcome' with `{ traceId, operationId, attempt, outcome }`.

Backend `infrastructure/simulated-provider/simulated-provider.backend.ts` (`SimulatedProviderBackend`,
the provider's side, `@Injectable`, uses `MONGO_DB`): `submit(request): Promise<ProviderAnswer>`:
1. `paymentMethod === 'card_unavailable'` -> throws `ProviderUnavailableError` (nothing recorded).
2. `findOneAndUpdate({ _id: operationId }, { $inc: { calls: 1 }, $setOnInsert: { outcome, providerChargeId: 'ch_<uuid>' | null, declineReason, amountMinor, currency, createdAt } }, { upsert: true, returnDocument: 'before' })`;
   11000 on concurrent upsert -> retry the same statement once. `before === null` means first submission.
3. Behaviors by `paymentMethod` (deterministic test cards):

| `payment_method` | Outcome | Delay |
|---|---|---|
| `card_declined` | declined, reason `insufficient_funds` | none |
| `card_timeout` | approved | first submission: `providerTimeoutMs * 2` (the caller times out after the charge is recorded); later submissions: none |
| `card_slow` | approved | every submission: `providerTimeoutMs / 2` (in flight long enough for concurrent duplicates and early webhooks) |
| `card_unavailable` | throws `ProviderUnavailableError` | none |
| anything else | approved | none |

4. Returns the stored outcome (same `providerChargeId` on every submission of the same key).

`ProviderUnavailableError` lives in the backend file (infrastructure only).

Timeout: `PROVIDER_TIMEOUT_MS` (default 3000) through `AppConfigService.providerTimeoutMs`.

## 9. API contract

### 9.1 `POST /cash-in`

Headers: `Content-Type: application/json`; `Idempotency-Key` **required**, UUID (any version),
lowercased before use; optional `x-trace-id` (echoed back).

Request DTO `api/dto/cash-in.request.dto.ts` (`CashInRequestDto`):

| Field | Type | Validation |
|---|---|---|
| `user_id` | string | `@IsString() @MaxLength(64) @Matches(/^usr_[A-Za-z0-9_-]{1,60}$/)` example `usr_abc123` |
| `amount` | number | `@IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }) @IsPositive() @Max(MAX_CASH_IN_AMOUNT)` (`MAX_CASH_IN_AMOUNT = 1_000_000`, in the DTO file) example `100.00` |
| `currency` | string | `@IsIn(CURRENCIES)` example `PEN` |
| `payment_method` | string | `@IsString() @Matches(/^[A-Za-z0-9_-]{1,64}$/)` example `card_xyz` |

Controller converts `amount` with `String(dto.amount)` (shortest round trip decimal, e.g. `100`,
`10.05`) into the command; the handler builds `Money.of(amount, currency)`. Never `* 100`.

Response DTO `api/dto/cash-in.response.dto.ts` (`CashInResponseDto`), built by
`api/mappers/cash-in.response.mapper.ts` (`Number(money.toDecimalString())`):

| Field | Type | Present when |
|---|---|---|
| `operation_id` | string | always |
| `status` | `'completed' \| 'pending' \| 'failed'` | always |
| `amount` | number | always |
| `new_balance` | number | only `completed` (D7) |
| `failure_reason` | string | only `failed` |

Responses:

| Case | Status | Body |
|---|---|---|
| New or replayed, completed | 200 | `{ "operation_id": "op_…", "status": "completed", "amount": 100, "new_balance": 350 }` |
| New or replayed, declined | 200 | `{ "operation_id": "op_…", "status": "failed", "amount": 100, "failure_reason": "insufficient_funds" }` |
| Provider outcome unknown, or same key in flight, or settlement could not be persisted after an approval | 202 | `{ "operation_id": "op_…", "status": "pending", "amount": 100 }` |

Errors (`ErrorResponseDto`):

| Case | Status | `code` |
|---|---|---|
| Header missing or not a UUID | 400 | `invalid-idempotency-key-exception` |
| Body invalid (types, decimals, limits, unknown fields) | 400 | `data-input-exception` |
| Same key, different amount / currency / payment method | 422 | `idempotency-key-reused-exception` |
| Currency differs from the wallet's | 422 | `wallet-currency-mismatch-exception` |
| Rate limit (per pod) | 429 | `http-429` |
| DB unavailable before this request called the provider (wallet, insert, lookup or claim) | 500 | `data-source-exception` |

After the provider was called, every failure becomes 202 pending (section 10, `chargeAndSettle`).

Swagger block: `@ApiOperation({ summary: 'Top up a wallet through the payment provider', operationId: 'cashIn' })`,
`@ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })`,
`@ApiOkResponse({ type: CashInResponseDto, description: 'completed or failed' })`,
`@ApiAcceptedResponse({ type: CashInResponseDto, description: 'pending: retry with the same Idempotency-Key' })`,
`@ApiDomainErrors(InvalidIdempotencyKeyException, DataInputException, IdempotencyKeyReusedException, WalletCurrencyMismatchException, DataSourceException)`,
`@HttpCode(HttpStatus.OK)`, `@Post('cash-in')`. Handler signature:
`cashIn(@TraceId() traceId, @IdempotencyKey() idempotencyKey, @Body() body, @Res({ passthrough: true }) res)`;
sets `res.status(HttpStatus.ACCEPTED)` when `status === 'pending'` (same pattern as
`health.controller.ts:44`).

Example:

```bash
curl -i -X POST http://localhost:3000/cash-in \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"user_id":"usr_abc123","amount":100.00,"currency":"PEN","payment_method":"card_xyz"}'
```

### 9.2 `POST /webhooks/payment`

Headers: `x-provider-signature: t=<unix seconds>,v1=<hex>` where
`v1 = HMAC_SHA256(WEBHOOK_SIGNING_SECRET, "<t>.<raw body>")`. Verified on the **raw** body
(`NestFactory.create(AppModule, { bufferLogs: true, rawBody: true })`, `req.rawBody`), constant time
comparison (`timingSafeEqual`), `|now - t| <= WEBHOOK_TOLERANCE_SECONDS` (default 300). Checked
by `WebhookSignatureGuard` (guards run before pipes: an unsigned body never reaches validation).
`@SkipThrottle()`: the provider must never be rate limited.

Request DTO `api/dto/payment-webhook.request.dto.ts` (`PaymentWebhookRequestDto`):

| Field | Type | Validation |
|---|---|---|
| `event_id` | string | `@Matches(/^[A-Za-z0-9_-]{1,100}$/)` example `evt_123` |
| `type` | string | `@IsIn(PAYMENT_NOTIFICATION_TYPES)` |
| `operation_id` | string | `@Matches(/^op_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)` |
| `provider_charge_id` | string | `@ValidateIf(type === 'payment.succeeded') @IsString() @MaxLength(100)`; otherwise `@IsOptional()` |
| `amount` | number | same as cash-in |
| `currency` | string | `@IsIn(CURRENCIES)` |
| `failure_reason` | string | `@ValidateIf(type === 'payment.failed') @IsString() @MaxLength(200)`; otherwise `@IsOptional()` |

Deduplication key: `event_id` (`payment_notifications._id`).

Response DTO `api/dto/payment-webhook.response.dto.ts`: `{ "result": "applied" | "ignored" | "conflict" | "duplicate" }`, always 200 on acknowledgement.

| Case | Status | Body / code |
|---|---|---|
| Applied / ignored / conflict / duplicate | 200 | `{ "result": … }` |
| Signature missing, malformed, wrong, or outside tolerance | 401 | `invalid-webhook-signature-exception` |
| Invalid payload | 400 | `data-input-exception` |
| Unknown operation | 404 | `cash-in-operation-not-found-exception` (not recorded: a retry is processed again) |
| Amount / currency mismatch | 422 | `payment-notification-mismatch-exception` (not recorded, `error` log) |
| Settlement still conflicting after the bounded retries | 409 | `cash-in-operation-concurrently-modified-exception` / `wallet-concurrently-modified-exception` (provider retries later) |
| DB failure | 500 | `data-source-exception` (provider retries later) |
| Defensive, unreachable by construction (wallet created before the operation; version check runs before the ledger insert) | 404 / 409 | `wallet-not-found-exception` / `ledger-entry-already-recorded-exception` |

Swagger: `@ApiOperation({ summary: 'Receive a payment provider notification', operationId: 'paymentWebhook' })`,
`@ApiHeader({ name: 'x-provider-signature', required: true })`, `@ApiOkResponse({ type: PaymentWebhookResponseDto })`,
`@ApiDomainErrors(InvalidWebhookSignatureException, DataInputException, CashInOperationNotFoundException, WalletNotFoundException, PaymentNotificationMismatchException, CashInOperationConcurrentlyModifiedException, WalletConcurrentlyModifiedException, LedgerEntryAlreadyRecordedException, DataSourceException)`,
`@HttpCode(HttpStatus.OK)`, `@UseGuards(WebhookSignatureGuard)`, `@Post('webhooks/payment')`.

Example (signature produced by `scripts/send-webhook.mjs`, section 14 step 8):

```bash
node scripts/send-webhook.mjs op_<uuid> payment.succeeded 100.00 PEN
```

## 10. Flows

Shared orchestration lives in `application/cash-in-processor.ts` (`CashInProcessor`, plain class
wired with `useFactory`), used by the three handlers. Constructor, in this order:
`(operations: CashInOperationRepository, wallets: WalletRepository, unitOfWork: CashInUnitOfWork,
provider: PaymentProvider, settings: CashInSettings, logger: LogsService)`.

- `chargeAndSettle(operation, traceId): Promise<CashInOperation>`: caller already holds the lease.
  `provider.charge({ operationId: operation.id, … }, traceId)`, then by outcome:
  `approved` -> `settleApproved`; `declined` -> `settleDeclined`; `unknown` -> try `releaseLease`
  (its failure is logged `error` and swallowed: the lease expires on its own), log `warn`, return
  `operation` (pending -> 202).
  If `settleApproved` / `settleDeclined` throws **any** error (retries exhausted, data source,
  or a defensive not found / ledger conflict): log `error` with the cause (the provider outcome is
  known but not persisted), try `releaseLease` (failure logged and swallowed), return `operation`
  (pending -> 202). Rule: once the provider has been called, `POST /cash-in` never answers 4xx/5xx;
  the client keeps retrying with the same key.
- `settleApproved(operationId, providerChargeId, context): Promise<Settlement>` and
  `settleDeclined(operationId, reason, context): Promise<Settlement>` where
  `context = { traceId; notification?: { notificationId; type } }` and
  `Settlement = { operation: CashInOperation; result: TransitionResult }`. Each attempt, inside
  `retryWithBackoff(…, settlementRetryPolicy, isConcurrencyException)`: reload operation
  (`findById`, missing -> `CashInOperationNotFoundException`) and wallet (`findByUserId`, missing ->
  `WalletNotFoundException`, approved only), apply `markCompleted` / `markFailed`, then
  `unitOfWork.commit({ operation and wallet and ledgerEntry only if applied, notification if present })`.
  Log `info` 'Cash-in completed' `{ operationId, userId, amount, balanceAfter }` / 'Cash-in failed', `error` on `conflict`.
  Why 5 attempts suffice for 5 concurrent credits of one wallet: a `ConcurrencyException` on the
  wallet means another settlement committed (version moved) or holds the write (it commits next),
  so each round at least one settlement lands; N concurrent settlements need at most N attempts.

Result types (`application/cash-in.results.ts`):

```ts
export interface CashInResult {
  readonly operationId: string;
  readonly status: CashInStatus;
  readonly amount: Money;
  readonly newBalance: Money | null;      // operation.balanceAfter (non null only when completed)
  readonly failureReason: string | null;
}
export type PaymentNotificationOutcome = TransitionResult | 'duplicate';
export interface PaymentNotificationResult { readonly result: PaymentNotificationOutcome; }
export interface ReconciliationResult {
  readonly claimed: number; readonly completed: number; readonly failed: number; readonly stillPending: number;
}
```

`CashInResult` is built from the operation by `toCashInResult(operation)` in the same file.

### 10.1 Cash-in (`InitiateCashInHandler`)

1. `amount = Money.of(cmd.amount, cmd.currency)`.
2. `existing = operations.findByIdempotencyKey(userId, key)`; found -> **replay** (10.2).
3. `wallet = wallets.findByUserId(userId) ?? wallets.insertIfAbsent(Wallet.open(userId, amount.currency))`.
   *Dies here*: at most an empty wallet exists; retry is new.
4. `wallet.assertCanBeCredited(amount)` (422 before any charge).
5. `operation = CashInOperation.initiate({ id: 'op_' + randomUUID(), … })`;
   `operations.insertClaimed(operation, settings.leaseMs)`. `DuplicateCashInOperationException` ->
   reload by key -> **replay**. `DataSourceException` -> propagates (500, nothing charged).
   Log `info` 'Cash-in initiated'. *Dies here*: operation `pending` with a lease; after the lease
   expires a retry (10.2) or the reconciler (10.5) submits the charge.
6. `processor.chargeAndSettle(operation, traceId)`. *Dies after the provider charged, before
   settling*: same as 5; the re-submission returns the recorded `approved` (no second charge) and
   settles. *Dies inside the transaction*: not committed, same as 5. *After commit*: `completed`; retries replay.
7. Map to `CashInResult`.

Outcomes: approved -> 200 completed; declined -> 200 failed; timeout / unavailable -> 202 pending.

### 10.2 Replay (same user and key)

1. `existing.assertSameRequest(amount, paymentMethod)` -> 422 if different.
2. Final -> return its stored result (log `info` 'Cash-in replayed'). Same body as the original.
3. Pending -> `operations.claim(id, leaseMs)`: `null` (another request holds the lease) -> 202
   pending, no provider call; claimed -> `processor.chargeAndSettle` (re-submission with the same
   key, safe by A5).

### 10.3 Concurrent duplicates (double click, app retry, 5 pods)

Five pods, same key, same instant: all miss step 2; one `insertClaimed` wins the unique index,
four get `DuplicateCashInOperationException` -> replay -> `claim` returns `null` (lease held) ->
202 pending. Exactly one provider call. If a loser arrives after the winner finished, it gets the
final result (200).

### 10.4 Notification (`HandlePaymentNotificationHandler`)

1. Guard verified the signature (401 otherwise).
2. `operation = operations.findById(operationId)` -> `null` -> 404 (not recorded).
3. `operation.assertNotificationAmount(Money.of(amount, currency))` -> 422 (not recorded; `error` log).
4. By `type`: `payment.succeeded` -> `processor.settleApproved(id, providerChargeId, { traceId, notification })`;
   `payment.failed` -> `processor.settleDeclined(id, failureReason, …)`;
   `payment.processing` -> `unitOfWork.commit({ notification: PaymentNotification.record(…, 'ignored') })`.
5. `DuplicatePaymentNotificationException` -> result `duplicate` (log `info`). Otherwise the transition result.

Cases: **new** -> applied. **Duplicate** -> unique `_id` aborts the transaction -> `duplicate`.
**Out of order** (`processing` after `succeeded`, `failed` after `succeeded`) -> `ignored` / `conflict`,
state unchanged. **Before the API response**: the operation exists (inserted before calling the
provider) and is `pending`; the notification completes it and credits; when the provider answer
reaches the API, `settleApproved` reloads, `markCompleted` returns `ignored`, and the API answers
200 with the stored `balanceAfter`. If both commit concurrently, the second fails the version check
or a write conflict, retries, sees `completed`: one credit (plus the unique ledger `_id`).
*Dies before commit*: nothing recorded, provider retries. *After commit, before responding*:
provider retries -> `duplicate`.

### 10.5 Reconciliation (`ReconcilePendingOperationsHandler`)

`ReconciliationScheduler` (infrastructure, `OnApplicationBootstrap` / `OnApplicationShutdown`): if
`RECONCILER_ENABLED`, `setInterval(RECONCILER_INTERVAL_MS)` (timer `unref()`), skips a tick while the
previous one runs, dispatches `ReconcilePendingOperationsCommand(randomUUID())` through `CommandBus`,
logs errors. The skip flag is only a load guard; exclusivity comes from the Mongo claim.

Handler: up to `RECONCILER_BATCH_SIZE` times: `op = operations.claimNextStale(now - RECONCILER_MIN_AGE_MS, RECONCILER_MAX_PROVIDER_CALLS, leaseMs, handledIds)` (D11);
`null` -> stop; else `processor.chargeAndSettle(op, traceId)` inside try/catch (one failing operation
never stops the batch; logged `error`). Returns `{ claimed, completed, failed, stillPending }`, logged `info`.
Operations that reached `RECONCILER_MAX_PROVIDER_CALLS` stay pending and are no longer selected
(manual review; documented). *Dies after claiming*: the lease expires and a later run reclaims.

## 11. Scenario matrix

| # | Statement scenario | Mechanism | Tests |
|---|---|---|---|
| 1 | Double click | unique (`userId`, `idempotencyKey`) + lease | e2e `charges once when 5 requests share a key`; unit `answers pending without calling the provider when the key is in flight` |
| 2 | App automatic retry | replay of final result; re-submission of pending with the same provider key | unit `replays a completed operation without calling the provider`, `re-submits a pending operation with the same operation id when the lease is free`; e2e `returns the same body on a retry with the same key` |
| 3 | Multiple concurrent pods | all state in Mongo (unique index, atomic claim, versioned transactional writes); nothing in memory | e2e `charges once when 5 requests share a key`; e2e persistence `grants the lease to exactly one of 5 parallel claims` |
| 4 | Provider timeout | `withTimeout`, outcome `unknown` -> 202 pending, lease released, key kept; resolved by retry / webhook / reconciler | unit (adapter) `returns unknown on timeout without retrying`; unit (handler) `leaves the operation pending and releases the lease when the outcome is unknown`; e2e `completes a timed out charge on retry without charging twice` |
| 5 | Duplicated webhook | unique `payment_notifications._id` in the same transaction | unit `answers duplicate for a repeated event id`; e2e `credits once when the same notification arrives twice` |
| 6 | Out of order webhook | absorbing terminal states, `ignored` / `conflict` | unit `ignores processing after completed`, `reports conflict for failed after completed`, `reports conflict for succeeded after failed`; e2e `keeps a completed operation when a failed notification arrives late` |
| 7 | Webhook before the API response | operation persisted before the provider call; both paths settle through the versioned transaction | unit `credits once when the notification settles before the provider answers`; e2e `credits once when the webhook arrives while the provider call is in flight` |
| 8 | Temporary DB failure | before charge: 500, nothing charged, retry is new; after approval: 202 pending, resolved later; transient write conflicts retried bounded; driver retryable reads/writes | unit `propagates a data source failure before calling the provider`, `answers pending when settlement cannot be persisted after an approval` |
| 9 | Restart mid operation | every step is persisted before the next; lease expiry + reconciler | e2e `reconciler completes an operation whose process died before calling the provider`; e2e `reconciler completes a timed out operation` |
| 10 | Race on the balance | wallet version check inside the transaction + bounded retry | e2e `applies 5 concurrent cash-ins of one user exactly once each`; unit `retries settlement on a concurrent wallet update` |
| | Statement example (250 + 100 = 350) | | e2e `returns the statement contract for a completed cash-in` |
| | Provider failure (declined) | `markFailed` | unit `fails the operation when the provider declines`; e2e `returns failed without new_balance when the provider declines` |
| | Provider unavailable | bounded retry with backoff, then unknown | unit (adapter) `retries an unavailable provider up to the max attempts`; e2e `answers pending after the provider stays unavailable` |
| | Key reused with another payload | O3 | unit `rejects a reused key with a different amount`; e2e `rejects a reused key with another payload` |
| | Invalid signature | guard + verifier | unit (verifier) cases; e2e `rejects an unsigned notification` |

Red flags of slide 13 and where they are answered: in memory idempotency (rule 5.1, sections 7 and
10.3), multi pod (10.3, e2e), unquestioned agent output (ai-log, section 16), blind retries
(section 12), webhooks once (10.4), no tests (section 13).

## 12. Retry and timeout policy

`retryWithBackoff` (`src/shared/application/retry.ts`): `work(attempt)` is called up to
`maxAttempts` times while `shouldRetry(error)` is true; before attempt `n + 1` it waits
`random(0, min(maxDelayMs, baseDelayMs * 2^(n - 1)))` (full jitter); the last error is rethrown.

| What | Retried | Policy | Why safe |
|---|---|---|---|
| Provider charge, `ProviderUnavailableError` | yes, in the request | `PROVIDER_MAX_ATTEMPTS` (3) total, base `RETRY_BASE_DELAY_MS` (50), cap `RETRY_MAX_DELAY_MS` (1000) | same idempotency key (our operation id) |
| Provider charge, timeout | no, in the request | later: client retry with the same key, webhook, reconciler | same key; never a new key for the same operation |
| Settlement on `ConcurrencyException` (version mismatch, write conflict) | yes, reload + reapply | `SETTLEMENT_MAX_ATTEMPTS` (5), same backoff values | conditional on `pending` + version; unique ledger `_id` |
| `DataSourceException` | no (one built in driver retry for retryable reads/writes) | before charge: 500; after: 202 pending | nothing charged / operation still pending |
| Reconciler re-submission | yes, every `RECONCILER_INTERVAL_MS` | until `RECONCILER_MAX_PROVIDER_CALLS` (10) | same key |
| Client (documented) | 202 or 5xx -> retry with the **same** key; 4xx -> do not retry | | |

Never: a new charge with a new key for an existing operation, releasing the idempotency key,
retrying a declined charge, `session.withTransaction` unbounded retries.

Timeouts: provider `PROVIDER_TIMEOUT_MS` (3000); Mongo server selection 5000 (existing); readiness
800 (existing). Lease `OPERATION_LEASE_MS` (15000) must exceed the worst in-request provider time:
`validateEnv` rejects `OPERATION_LEASE_MS <= PROVIDER_TIMEOUT_MS * PROVIDER_MAX_ATTEMPTS + RETRY_MAX_DELAY_MS * (PROVIDER_MAX_ATTEMPTS - 1)`.

New config (each in `env.validation.ts` with `@IsInt() @Min()` / `@IsString() @MinLength(16)`,
an `AppConfigService` getter, `.env.example`, `k8s/configmap.yaml` or `k8s/secret.example.yaml`):

| Key | Default | Min | Used by |
|---|---|---|---|
| `PROVIDER_TIMEOUT_MS` | 3000 | 100 | provider adapter, backend delays |
| `PROVIDER_MAX_ATTEMPTS` | 3 | 1 | provider adapter |
| `RETRY_BASE_DELAY_MS` | 50 | 0 | provider adapter, `CashInSettings` |
| `RETRY_MAX_DELAY_MS` | 1000 | 0 | same |
| `OPERATION_LEASE_MS` | 15000 | 1000 | `CashInSettings` |
| `SETTLEMENT_MAX_ATTEMPTS` | 5 | 1 | `CashInSettings` |
| `WEBHOOK_SIGNING_SECRET` | `dev-only-webhook-signing-secret` | length 16; `validateEnv` rejects the default when `NODE_ENV=production` | verifier (secret.example) |
| `WEBHOOK_TOLERANCE_SECONDS` | 300 | 1 | verifier |
| `RECONCILER_ENABLED` | true | boolean | scheduler |
| `RECONCILER_INTERVAL_MS` | 15000 | 1000 | scheduler |
| `RECONCILER_MIN_AGE_MS` | 30000 | 0 | `CashInSettings` |
| `RECONCILER_BATCH_SIZE` | 20 | 1 | `CashInSettings` |
| `RECONCILER_MAX_PROVIDER_CALLS` | 10 | 1 | `CashInSettings` |

`CashInSettings` (`application/cash-in.settings.ts`): plain class, readonly fields
`leaseMs`, `settlementRetry: RetryPolicy`, `reconciliation: { minAgeMs, batchSize, maxProviderCalls }`;
bound in the module with `useFactory` from `AppConfigService` (same pattern as
`DependencyHealthChecks`, `infrastructure.module.ts:25`).

E2E env (`vitest.config.e2e.ts` `test.env`): `MONGO_DB=wallet_e2e`, `PROVIDER_TIMEOUT_MS=1000`
(so `card_slow` stays in flight 500 ms: a real window for the concurrent and early webhook tests),
`OPERATION_LEASE_MS=4000` (passes the lease rule: 4000 > 1000 * 3 + 100 * 2), `RECONCILER_ENABLED=false`,
`RECONCILER_MIN_AGE_MS=0`, `RETRY_BASE_DELAY_MS=10`, `RETRY_MAX_DELAY_MS=100`,
`THROTTLE_LIMIT=10000` (the per pod limiter must not turn bursts of test requests into 429).
Also `test.fileParallelism: false`: e2e files share `wallet_e2e`, and the reconciler test claims any
stale pending operation.

`docker-compose.yml` runs the api with `NODE_ENV=production`, so the production secret rule would
refuse to boot with the default: the `api` service gets
`WEBHOOK_SIGNING_SECRET: compose-demo-webhook-signing-secret` (demo value, commented as such).

## 13. Test plan

Unit (`npm test`, no infrastructure), `describe(ClassName.name)`:

- `cash-in-operation.aggregate.spec.ts`: initiates pending with version 0; rejects non positive amount (O1); rejects empty / 65 char payment method (O2); accepts a replay with the same request; rejects a different amount, currency, payment method (O3); `markCompleted` from pending credits the wallet, stores charge id and balanceAfter, returns the ledger entry; from completed returns ignored and leaves the wallet untouched; from failed returns conflict and leaves the wallet untouched; `markFailed` from pending / failed / completed; rejects a notification amount mismatch (O6); rehydrate does not validate.
- `wallet.aggregate.spec.ts`: opens with zero; credit adds and returns a ledger entry with balanceAfter; rejects another currency (W1) in `credit` and `assertCanBeCredited`; rejects non positive (W2).
- `initiate-cash-in.handler.spec.ts` (in-memory repos, unit of work, `FakePaymentProvider`, `NoopLogsService`): completes a new cash-in and calls the provider once with the operation id; auto creates the wallet; rejects a currency mismatch before inserting or charging; replays a completed operation without calling the provider; replays a failed operation; rejects a reused key with a different amount; answers pending without calling the provider when the key is in flight; re-submits a pending operation with the same operation id when the lease is free; takes the replay path when the insert hits the unique index; fails the operation when the provider declines; leaves the operation pending and releases the lease when the outcome is unknown; propagates a data source failure before calling the provider; answers pending when settlement cannot be persisted after an approval; credits once when the notification settles before the provider answers (fake provider hook runs the notification handler mid call).
- `cash-in-processor.spec.ts`: retries settlement on a concurrent wallet update; gives up after SETTLEMENT_MAX_ATTEMPTS and leaves the operation pending; never commits a wallet change on ignored or conflict; answers pending when releasing the lease fails after an unknown outcome; answers pending when settlement throws a non retryable error after an approval.
- `handle-payment-notification.handler.spec.ts`: completes and credits a pending operation on succeeded; fails a pending operation on failed; records processing as ignored; answers duplicate for a repeated event id; ignores processing after completed; reports conflict for failed after completed; reports conflict for succeeded after failed; throws not found for an unknown operation; rejects an amount mismatch without recording it.
- `reconcile-pending-operations.handler.spec.ts`: completes a stale pending operation; skips an operation whose lease is held; stops at the batch size; keeps going after one operation throws; leaves an operation pending when the outcome is still unknown.
- `simulated-payment-provider.spec.ts` (fake backend): maps approved and declined; returns unknown on timeout without retrying; retries an unavailable provider up to the max attempts; succeeds when the provider recovers within the attempts.
- `hmac-webhook-signature.verifier.spec.ts`: accepts a valid signature; rejects a tampered body, a wrong secret, an expired timestamp, a malformed header, a missing header.
- `webhook-signature.guard.spec.ts`: passes the raw body and header to the verifier; throws `InvalidWebhookSignatureException` when it fails.
- `cash-in.controller.spec.ts`: builds the command with the decimal string amount and the lowercased key; 200 for completed and failed, 202 for pending; omits `new_balance` unless completed.
- `payment-webhook.controller.spec.ts`: builds the command; returns the result.
- `retry.spec.ts`, `with-timeout.spec.ts`, `env.validation.spec.ts` (lease rule, production secret rule), `generic-exception.filter.spec.ts` (+ 401 for an `AuthenticationException` subclass), updated `check-readiness.handler.spec.ts:68`.

E2E (`npm run test:e2e`, real Mongo, real parallel requests with `Promise.all`). Isolation: every
test uses its own `usr_e2e_<randomUUID()>` user (wallets seeded per test with `insertOne` when the
test needs a starting balance) and fresh keys; no test drops collections, except the reconciliation
file (below).

- `test/cash-in-persistence.e2e-spec.ts`: rejects a second operation with the same user and key; grants the lease to exactly one of 5 parallel claims; rejects a stale version in the unit of work; rejects a second ledger entry for the same operation.
- `test/cash-in.e2e-spec.ts`: returns the statement contract for a completed cash-in (wallet seeded with 250.00 -> `new_balance` 350); returns the same body on a retry with the same key; charges once when 5 requests share a key (`card_slow`; the 5 requests are spread over **two app instances** created from `AppModule` in the same test, i.e. two "pods" with no shared memory; `simulated_provider_charges.calls === 1`, one ledger entry, every body has the same `operation_id`, at least one 202 and the 200s carry the same `new_balance`); applies 5 concurrent cash-ins of one user exactly once each (5 keys in parallel: all 200 `completed`, final balance = seed + 5 x amount, 5 ledger entries, the five `new_balance` values are distinct); completes a timed out charge on retry without charging twice (`card_timeout`: 202 then 200, `calls === 2`, one charge id, one ledger entry); returns failed without new_balance when the provider declines; answers pending after the provider stays unavailable (202, no `simulated_provider_charges` document; the attempt count is proven by the adapter unit test); rejects a reused key with another payload; rejects a missing or malformed key; rejects 3 decimals, a string amount and unknown fields; rejects a currency mismatch.
- `test/payment-webhook.e2e-spec.ts`: completes a pending operation from a signed notification; credits once when the same notification arrives twice; keeps a completed operation when a failed notification arrives late; credits once when the webhook arrives while the provider call is in flight (`card_slow`, operation id polled from Mongo by user and key while the cash-in request is open; asserts the webhook answers `applied`, the cash-in answers 200 `completed` with the same `new_balance`, one ledger entry, balance + amount once); rejects an unsigned notification; answers 404 for an unknown operation; rejects an amount mismatch.
- `test/reconciliation.e2e-spec.ts` (command dispatched through `CommandBus`; `beforeEach` deletes every `pending` document of `cash_in_operations` so leftovers of other files never fill the batch; assertions only on the test's own operation): reconciler completes a timed out operation; reconciler completes an operation whose process died before calling the provider (pending document inserted directly with an expired lease).
- Existing `health.e2e-spec.ts` and `api-docs.e2e-spec.ts` keep passing (they create the app with `{ rawBody: true }` like `main.ts`); `api-docs` also asserts `/cash-in` and `/webhooks/payment` are documented.

## 14. Implementation order

Each step ends with `npm run check` green and one commit with the given message.

**Step 0 (user)**: `git init`, first commit of the clean base: `chore: initial project base`.

**Step 1** `feat(shared): add authentication exception, backoff retry and shared timeout`
- `src/shared/domain/exceptions/concrete.exceptions.ts`: `AuthenticationException` (`authentication-exception`).
- `src/shared/api/constants/domain-exceptions-response.constants.ts`: 401 `Unauthorized` entry.
- `src/shared/application/retry.ts` (+ `retry.spec.ts`): `RetryPolicy`, `retryWithBackoff`.
- `src/shared/application/with-timeout.ts` (+ `with-timeout.spec.ts`): `withTimeout`, `TimeoutExceededError` (moved from `check-readiness.handler.ts:9`).
- `src/modules/health/application/queries/check-readiness/check-readiness.handler.ts` uses it; spec line 68 expects `'TimeoutExceededError: timeout after 50ms'`.
- `src/shared/api/filters/generic-exception.filter.spec.ts`: 401 case.
- `CLAUDE.md` section 8 and `README.md` errors table: `AuthenticationException | 401`.

**Step 2** `feat(cash-in): add wallet and cash-in operation aggregates`
- `src/modules/cash-in/domain/`: `cash-in-status.ts`, `transition-result.ts`, `ledger-entry.ts`,
  `payment-notification.ts`, `payment-notification.exceptions.ts`, `cash-in-operation.aggregate.ts`,
  `cash-in-operation.exceptions.ts`, `cash-in-operation.repository.ts`, `cash-in-operation.aggregate.spec.ts`,
  `wallet.aggregate.ts`, `wallet.exceptions.ts`, `wallet.repository.ts`, `wallet.aggregate.spec.ts`.

**Step 3** `feat(cash-in): persist operations and wallets in mongo with transactional settlement`
- `src/shared/infrastructure/mongo/mongo.module.ts`: `useBigInt64: true`.
- `src/modules/cash-in/application/ports/cash-in-unit-of-work.port.ts`.
- `src/modules/cash-in/infrastructure/mappers/cash-in-operation.mapper.ts`, `mappers/wallet.mapper.ts`.
- `src/modules/cash-in/infrastructure/mongo-cash-in-operation.repository.ts`, `mongo-wallet.repository.ts`, `mongo-cash-in.unit-of-work.ts`.
- `src/modules/cash-in/infrastructure/in-memory/in-memory-cash-in-operation.repository.ts`, `in-memory-wallet.repository.ts`, `in-memory-cash-in.unit-of-work.ts` (version checks, unique ledger and notification ids, `failNextCommitWith(error)`).
- `src/modules/cash-in/cash-in.module.ts` (repositories and unit of work only) imported in `src/app.module.ts`.
- `vitest.config.e2e.ts`: `test.env` (section 12). `test/cash-in-persistence.e2e-spec.ts`.

**Step 4** `feat(cash-in): add simulated payment provider with timeout and bounded retries`
- Config: `PROVIDER_TIMEOUT_MS`, `PROVIDER_MAX_ATTEMPTS`, `RETRY_BASE_DELAY_MS`, `RETRY_MAX_DELAY_MS` (env, getters, `.env.example`, `k8s/configmap.yaml`).
- `src/modules/cash-in/application/ports/payment-provider.port.ts`.
- `src/modules/cash-in/infrastructure/simulated-provider/simulated-provider.backend.ts`.
- `src/modules/cash-in/infrastructure/simulated-payment-provider.ts` (+ `simulated-payment-provider.spec.ts`).
- `src/modules/cash-in/infrastructure/in-memory/fake-payment-provider.ts` (scripted outcomes, recorded calls, `onCharge` hook).
- Module: `PaymentProvider -> SimulatedPaymentProvider`, `SimulatedProviderBackend`.

**Step 5** `feat(cash-in): initiate cash-in with idempotency, lease and settlement`
- Config: `OPERATION_LEASE_MS`, `SETTLEMENT_MAX_ATTEMPTS` + lease rule in `validateEnv` (+ `src/config/env.validation.spec.ts`).
- `src/modules/cash-in/application/cash-in.settings.ts`, `cash-in.results.ts`, `cash-in-processor.ts` (+ `cash-in-processor.spec.ts`).
- `src/modules/cash-in/application/commands/initiate-cash-in/initiate-cash-in.command.ts`, `.handler.ts`, `.handler.spec.ts`.
  `InitiateCashInCommand extends Command<CashInResult>`: `userId`, `idempotencyKey`, `amount` (decimal string), `currency`, `paymentMethod`, `traceId`.
- Module: `CashInSettings`, `CashInProcessor` (`useFactory`), `InitiateCashInHandler`.

**Step 6** `feat(cash-in): expose post /cash-in`
- `src/modules/cash-in/api/decorators/idempotency-key.decorator.ts` (header, `isUUID` from class-validator, lowercase, `InvalidIdempotencyKeyException`).
- `CLAUDE.md` section 2: add `decorators/` and `guards/` under the module `api/` folder (context specific param decorators and guards), so the spec matches the tree.
- `src/modules/cash-in/api/dto/cash-in.request.dto.ts`, `dto/cash-in.response.dto.ts`, `mappers/cash-in.response.mapper.ts`.
- `src/modules/cash-in/api/cash-in.controller.ts` (+ `cash-in.controller.spec.ts`).
- `test/cash-in.e2e-spec.ts`. `scripts/seed.mongodb.js` + `package.json` script `"seed": "docker compose exec -T mongo mongosh --quiet wallet --eval \"$(cat scripts/seed.mongodb.js)\""` (`updateOne({ _id: 'usr_abc123' }, { $setOnInsert: { currency: 'PEN', balanceMinor: NumberLong(25000), version: 0, createdAt, updatedAt } }, { upsert: true })`: re-running never resets a live balance or version).

**Step 7** `feat(cash-in): handle payment webhooks with signature and deduplication`
- Config: `WEBHOOK_SIGNING_SECRET`, `WEBHOOK_TOLERANCE_SECONDS` (+ production rule, spec case, `k8s/secret.example.yaml`).
- `src/modules/cash-in/application/ports/webhook-signature-verifier.port.ts` (`verify(rawBody: Buffer, signatureHeader: string | undefined): void`, throws `InvalidWebhookSignatureException`).
- `src/modules/cash-in/infrastructure/hmac-webhook-signature.verifier.ts` (+ spec).
- `src/modules/cash-in/application/commands/handle-payment-notification/handle-payment-notification.command.ts`, `.handler.ts`, `.handler.spec.ts`
  (`HandlePaymentNotificationCommand extends Command<PaymentNotificationResult>`: `notificationId`, `type`, `operationId`, `providerChargeId: string | null`, `amount` (decimal string), `currency`, `failureReason: string | null`, `traceId`).
- `src/modules/cash-in/api/guards/webhook-signature.guard.ts` (+ spec), `api/dto/payment-webhook.request.dto.ts`, `dto/payment-webhook.response.dto.ts`, `api/payment-webhook.controller.ts` (+ spec).
- `src/shared/api/interfaces/request.interface.ts`: `rawBody?: Buffer`. `src/main.ts`: `rawBody: true`. Existing e2e: `createNestApplication({ rawBody: true })`.
- `docker-compose.yml` `api.environment`: `WEBHOOK_SIGNING_SECRET: compose-demo-webhook-signing-secret` (section 12).
- `test/payment-webhook.e2e-spec.ts`, `scripts/send-webhook.mjs` (builds the payload, signs with `process.env.WEBHOOK_SIGNING_SECRET` or, if unset, `compose-demo-webhook-signing-secret`; README shows `WEBHOOK_SIGNING_SECRET=dev-only-webhook-signing-secret` for `start:dev`; POSTs to `http://localhost:3000/webhooks/payment`, prints status and body).

**Step 8** `feat(cash-in): reconcile stale pending operations`
- Config: `RECONCILER_*` (env, getters, `.env.example`, configmap).
- `src/modules/cash-in/application/commands/reconcile-pending-operations/reconcile-pending-operations.command.ts`, `.handler.ts`, `.handler.spec.ts`.
- `src/modules/cash-in/infrastructure/reconciliation.scheduler.ts`.
- `src/main.ts`: `app.enableShutdownHooks()` so `OnApplicationShutdown` stops the timer on SIGTERM (a terminating pod stops claiming; an in-flight claim is released by lease expiry).
- `test/reconciliation.e2e-spec.ts`; `test/api-docs.e2e-spec.ts` asserts both paths.

**Step 9** `docs: document architecture, idempotency, concurrency, retries and ai usage`
- `README.md`: every `TODO(reto)` (from this plan and `docs/ai-log.md`), curl per scenario, Redis vs DB, 1M ops/day.
- `docs/ai-log.md`: entries of section 16 that happened.

Cut list if time runs short (in this order): `scripts/send-webhook.mjs` (README shows the signing
snippet instead), `ReconciliationScheduler` (the command and its e2e stay; README says how it would
run as a CronJob).

## 15. Local verification

| After | Command | Expected |
|---|---|---|
| every step | `npm run check` | lint (layers), typecheck, unit tests, build green |
| 3, 6, 7, 8 | `npm run infra:up && npm run test:e2e` | all e2e green |
| 6 | `docker compose down -v && docker compose up -d --build --wait && npm run seed` then the curl of 9.1 | 200, `new_balance: 350` (fresh volume) |
| 6 | same curl, same key | identical body |
| 6 | same key, `"amount": 50` | 422 `idempotency-key-reused-exception` |
| 6 | new key, `"payment_method":"card_timeout"` | 202 `pending`; repeat same key -> 200 `completed`, balance +100 once |
| 6 | new key, `card_declined` | 200 `failed`, no `new_balance` |
| 6 | 5 parallel curls same key, `card_slow` (`seq 5 \| xargs -P5 -I{} curl …`) | one 200 and the rest 202 / 200 with the same `operation_id`; `db.simulated_provider_charges.findOne()` `calls: 1` |
| 7 | `card_timeout` cash-in (202, take its `operation_id`), then within 30 s (before the reconciler) `node scripts/send-webhook.mjs <op> payment.succeeded 100.00 PEN` twice | `applied`, then `duplicate`; retrying the cash-in with its key -> 200 `completed`, balance +100 once |
| 7 | curl without signature | 401 |
| 8 | `card_timeout` cash-in, wait 30 s without retrying | `npm run logs` shows the reconciler completing it; retry with the key -> 200 |
| any | `x-trace-id: demo-1` on a request | every log line of that flow has `trace=demo-1` |

## 16. AI log entries to record

Already happened (recorded in `docs/ai-log.md` during validation, together with #5 to #8 from section 19):
- #4 Contract of non completed operations: the agent proposed `new_balance: null` for pending and
  failed. The user corrected: a `null` balance is misleading and the live balance is not stable for
  replays; the field is omitted unless `completed` (D7).

Risks to watch during implementation (if the agent does any of these, fix and log it):
- Using `session.withTransaction` (unbounded 120 s retry) instead of the bounded loop.
- Mapper `$set` of the whole document, overwriting `leaseUntil` / `providerCallCount` from a stale aggregate.
- Converting `amount` with `Math.round(amount * 100)` or `parseFloat`.
- Simulated provider state in a `Map` (breaks multi pod and the "called once" proof).
- Releasing the idempotency key, or deleting the operation, on a provider error.
- A provider call without `withTimeout`, or retrying on timeout inside the request.
- Business decisions in the controller (it only maps `pending` to 202).
- Floating promises in the scheduler; `console.*` anywhere.
- Re-submitting a final operation (claim must filter `status: 'pending'`).
- Choosing a new provider key on retry.

## 17. Verified facts

| Fact | Where |
|---|---|
| `Money` (bigint minor units, `of(decimal string)`, `ofMinor`, `zero`, `add`, `isPositive`, `equals`, `toDecimalString`), `CURRENCIES`, `Currency` | `src/shared/domain/money.ts:3`, `:19`, `:25`, `:30`, `:43`, `:47`, `:57`, `:70`, `:77` |
| `Money.of` accepts `"100"`, `"10.5"`, `"10.05"` (pattern) and `String(100.00) === "100"`, `String(10.05) === "10.05"` | `money.ts:8`; checked with `node -e` |
| `DomainException` base with `staticCode` / `instanceCode` | `src/shared/domain/exceptions/domain.exception.ts:10` |
| Base exceptions | `src/shared/domain/exceptions/concrete.exceptions.ts:4` (Default), `:10` (DataSource), `:16` (Service), `:22` (DataInput), `:28` (NotFound), `:34` (Conflict), `:40` (Concurrency), `:46` (BusinessRule) |
| HTTP mapping and inheritance lookup | `src/shared/api/constants/domain-exceptions-response.constants.ts:25`, `:73` |
| `@ApiDomainErrors` | `src/shared/api/decorators/api-domain-errors.decorator.ts:11` |
| `@TraceId()` | `src/shared/api/decorators/trace-id.decorator.ts:5` |
| `ICustomRequest` | `src/shared/api/interfaces/request.interface.ts:4` |
| traceId assignment and echo, `TRACE_ID_HEADER` | `src/shared/api/middleware/logger.middleware.ts:7`, `:22` |
| `Cache-Control: no-store` | `src/shared/api/middleware/no-store.middleware.ts:11` |
| Single error format, 4xx `warn` / 5xx `error` | `src/shared/api/filters/generic-exception.filter.ts:29`, `:44` |
| Validation errors are `DataInputException` | `src/shared/api/validation/validation-exception.factory.ts:25` |
| `ValidationPipe` whitelist + forbidNonWhitelisted + transform; CORS allows `Idempotency-Key` | `src/app.setup.ts:16`, `:27` |
| `NestFactory.create` with `bufferLogs` (add `rawBody`) | `src/main.ts:10` |
| Nest supports `rawBody` | `node_modules/@nestjs/common/interfaces/nest-application-options.interface.d.ts:25` |
| Driver supports `useBigInt64` | `node_modules/mongodb/lib/bson.js:69` |
| `MongoClient` creation (add `useBigInt64`), tokens exported | `src/shared/infrastructure/mongo/mongo.module.ts:14`, `:26`; `mongo.tokens.ts:1` |
| `LogsService` port, `NoopLogsService` | `src/shared/application/ports/logs.service.ts:7`; `src/shared/infrastructure/in-memory/noop-logs.service.ts:4` |
| `Traced` | `src/shared/application/traced.ts:5` |
| `useFactory` binding pattern for a plain application class | `src/shared/infrastructure/infrastructure.module.ts:25` |
| Config pattern | `src/config/env.validation.ts:13`, `:61`; `src/config/app-config.service.ts:23` |
| `withTimeout` to move; spec expectation to update | `src/modules/health/application/queries/check-readiness/check-readiness.handler.ts:9`; `check-readiness.handler.spec.ts:68` |
| `@Res({ passthrough: true })` status pattern, `@SkipThrottle` | `src/modules/health/api/health.controller.ts:20`, `:38`, `:44` |
| `CqrsModule.forRoot()`, global `ThrottlerGuard` | `src/app.module.ts:27`, `:32` |
| Mongo single node replica set (transactions) | `docker-compose.yml:15` |
| E2E config and CI e2e job against compose Mongo | `vitest.config.e2e.ts:8`; `.github/workflows/ci.yml:39` |
| Layer lint rules | `.oxlintrc.json:12`, `:23`, `:36` |

## 18. Open decisions

None.

## 19. Validation log

Run: `/validate-plan`, fresh session, 2026-10-06. Every row of section 17 re-opened at its
`path:line`: all true (`check-readiness.handler.spec.ts:68` currently expects
`'Error: timeout after 50ms'`; step 1 changes it as planned). Statement coverage: the 10 scenarios,
the 6 deliverables, the 4 required test kinds and the 7 red flags all map to sections 6, 10, 11, 13.
No structural gap (aggregate boundaries and flows hold), so the plan was patched, not returned.

| # | Gap found | Severity | Resolution |
|---|---|---|---|
| V1 | `docker-compose.yml` runs the api with `NODE_ENV=production`; the planned rule "reject the default webhook secret in production" would stop `docker compose up` from booting, and `send-webhook.mjs` had no matching secret. | blocker for delivery | Compose sets a demo secret; the script defaults to it; README gives the `start:dev` variant (sections 12, 14 step 7). |
| V2 | `unknown` outcome: a failing `releaseLease` propagated as 500 after the provider may have charged; settlement failures other than concurrency / data source (defensive not found, ledger conflict) also escaped as 4xx/5xx. | money path contract | `chargeAndSettle` swallows (and logs) every failure after the provider call and answers 202 pending; contract row reworded; two unit tests added (sections 9.1, 10, 13). |
| V3 | State machine claimed `completed/failed + unknown` "cannot happen"; it happens when a webhook settles during the provider call. | ambiguity | Rows defined: lease release is a no-op, 202 from the snapshot, next retry replays (section 6). |
| V4 | Lease presented as if it were the exclusivity guarantee; it depends on the pod clock and can be outlived. | defense / README | Stated as an efficiency guard; safety comes from provider idempotency + versioned settlement + unique ledger id (section 5.4). |
| V5 | E2E flakiness: files run in parallel on one DB while the reconciler claims any stale pending operation (and leftovers across runs could fill its batch); 150 ms in flight window for the early webhook test; per pod throttler at 100 req/min. | test reliability | `fileParallelism: false`, per test users, reconciliation `beforeEach` cleanup, `PROVIDER_TIMEOUT_MS=1000` (lease rule still holds), `THROTTLE_LIMIT=10000` (sections 12, 13). |
| V6 | "5 pods" e2e ran on a single app instance: it proved the DB guarantee but not the absence of in-process state. | proof strength (eliminatory area) | The test spreads the 5 requests over two app instances; assertions on 202/200 bodies made explicit (section 13). |
| V7 | `cash-in.results.ts` types and `CashInProcessor` constructor were unnamed: two implementers would differ. | ambiguity | Types and constructor order specified (section 10). |
| V8 | Webhook "before the API response" e2e could pass even if the webhook arrived after the API finished. | test validity | Asserts the webhook answers `applied` and the API 200 carries the same balance (section 13). |
| V9 | Seed with a plain upsert would reset a live balance and its version; manual check of `new_balance: 350` assumed an empty volume; the manual webhook check had no pending operation to apply to. | verification | Seed uses `$setOnInsert`; verification runs on a fresh volume and uses a `card_timeout` operation (sections 14, 15). |
| V10 | New `api/decorators/` and `api/guards/` folders not in `CLAUDE.md` section 2; reconciler shutdown hook never fires without `enableShutdownHooks()`. | standards | `CLAUDE.md` section 2 updated in step 6; `main.ts` change in step 8. |
| V11 | Why 5 settlement attempts suffice for 5 concurrent credits was not argued (the e2e expects all 200). | reasoning gap | Argument added (section 10). |

Result: checklist passes, no open decisions. `APPROVED FOR IMPLEMENTATION`.

## 20. Implementation log

One commit per step of section 14. Small gaps closed while implementing, and the one decision taken with the user.

| Step | What differs from the plan or was added | Why |
|---|---|---|
| 3 | `shared/infrastructure/mongo/mongo-errors.ts` (`isDuplicateKeyError`, `isTransientTransactionError`, `translateDriverErrors`); the in-memory repositories expose `assertVersion` and `apply` for the in-memory unit of work; four extra persistence e2e tests (`settles operation, wallet and ledger entry together`, `rolls back operation and wallet when the ledger entry already exists`, plus `accepts the same key for different users` and `does not let a released lease free a final operation`). | One place for the driver error rules of `CLAUDE.md` section 6; the test doubles need the same version semantics; the extra tests prove the transaction is all or nothing. |
| 5 | `CashInSettings.reconciliation` was added in step 8 (no caller before). The processor accepts the notification context in step 5 as planned, covered by `cash-in-processor.spec.ts`; the test `credits once when the notification settles before the provider answers` calls `processor.settleApproved` mid call because the notification handler arrives in step 7. | No code without a caller; the handler did not exist yet. |
| 6 | `parseIdempotencyKey` is exported next to the `@IdempotencyKey()` decorator and unit tested. The seed uses `NumberInt(0)` for `version`. | A param decorator is not unit testable on its own; keep the version an int32 like the driver writes it. |
| 7 | DTO optional fields (`provider_charge_id`, `failure_reason`) are validated whenever present, not only for their type; the handler rejects a `payment.succeeded` or `payment.failed` without its field with a `DataInputException` (defensive, the DTO already guarantees it). | A wrongly typed optional field must not slip through when it is not required. |
| 8 | **D11** (`excludedIds`). `src/main.ts` needs no `enableShutdownHooks()`: `setupApp`, shared by `main.ts` and the e2e tests, already calls it. | See D11; avoid a duplicate call. |
| Review | `/validate-implementation` (`docs/plans/IMPLEMENTATION-REVIEW.md`), fixed after the audit: a replay whose claim returns `null` re-reads the operation and answers its current state (10.2: 202 while in flight, the final 200 if it settled after the lookup), test `answers the final result when the operation settles between the lookup and the claim`. Four tests carry a longer name than sections 11 and 13: `answers duplicate for a repeated event id and credits once`, `reports conflict for failed after completed and keeps the operation completed`, `reports conflict for succeeded after failed and does not credit`, `retries an unavailable provider up to the max attempts, then returns unknown`. | The stale 202 made the client poll once more; the longer names state the extra assertion each test makes, and the README cites them. |

Verification run (2026-10-06): `npm run check` green at every step (139 unit tests at the end), `npm run test:e2e` 48 tests green and repeated three times after steps 6, 7 and 8, manual checks of section 15 executed against `docker compose` for steps 6, 7 and 8 (statement example, replay, 422 on a reused key, timeout then retry, decline, five parallel requests with one provider call, webhook applied, duplicate and conflict, 401 without signature, trace id on every log line, reconciler completing a timed out operation).
