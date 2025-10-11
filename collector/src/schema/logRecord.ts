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
  .number({ invalid_type_error: 'status_code must be a number' })
  .int('status_code must be an integer')
  .min(100, 'status_code must be between 100 and 599')
  .max(599, 'status_code must be between 100 and 599');

const latencySchema = z
  .number({ invalid_type_error: 'latency_ms must be a number' })
  .finite('latency_ms must be finite')
  .min(0, 'latency_ms must be greater than or equal to 0');

const logRecordSchema = z.object({
  timestamp_utc: z.string().datetime({ offset: true, message: 'timestamp_utc must be RFC 3339' }),
  method: z.enum(HTTP_METHODS, {
    invalid_type_error: 'method must be a string',
    required_error: 'method is required',
  }),
  path: blankableString,
  referer: blankableString,
  user_agent: blankableString,
  uid: blankableString,
  session_id: blankableString,
  ip: blankableString,
  op_category: z.enum(OPERATION_CATEGORIES, {
    invalid_type_error: 'op_category must be a string',
    required_error: 'op_category is required',
  }),
  status_code: statusCodeSchema.optional(),
  latency_ms: latencySchema.optional(),
});

type LogRecord = z.infer<typeof logRecordSchema>;

type ValidationIssue = {
  path: (string | number)[];
  message: string;
  code?: string;
  expected?: unknown;
  received?: unknown;
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
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code,
      expected: issue.expected,
      received: issue.received,
    }));
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
