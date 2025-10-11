const { z } = require('zod');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const OPERATION_CATEGORIES = ['AUTH', 'READ', 'UPDATE'];
const DEFAULT_OPERATION_CATEGORY = 'READ';

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

class LogRecordValidationError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'LogRecordValidationError';
    this.statusCode = 500;
    this.issues = issues;
  }
}

const validateLogRecord = (input) => {
  const result = logRecordSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
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

module.exports = {
  DEFAULT_OPERATION_CATEGORY,
  HTTP_METHODS,
  LogRecordValidationError,
  OPERATION_CATEGORIES,
  logRecordSchema,
  validateLogRecord,
};
