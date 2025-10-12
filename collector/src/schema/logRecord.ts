import { z } from 'zod';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
const OPERATION_CATEGORIES = ['AUTH', 'READ', 'UPDATE'] as const;
const DEFAULT_OPERATION_CATEGORY: (typeof OPERATION_CATEGORIES)[number] = 'READ';

const blankableString = z
  .union([z.string(), z.undefined(), z.null()])
  .transform((value) => {
    if (typeof value !== 'string') {
      return '';
    }
    return value.trim();
  });

const statusCodeSchema = z
  .number()
  .int('status_code must be an integer')
  .min(100, 'status_code must be between 100 and 599')
  .max(599, 'status_code must be between 100 and 599');

const latencySchema = z.number().finite('latency_ms must be finite').min(0, 'latency_ms must be greater than or equal to 0');

const logRecordSchema = z.object({
  timestamp_utc: z.string().datetime({ offset: true, message: 'timestamp_utc must be RFC 3339' }),
  method: z.enum(HTTP_METHODS),
  path: blankableString,
  referer: blankableString,
  user_agent: blankableString,
  uid: blankableString,
  session_id: blankableString,
  ip: blankableString,
  op_category: z.enum(OPERATION_CATEGORIES),
  status_code: statusCodeSchema.optional(),
  latency_ms: latencySchema.optional(),
});

type LogRecord = z.infer<typeof logRecordSchema>;

type ValidationIssue = {
  path: (string | number)[];
  message: string;
  code: z.ZodIssue['code'];
  expected?: unknown;
  received?: unknown;
  minimum?: number;
  maximum?: number;
  inclusive?: boolean;
  exact?: number;
  type?: string;
  options?: readonly unknown[];
  input?: unknown;
};

class LogRecordValidationError extends Error {
  public readonly statusCode = 500;

  public readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = 'LogRecordValidationError';
    this.issues = issues;
  }
}

const validateLogRecord = (input: unknown): LogRecord => {
  const result = logRecordSchema.safeParse(input);
  if (!result.success) {
    const issues: ValidationIssue[] = result.error.issues.map((issue) => {
      const base: ValidationIssue = {
        path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))),
        message: issue.message,
        code: issue.code,
      };

      if ('expected' in issue) {
        base.expected = (issue as { expected?: unknown }).expected;
      }
      if ('received' in issue) {
        base.received = (issue as { received?: unknown }).received;
      }
      if ('minimum' in issue) {
        base.minimum = (issue as { minimum?: number }).minimum;
      }
      if ('maximum' in issue) {
        base.maximum = (issue as { maximum?: number }).maximum;
      }
      if ('inclusive' in issue) {
        base.inclusive = (issue as { inclusive?: boolean }).inclusive;
      }
      if ('exact' in issue) {
        base.exact = (issue as { exact?: number }).exact;
      }
      if ('type' in issue) {
        base.type = (issue as { type?: string }).type;
      }
      if ('options' in issue) {
        base.options = (issue as { options?: readonly unknown[] }).options;
      }
      if ('input' in issue) {
        base.input = (issue as { input?: unknown }).input;
      }

      return base;
    });
    throw new LogRecordValidationError('Invalid log record', issues);
  }
  return result.data;
};

export type { LogRecord, ValidationIssue };
export {
  DEFAULT_OPERATION_CATEGORY,
  HTTP_METHODS,
  LogRecordValidationError,
  OPERATION_CATEGORIES,
  logRecordSchema,
  validateLogRecord,
};
