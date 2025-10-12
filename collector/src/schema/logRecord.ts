import { z, type ZodIssue } from 'zod';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
export const OPERATION_CATEGORIES = ['AUTH', 'READ', 'UPDATE'] as const;
export const DEFAULT_OPERATION_CATEGORY = 'READ';

type HttpMethod = (typeof HTTP_METHODS)[number];
type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

type IssueOptionalKeys =
  | 'expected'
  | 'received'
  | 'minimum'
  | 'maximum'
  | 'inclusive'
  | 'exact'
  | 'type'
  | 'options'
  | 'input';

export type LogRecordIssueDetail = {
  path: (string | number)[];
  message: string;
  code: ZodIssue['code'];
} & Partial<Record<IssueOptionalKeys, unknown>>;

const blankableString = z
  .union([z.string(), z.undefined(), z.null()])
  .transform((value) => {
    if (typeof value !== 'string') {
      return '';
    }
    return value.trim();
  });

const statusCodeSchema = z.number().int().min(100).max(599);

const latencySchema = z.number().finite().min(0);

export const logRecordSchema = z.object({
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

export type LogRecord = z.infer<typeof logRecordSchema> & {
  method: HttpMethod;
  op_category: OperationCategory;
};

export class LogRecordValidationError extends Error {
  public readonly statusCode: number;

  public readonly issues: LogRecordIssueDetail[];

  constructor(message: string, issues: LogRecordIssueDetail[]) {
    super(message);
    this.name = 'LogRecordValidationError';
    this.statusCode = 500;
    this.issues = issues;
  }
}

const OPTIONAL_KEYS: readonly IssueOptionalKeys[] = [
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

const mapIssue = (issue: ZodIssue): LogRecordIssueDetail => {
  const normalizePath = (path: ZodIssue['path']): (string | number)[] =>
    path.map((segment) => {
      if (typeof segment === 'number' || typeof segment === 'string') {
        return segment;
      }
      return String(segment);
    });

  const base: LogRecordIssueDetail = {
    path: normalizePath(issue.path),
    message: issue.message,
    code: issue.code,
  };

  const issueRecord = issue as unknown as Record<string, unknown>;
  for (const key of OPTIONAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(issue, key)) {
      base[key] = issueRecord[key];
    }
  }

  return base;
};

export const validateLogRecord = (input: unknown): LogRecord => {
  const result = logRecordSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => mapIssue(issue));
    throw new LogRecordValidationError('Invalid log record', issues);
  }
  return result.data;
};
