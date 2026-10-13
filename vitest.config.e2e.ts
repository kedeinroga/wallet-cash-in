import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// e2e tests need the docker compose dependencies running (Mongo).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Files share one database and the reconciler claims any stale pending operation.
    fileParallelism: false,
    env: {
      MONGO_DB: 'wallet_e2e',
      PROVIDER_TIMEOUT_MS: '1000',
      OPERATION_LEASE_MS: '4000',
      RECONCILER_ENABLED: 'false',
      RECONCILER_MIN_AGE_MS: '0',
      RETRY_BASE_DELAY_MS: '10',
      RETRY_MAX_DELAY_MS: '100',
      // The per pod limiter must not turn bursts of test requests into 429.
      THROTTLE_LIMIT: '10000',
    },
  },
});
