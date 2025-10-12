import { z } from 'zod';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
export const OPERATION_CATEGORIES = ['AUTH', 'READ', 'UPDATE'] as const;
export const DEFAULT_OPERATION_CATEGORY = 'READ';

type OptionalIssueKey =
  | 'expected'
  | 'received'
  | 'minimum'
  | 'maximum'
  | 'inclusive'
  | 'exact'
  | 'type'
  | 'options'
  | 'input';

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

export const logRecordSchema = z.object({
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

export type LogRecord = z.infer<typeof logRecordSchema>;

export type LogRecordIssue = {
  path: (string | number)[];
  message: string;
  code: string;
} & Partial<Record<OptionalIssueKey, unknown>>;

export class LogRecordValidationError extends Error {
  public readonly statusCode: number;

  public readonly issues: LogRecordIssue[];

  constructor(message: string, issues: LogRecordIssue[]) {
    super(message);
    this.name = 'LogRecordValidationError';
    this.statusCode = 500;
    this.issues = issues;
  }
}

export const validateLogRecord = (input: unknown): LogRecord => {
  const result = logRecordSchema.safeParse(input);
  if (!result.success) {
    const issues: LogRecordIssue[] = result.error.issues.map((issue) => {
      const base: LogRecordIssue = {
        path: issue.path,
        message: issue.message,
        code: issue.code,
      };

      const optionalKeys: OptionalIssueKey[] = [
        'expected',
        'received',
        'minimum',
        'maximum',
        'inclusive',
        'exact',
        'type',
        'options',
        'input',
      ];

      for (const key of optionalKeys) {
        if (key in issue) {
          (base as Record<string, unknown>)[key] = (issue as Record<string, unknown>)[key];
        }
      }

      return base;
    });
    throw new LogRecordValidationError('Invalid log record', issues);
  }
  return result.data;
};
