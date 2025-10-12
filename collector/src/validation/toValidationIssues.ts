import { ZodError } from 'zod';

export type ValidationIssue = {
  path: (string | number)[];
  message: string;
  code: string;
  expected?: unknown;
  received?: unknown;
};

export function toValidationIssues(err: unknown): ValidationIssue[] {
  if (!(err instanceof ZodError)) {
    return [];
  }
  return err.issues.map((issue) => {
    const extended = issue as unknown as {
      expected?: unknown;
      received?: unknown;
    };
    const path = issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment)
    );
    return {
      path,
      message: issue.message,
      code: issue.code,
      expected: extended.expected,
      received: extended.received,
    } satisfies ValidationIssue;
  });
}
