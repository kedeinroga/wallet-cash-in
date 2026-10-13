import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Application } from 'express';
import { apiReference } from '@scalar/nestjs-api-reference';
import { AppConfigService } from './config/app-config.service.js';
import { TRACE_ID_HEADER } from './shared/api/middleware/logger.middleware.js';
import { validationExceptionFactory } from './shared/api/validation/validation-exception.factory.js';

/** HTTP setup shared by main.ts and the e2e tests. */
export function setupApp(app: INestApplication): INestApplication {
  const config = app.get(AppConfigService);

  // No 304 Not Modified on dynamic JSON (see NoStoreMiddleware).
  (app.getHttpAdapter().getInstance() as Application).set('etag', false);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.enableCors({
    origin: config.corsAllowedOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: ['Content-Type', 'Idempotency-Key', TRACE_ID_HEADER],
    exposedHeaders: [TRACE_ID_HEADER],
  });
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    setupApiDocs(app, config);
  }
  return app;
}

/**
 * API docs from the same OpenAPI document (off in production by default):
 * - /reference  Scalar: interactive client to try requests from the browser
 * - /docs       Swagger UI
 * - /docs-json  raw OpenAPI document (import it in Postman, Insomnia or Bruno)
 */
function setupApiDocs(app: INestApplication, config: AppConfigService): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Wallet Cash-In')
      .setDescription(
        'Send `x-trace-id` to follow a request through the logs.',
      )
      .setVersion('1.0')
      .addServer(`http://localhost:${config.port}`, 'Local')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
  app.use(
    '/reference',
    apiReference({
      content: document,
      pageTitle: 'Wallet Cash-In API',
    }),
  );
}
