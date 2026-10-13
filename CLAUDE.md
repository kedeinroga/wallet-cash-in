# Engineering rules for the AI agent (Wallet Cash-In challenge)

This file is the spec every coding session starts from. It is versioned on purpose: it is part of
how the agent was piloted (see `docs/ai-log.md` and the "Use of AI" section of the README).

- The **challenge statement wins** over anything here. When a rule below and the statement or the
  approved plan (`docs/plans/PLAN.md`) disagree, stop and ask; never pick one silently.
- Code, names, comments, docs and commits in English. No em dash in docs.
- **No dead code, no speculative abstractions.** Nothing is added "in case we need it": every file,
  port, config key and dependency has a caller in the flow. A reviewer must not find template
  leftovers.

Architecture: **DDD + CQRS (`@nestjs/cqrs`) on versioned MongoDB documents**, organized by bounded
context, with Clean Architecture dependency rules. Rules marked **[lint]** fail `npm run lint`.

---

## 1. Dependency rule

```
api/  ──►  application/  ──►  domain/
                ▲
infrastructure/ ┘  (implements the ports declared in domain/ and application/)
```

| Layer | May import | Must never import |
|---|---|---|
| `domain/` | `shared/domain` only | `@nestjs/*`, drivers, `class-validator`, `application/`, `infrastructure/`, `api/` **[lint]** |
| `application/` | `domain/`, `shared/application`, `@nestjs/cqrs` | other `@nestjs/*`, drivers, `express`, `class-validator`, `infrastructure/`, `api/` **[lint]** |
| `infrastructure/` | everything inward, drivers, `@nestjs/common` | `api/` |
| `api/` | `application/` (commands, result types), `shared/api`, `domain/` exceptions for Swagger | drivers, `infrastructure/` **[lint]** |

Specs (`*.spec.ts`) and `test/` are exempt so they can use in-memory adapters.

## 2. Folder structure

```
src/
  modules/<context>/
    domain/
      <aggregate>.aggregate.ts          invariants and state transitions
      <aggregate>.exceptions.ts         DomainException subclasses with staticCode
      <aggregate>.repository.ts         repository port (abstract class)
      <aggregate>.aggregate.spec.ts
      <name>.ts                         value objects / enums of the context
    application/
      commands/<action>/                <action>.command.ts, <action>.handler.ts, <action>.handler.spec.ts
      ports/                            gateways and other ports (abstract classes)
      <context>.results.ts              result types returned by handlers
    infrastructure/
      mongo-<aggregate>.repository.ts
      mappers/                          persistence document <-> aggregate
      <adapter>.ts                      gateway adapters (e.g. simulated payment provider)
      in-memory/                        test doubles of this context's ports
    api/
      <resource>.controller.ts (+ spec)
      decorators/                       context specific param decorators (e.g. @IdempotencyKey())
      guards/                           context specific guards (e.g. webhook signature)
      dto/                              *.request.dto.ts, *.response.dto.ts
      mappers/                          result -> response DTO
    <context>.module.ts
  shared/
    domain/                             Money, exceptions/
    application/                        ports (LogsService, DependencyHealthCheck), Traced
    infrastructure/                     mongo/, logging/, in-memory/
    api/                                filters/, middleware/, decorators/, constants/, dto/, interfaces/, validation/
  config/                               env.validation.ts, AppConfigService, AppConfigModule
  modules/health/                       readiness as a query over DependencyHealthCheck ports
```

File names: kebab-case with a role suffix (`.aggregate.ts`, `.command.ts`, `.handler.ts`,
`.repository.ts`, `.mapper.ts`, `.request.dto.ts`, `.response.dto.ts`, `.exceptions.ts`). One class
per file, except the exceptions of one aggregate. Imports use the `.js` extension (ESM).

## 3. Domain

- **Aggregates** are plain classes (no framework, no persistence types). Public methods are
  commands in ubiquitous language (`markCompleted`, `credit`), never `update` or setters. Each
  method validates its invariants, then mutates private state.
- Every aggregate carries a `version: number` used for optimistic concurrency. The domain does not
  increment it; the repository does on a successful write.
- Construction: `static create(...)` for a new aggregate (validates), `static rehydrate(props)` for
  loading from persistence (no validation, no side effects). Expose state through getters only.
- **State machines** live in the aggregate: a transition from a state that does not allow it is
  either rejected with a precise exception or, when the statement requires tolerance (late or
  duplicated provider notifications), returns a result saying it was ignored. Terminal states are
  absorbing. Which one applies to each transition is defined in the plan, never improvised.
