import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export const DEFAULT_WEBHOOK_SIGNING_SECRET = 'dev-only-webhook-signing-secret';

/** Environment contract. The app refuses to start with an invalid config. */
export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsInt()
  @Min(1)
  @Transform(({ value }) => Number(value))
  PORT = 3000;

  @IsString()
  MONGO_URI = 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true';

  @IsString()
  MONGO_DB = 'wallet';

  /** Fail fast when Mongo is unreachable (driver default is 30s). */
  @IsInt()
  @Min(100)
  @Transform(({ value }) => Number(value))
  MONGO_SERVER_SELECTION_TIMEOUT_MS = 5_000;

  /** Per dependency budget of /health/ready (Kubernetes probe timeout is 1s). */
  @IsInt()
  @Min(50)
  @Transform(({ value }) => Number(value))
  HEALTH_CHECK_TIMEOUT_MS = 800;

  @IsInt()
  @Min(1)
  @Transform(({ value }) => Number(value))
  THROTTLE_TTL_MS = 60_000;

  @IsInt()
  @Min(1)
  @Transform(({ value }) => Number(value))
  THROTTLE_LIMIT = 100;

  /** Budget of one charge submission to the payment provider. */
  @IsInt()
  @Min(100)
  @Transform(({ value }) => Number(value))
  PROVIDER_TIMEOUT_MS = 3_000;

  /** Total submissions of one charge when the provider is unavailable (same key every time). */
  @IsInt()
  @Min(1)
  @Transform(({ value }) => Number(value))
  PROVIDER_MAX_ATTEMPTS = 3;

  @IsInt()
  @Min(0)
  @Transform(({ value }) => Number(value))
  RETRY_BASE_DELAY_MS = 50;

  @IsInt()
  @Min(0)
  @Transform(({ value }) => Number(value))
  RETRY_MAX_DELAY_MS = 1_000;

  /**
   * Exclusive right to call the provider for one operation. Must outlast the worst
   * in-request provider time (checked in validateEnv).
   */
  @IsInt()
  @Min(1_000)
  @Transform(({ value }) => Number(value))
  OPERATION_LEASE_MS = 15_000;

  /** Attempts of one settlement when it conflicts with a concurrent write. */
  @IsInt()
  @Min(1)
  @Transform(({ value }) => Number(value))
  SETTLEMENT_MAX_ATTEMPTS = 5;

  /** HMAC key shared with the provider. The default is rejected when NODE_ENV=production. */
  @IsString()
  @MinLength(16)
  WEBHOOK_SIGNING_SECRET = DEFAULT_WEBHOOK_SIGNING_SECRET;

  /** Max distance between a webhook timestamp and now (replay window). */
  @IsInt()
  @Min(1)
  @Transform(({ value }) => Number(value))
  WEBHOOK_TOLERANCE_SECONDS = 300;

  /** In process periodic job; each stale pending operation is claimed atomically in Mongo. */
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  RECONCILER_ENABLED = true;

  @IsInt()
  @Min(1_000)
  @Transform(({ value }) => Number(value))
  RECONCILER_INTERVAL_MS = 15_000;

  /** A pending operation younger than this is left to its own request, webhook or retry. */
  @IsInt()
  @Min(0)
  @Transform(({ value }) => Number(value))
  RECONCILER_MIN_AGE_MS = 30_000;

  @IsInt()
  @Min(1)
  @Transform(({ value }) => Number(value))
  RECONCILER_BATCH_SIZE = 20;

  /** Provider submissions after which an operation is left pending for manual review. */
  @IsInt()
  @Min(1)
  @Transform(({ value }) => Number(value))
  RECONCILER_MAX_PROVIDER_CALLS = 10;

  /** Comma separated list of origins, or "*". */
  @IsString()
  CORS_ALLOWED_ORIGIN = '*';

  /** Defaults to false in production (set by validateEnv). */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  SWAGGER_ENABLED?: boolean;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config, {
    exposeDefaultValues: true,
  });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(`Invalid environment:\n${errors.toString()}`);
  }
  assertLeaseOutlastsProviderCalls(env);
  assertProductionSecret(env);
  env.SWAGGER_ENABLED ??= env.NODE_ENV !== 'production';
  return env;
}

/** A lease shorter than the in-request provider time would let a second process charge too. */
function assertLeaseOutlastsProviderCalls(env: EnvironmentVariables): void {
  const worstCaseMs =
    env.PROVIDER_TIMEOUT_MS * env.PROVIDER_MAX_ATTEMPTS +
    env.RETRY_MAX_DELAY_MS * (env.PROVIDER_MAX_ATTEMPTS - 1);
  if (env.OPERATION_LEASE_MS <= worstCaseMs) {
    throw new Error(
      `Invalid environment: OPERATION_LEASE_MS (${env.OPERATION_LEASE_MS}) must exceed the worst case provider time (${worstCaseMs} ms)`,
    );
  }
}

function assertProductionSecret(env: EnvironmentVariables): void {
  if (
    env.NODE_ENV === 'production' &&
    env.WEBHOOK_SIGNING_SECRET === DEFAULT_WEBHOOK_SIGNING_SECRET
  ) {
    throw new Error(
      'Invalid environment: WEBHOOK_SIGNING_SECRET must be set in production',
    );
  }
}
