import { FormatRegistry, type Static, Type } from '@sinclair/typebox';

/**
 * Strict request/response schemas. `additionalProperties: false` everywhere on
 * the write boundary so we reject unexpected fields instead of silently
 * accepting them.
 */

// TypeBox does not ship format validators; register the ones we use so
// Value.Check actually enforces `format: 'date-time'` rather than failing on it.
// We accept any value parseable by Date (ISO-8601 in practice).
if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (value) => {
    if (typeof value !== 'string') {
      return false;
    }
    const ts = Date.parse(value);
    return Number.isFinite(ts);
  });
}

export const TestResultInput = Type.Object(
  {
    identity: Type.String({ minLength: 1, maxLength: 1024 }),
    outcome: Type.Union([Type.Literal('passed'), Type.Literal('failed')]),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const CiWebhookBody = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 256 }),
    externalRunId: Type.String({ minLength: 1, maxLength: 256 }),
    commitSha: Type.String({ minLength: 1, maxLength: 256 }),
    status: Type.Union([Type.Literal('passed'), Type.Literal('failed')]),
    attempt: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
    startedAt: Type.String({ format: 'date-time', minLength: 1 }),
    completedAt: Type.String({ format: 'date-time', minLength: 1 }),
    tests: Type.Array(TestResultInput, { maxItems: 50_000 }),
  },
  { additionalProperties: false },
);

export type CiWebhookBody = Static<typeof CiWebhookBody>;

export const FfrQuery = Type.Object(
  {
    windowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
  },
  { additionalProperties: false },
);

export type FfrQuery = Static<typeof FfrQuery>;