- **Value objects** are immutable classes with a private constructor and validating static
  factories (`Money.of`). Equality by value.
- **Repository port**: `abstract class` in `domain/`, domain language (`findById`,
  `findByIdempotencyKey`, `save`).
- Ids are generated in the application layer (`randomUUID()`), never by the database.

## 4. Application (CQRS)

- **Commands and queries** extend `Command<Result>` / `Query<Result>` from `@nestjs/cqrs` and
  implement `Traced`: `traceId` is always the **last** constructor parameter. Fields are `readonly`
  primitives, never DTO classes.
- **One handler per command or query.** Handlers orchestrate: load aggregates, call ports, call
  aggregate methods, save, return a result. Choosing which aggregate method to call from a port
  outcome (e.g. provider approved / declined / unknown) is orchestration; validating a business
  rule is not (that belongs in the aggregate).
- Results are plain types in `<context>.results.ts`. Never return an aggregate.
- **Ports** are `abstract class`es: they double as DI tokens, so consumers inject them by type
  without `@Inject()`. Only driver clients use symbol tokens.
- Logging through `LogsService` with `{ traceId, ...ids }`. Never `console.*` **[lint]**, never
  Nest `Logger` in application code.

## 5. Money movement rules (non negotiable)

These exist because of what the statement evaluates. A change that breaks one is a bug.

1. **No in-memory state for correctness.** Several pods run the service. Idempotency, locks and
   deduplication live in MongoDB (unique indexes, conditional updates, transactions), never in a
   variable, a `Map` or a per process cache.
2. **The database is the idempotency source of truth.** The idempotency key is scoped per user and
   protected by a unique index. A duplicate insert means "this operation already exists": load it
   and answer from its current state.
3. **Never release an idempotency key after the provider may have been called.** A failure before
   calling the provider may be retried as new; an unknown outcome (timeout, connection reset) keeps
   the operation in a pending state that a retry, a webhook or the reconciler resolves.
4. **Never retry a charge blindly.** The provider receives our operation id as its idempotency key,
   so any repeated call is safe by construction. Automatic retries apply only to idempotent calls,
   bounded, with backoff and jitter.
5. **Credit exactly once.** The ledger entry for an operation is unique by operation id; the wallet
   balance and the ledger entry change in the same transaction.
6. **Webhooks are untrusted, repeated and unordered.** Verify the signature, deduplicate by the
   provider event id, and apply them as idempotent state transitions. A late or stale notification
   never moves a terminal operation.
7. **Every external call has a timeout.** Config through `AppConfigService`, never a magic number.

## 6. Infrastructure

- Adapters **extend** the port's abstract class and call `super()`.
- **Optimistic concurrency**: updates filter by `{ _id, version: expected }` and increment the
  version; zero matched documents means a concurrent write (`ConcurrencyException` subclass).
- Unique index violations (code 11000) become a precise `DomainException` (e.g. duplicate
  operation), never leak as a driver error.
- **Every other driver error becomes a `DataSourceException('...', { cause })`.**
- Indexes are created in the repository `onModuleInit`.
- **Mappers** (`infrastructure/mappers/`) convert documents to aggregates and back. Never leak
  `_id` or driver types past infrastructure.
- Multi document atomic changes use a Mongo transaction (Mongo runs as a replica set for this).
- Config only through `AppConfigService` getters. Never `process.env`.

## 7. API

Controllers translate HTTP to commands through `CommandBus`. Nothing else.

Every endpoint has, in this order:

```ts
@ApiOperation({ summary: '...', operationId: 'camelCaseUnique' })
@ApiOkResponse({ type: XResponseDto })            // plus every other success status it can return
@ApiDomainErrors(ExceptionA, ExceptionB)          // every exception the flow can raise
@HttpCode(HttpStatus.OK)                          // POST that does not create a resource
@Post('...')
handler(@TraceId() traceId: string, @Body() body: XRequestDto)
```

- **The HTTP contract of the statement is binding**: paths (`/cash-in`, `/webhooks/payment`, no
  version prefix), snake_case field names, and `amount` / `new_balance` as JSON numbers.
- **Money at the boundary**: the request `amount` is a JSON number validated to be positive with at
  most 2 decimals, converted to `Money` through its decimal string (never through float
  arithmetic). Responses render `Money` back to a JSON number with 2 decimals. Inside the service,
  money is always `Money`.
