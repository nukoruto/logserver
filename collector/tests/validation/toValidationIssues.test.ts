import { z } from 'zod';
import { toValidationIssues } from '../../src/validation/toValidationIssues';

describe('toValidationIssues', () => {
  it('converts ZodError issues into ValidationIssue array', () => {
    const schema = z.object({
      value: z.string(),
    });
    const result = schema.safeParse({ value: 42 });
    if (result.success) {
      throw new Error('expected schema to fail');
    }

    const issues = toValidationIssues(result.error);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ['value'],
      code: 'invalid_type',
    });
    expect(issues[0].message).toContain('string');
    expect(issues[0].expected).toBeDefined();
  });

  it('returns empty array when input is not a ZodError', () => {
    const issues = toValidationIssues(new Error('boom'));
    expect(issues).toEqual([]);
  });
});
