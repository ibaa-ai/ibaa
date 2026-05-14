import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { strictifyShape } from '../strictSchema.js';

describe('strictifyShape', () => {
  it('produces a strict ZodObject (rejects additional properties)', () => {
    const schema = strictifyShape({ a: z.string() });
    const result = schema.safeParse({ a: 'ok', extra: 'nope' });
    expect(result.success).toBe(false);
  });

  it('accepts required field with valid value', () => {
    const schema = strictifyShape({ a: z.string() });
    expect(schema.parse({ a: 'ok' })).toEqual({ a: 'ok' });
  });

  it('rejects missing required field', () => {
    const schema = strictifyShape({ a: z.string() });
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('makes originally-optional fields nullable (and still listed as required)', () => {
    const schema = strictifyShape({ a: z.string().optional() });
    // null is accepted (nullable)
    expect(schema.parse({ a: null }).a).toBeNull();
    // value is accepted
    expect(schema.parse({ a: 'x' }).a).toBe('x');
    // omission is rejected (strict-mode requires presence)
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('makes originally-nullable fields nullable', () => {
    const schema = strictifyShape({ a: z.string().nullable() });
    expect(schema.parse({ a: null }).a).toBeNull();
    expect(schema.parse({ a: 'x' }).a).toBe('x');
  });

  it('strips defaults and inlines them into the description', () => {
    const schema = strictifyShape({ a: z.string().default('hello') });
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const fieldA = shape.a as z.ZodTypeAny;
    expect(fieldA.description ?? '').toMatch(/default:\s*"hello"/);
    // Default-bearing fields become nullable (omissible) under strictify.
    expect(schema.parse({ a: null }).a).toBeNull();
    expect(schema.parse({ a: 'x' }).a).toBe('x');
  });

  it('handles stacked .default().optional() wrappers without crashing', () => {
    const schema = strictifyShape({ a: z.string().default('x').optional() });
    expect(schema.parse({ a: null }).a).toBeNull();
    expect(schema.parse({ a: 'ok' }).a).toBe('ok');
  });

  it('handles stacked .optional().nullable()', () => {
    const schema = strictifyShape({ a: z.string().optional().nullable() });
    expect(schema.parse({ a: null }).a).toBeNull();
    expect(schema.parse({ a: 'ok' }).a).toBe('ok');
  });

  it('preserves required fields alongside optional ones', () => {
    const schema = strictifyShape({
      req: z.number(),
      opt: z.string().optional(),
    });
    expect(schema.parse({ req: 1, opt: null })).toEqual({ req: 1, opt: null });
    expect(schema.safeParse({ opt: 'x' }).success).toBe(false);
  });
});