- **Request DTOs**: `class-validator` with explicit limits (`@MaxLength`, `@IsIn(CURRENCIES)`)
  and `@ApiProperty` with `example`. The `Idempotency-Key` header is required and must be a UUID.
- **Response DTOs** are classes with `@ApiProperty`, built by `api/mappers/`.
- `ValidationPipe` runs with `whitelist` + `forbidNonWhitelisted`: unknown fields are a 400.

## 8. Errors

| Base class | HTTP | Use for |
|---|---|---|
| `DataInputException` | 400 | invalid value, failed validation, missing header |
| `AuthenticationException` | 401 | caller not authenticated (invalid webhook signature) |
| `DataNotFoundException` | 404 | aggregate not found |
| `DataConflictException` | 409 | duplicates, operation still in progress |
| `ConcurrencyException` | 409 | optimistic concurrency |
| `BusinessRuleViolationException` | 422 | broken invariant, idempotency key reused with another payload |
| `ServiceException` | 503 | external dependency down |
| `DataSourceException` | 500 | data store failure |
| `DefaultException` | 500 | anything unexpected |

- New exception = subclass of the right base in `<aggregate>.exceptions.ts` with
  `static override readonly staticCode = '<kebab>-exception'` and
  `override readonly instanceCode = X.staticCode`, plus a constructor that builds a precise
  message. It inherits the HTTP mapping of its closest ancestor in
  `DOMAIN_EXCEPTIONS_TO_HTTP_RESPONSE`.
- Single error format (`ErrorResponseDto`):
  `{ statusCode, code, errorMessage, errorMessageDescription, path, timestamp, traceId }`.
- 4xx expose the exception message; 5xx only the generic description, details go to the logs.
- Never throw Nest `HttpException`s from application or domain code.

## 9. Observability

- `LoggerMiddleware` assigns `traceId` (accepts inbound `x-trace-id`), echoes it in the response
  and logs request start and finish with `durationMs`. `/health/*` is not logged.
- One JSON schema for every stdout line through `LogsService`. Never add another logger.
- `traceId` flows: request → command → provider call → webhook handling logs. Operation id and
  user id are logged on every business milestone (`info`), expected client errors are `warn`,
  failures are `error` with the error object and its `cause` chain.
- Every API response is `Cache-Control: no-store`.

## 10. Module wiring

```ts
@Module({
  controllers: [XController],
  providers: [
    { provide: XRepository, useClass: MongoXRepository },   // port -> adapter
    DoXHandler,
  ],
})
export class XModule {}
```

Import the module in `AppModule`. Shared ports (`LogsService`, `DependencyHealthChecks`) come from
the global `InfrastructureModule`.

## 11. Testing

| Layer | Test | Doubles |
|---|---|---|
| Domain | unit, one test per invariant and per state transition | none |
| Command handlers | unit, `new Handler(fakes)` | in-memory repositories and gateways, `NoopLogsService` |
| Controllers | `Test.createTestingModule`, assert the command built and the status code | `CommandBus` mock |
| Shared HTTP pieces | supertest on a tiny test controller | none |
| Adapters, full flow, concurrency | e2e (`test/*.e2e-spec.ts`) against docker compose Mongo | simulated provider only |

- `describe(ClassName.name, ...)`; test names state behavior (`'charges once when 5 requests share a key'`).
- Every scenario of the statement and every edge case of the plan gets a named test.
- Concurrency claims are proven with real parallel requests against real Mongo, not argued.
- Gate before every commit: `npm run check` (lint, typecheck, unit, build). E2E when infra changes.

## 12. Clean code

- TypeScript strict. **No `any`** **[lint]**; use `unknown` and narrow. No non-null `!` outside tests.
- **No unused code** **[lint]** (`_` prefix for intentionally unused args).
- Explicit return types on public methods. `readonly` by default.
- Small functions, early returns, no nested ternaries, no boolean flag parameters.
- Names in ubiquitous language; no `data`, `info`, `manager`, `helper`, `utils` dumping grounds.
- Comments explain *why* (invariants, trade-offs), never restate the code. JSDoc on ports.
- No magic numbers or strings: constants or config getters.

## 13. Git

- Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`, `chore:`), one per plan step.
- No `Co-Authored-By` or any AI attribution line in commits or PRs.
- Never `git push`, never `--no-verify`. The user pushes.
