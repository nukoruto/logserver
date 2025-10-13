import { z } from 'zod';
import { toValidationIssues, type ValidationIssue } from '../validation/toValidationIssues';

export const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'DELETE']);
export type HttpMethod = z.infer<typeof HttpMethod>;
export const HTTP_METHODS = [...HttpMethod.options];

export const OperationCategory = z.enum(['AUTH', 'READ', 'UPDATE']);
export type OperationCategory = z.infer<typeof OperationCategory>;
export const OPERATION_CATEGORIES = [...OperationCategory.options];

export const DEFAULT_OPERATION_CATEGORY: OperationCategory = OperationCategory.enum.READ;

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

const latencySchema = z
  .number()
  .finite('latency_ms must be finite')
  .min(0, 'latency_ms must be greater than or equal to 0');

const responseBytesSchema = z
  .number()
  .int('response_bytes must be an integer')
  .min(0, 'response_bytes must be greater than or equal to 0');

export const logRecordSchema = z.object({
  timestamp_utc: z.string().datetime({ offset: true, message: 'timestamp_utc must be RFC 3339' }),
  method: HttpMethod,
  path: blankableString,
  referer: blankableString,
  user_agent: blankableString,
  uid: blankableString,
  session_id: blankableString,
  ip: blankableString,
  op_category: OperationCategory,
  status_code: statusCodeSchema.optional(),
  latency_ms: latencySchema.optional(),
  response_bytes: responseBytesSchema.optional(),
});

export type LogRecord = z.infer<typeof logRecordSchema>;

export type LogRecordIssue = ValidationIssue;

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
    const issues = toValidationIssues(result.error);
    throw new LogRecordValidationError('Invalid log record', issues);
  }
  return result.data;
};
