import { Value } from '@sinclair/typebox/value';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { DbHandle } from './db/client.js';
import { ingestWebhook } from './ingestion.js';
import { computeFfr } from './reporting.js';
import { CiWebhookBody, FfrQuery } from './schemas.js';
import { timingSafeStringEqual, verifySignature } from './security.js';

export type BuildAppOptions = {
  config: AppConfig;
  dbHandle: DbHandle;
};

/** Max accepted webhook body size (1 MB). */
const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Build the Fastify app with all routes wired. The DB handle is injected so
 * tests and the server entrypoint share one construction path.
 */
export function buildApp({ config, dbHandle }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: BODY_LIMIT_BYTES,
  });

  const { db } = dbHandle;

  // Capture the RAW body for the JSON content type so HMAC is computed over the
  // exact bytes the client signed. We still parse JSON ourselves afterward.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    // Stash raw bytes on the request for signature verification.
    (req as { rawBody?: Buffer }).rawBody = body;
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      done(null, parsed);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  // --- Health ---
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ready' };
    } catch (err) {
      app.log.error({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // --- Ingestion (write boundary, untrusted) ---
  app.post('/webhooks/ci', async (req, reply) => {
    const rawBody = (req as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);

    // 1. Verify HMAC over the raw bytes BEFORE trusting any parsed content.
    const signatureHeader = req.headers['x-signature-256'];
    if (!verifySignature(config.ingestSigningSecret, rawBody, signatureHeader)) {
      req.log.warn({ route: '/webhooks/ci', result: 'reject', reason: 'bad_signature' });
      return reply.code(401).send({ error: 'invalid or missing signature' });
    }

    // 2. Validate the parsed body against the strict schema.
    const candidate = req.body;
    if (!Value.Check(CiWebhookBody, candidate)) {
      const firstError = [...Value.Errors(CiWebhookBody, candidate)][0];
      const message = firstError
        ? `${firstError.path || '/'} ${firstError.message}`
        : 'invalid payload';
      req.log.warn({ route: '/webhooks/ci', result: 'reject', reason: 'invalid_payload', message });
      return reply.code(400).send({ error: message });
    }
    const payload = candidate as CiWebhookBody;

    // 3. Persist idempotently.
    const result = await ingestWebhook(db, payload);
    if (result.status === 'duplicate') {
      req.log.info({
        route: '/webhooks/ci',
        result: 'duplicate',
        provider: payload.provider,
        externalRunId: payload.externalRunId,
        runId: result.runId,
      });
      return reply.code(200).send({ status: 'duplicate', runId: result.runId });
    }

    req.log.info({
      route: '/webhooks/ci',
      result: 'accepted',
      provider: payload.provider,
      externalRunId: payload.externalRunId,
      runId: result.runId,
      testCount: payload.tests.length,
    });
    return reply.code(202).send({ status: 'accepted', runId: result.runId });
  });

  // --- Read API ---
  app.get('/reports/ffr', async (req, reply) => {
    // Deny-by-default bearer auth, timing-safe.
    const auth = req.headers.authorization;
    const expected = `Bearer ${config.readApiToken}`;
    if (typeof auth !== 'string' || !timingSafeStringEqual(auth, expected)) {
      req.log.warn({ route: '/reports/ffr', result: 'reject', reason: 'unauthorized' });
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Query strings arrive as strings; coerce to the schema's types first.
    const query = Value.Convert(FfrQuery, req.query);
    if (!Value.Check(FfrQuery, query)) {
      return reply.code(400).send({ error: 'invalid query parameters' });
    }
    const windowDays = (query as FfrQuery).windowDays ?? config.ffrWindowDays;

    const report = await computeFfr(db, windowDays);
    req.log.info({ route: '/reports/ffr', windowDays, ffr: report.ffr });
    return reply.code(200).send(report);
  });

  return app;
}
