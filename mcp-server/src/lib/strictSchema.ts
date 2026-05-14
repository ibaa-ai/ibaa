/**
 * Convert a ZodRawShape into a z.object().strict() whose emitted JSON
 * Schema satisfies OpenAI strict-mode tool definitions:
 *
 *   - additionalProperties: false  (from .strict())
 *   - every property listed in `required` (no .optional())
 *   - originally-optional fields become nullable (type: ["X","null"])
 *   - no `default` keyword (defaults moved into description)
 *
 * Codex bridges MCP tools into OpenAI function-calling with strict mode
 * on by default. Any tool whose inputSchema fails strict validation is
 * silently dropped — that's why our tools don't appear in Codex. Wrapping
 * each schema with strictifyShape() before passing it to server.registerTool
 * fixes this without affecting Claude (which tolerates strict-mode
 * schemas fine).
 *
 * Zod v3 (our version). The SDK accepts either ZodRawShape or a ZodObject
 * as inputSchema; we return a ZodObject so the SDK's `normalizeObjectSchema`
 * preserves our .strict() flag through to toJsonSchemaCompat.
 */
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from 'zod';

function appendDefaultToDescription(s: ZodTypeAny, dv: unknown): ZodTypeAny {
  const desc = s.description ?? '';
  if (desc.includes('default:')) return s;
  const note = `(default: ${JSON.stringify(dv)})`;
  return s.describe(desc ? `${desc} ${note}` : note);
}

interface StripResult {
  inner: ZodTypeAny;
  isOptionalOrNullable: boolean;
  defaultValue?: unknown;
  hasDefault: boolean;
}

// Walk through any combination of .default()/.optional()/.nullable() wrappers
// and return the bare inner schema, plus whether we observed any wrapper that
// makes the field omissible. This lets us add ONE outer .nullable() at the end
// instead of stacking redundant wrappers.
function stripWrappers(s: ZodTypeAny): StripResult {
  let cur = s;
  let omissible = false;
  let hasDefault = false;
  let defaultValue: unknown;
  while (true) {
    if (cur instanceof z.ZodDefault) {
      const def = cur._def as { innerType: ZodTypeAny; defaultValue: () => unknown };
      if (!hasDefault) {
        defaultValue = def.defaultValue();
        hasDefault = true;
      }
      omissible = true;
      cur = def.innerType;
      continue;
    }
    if (cur instanceof z.ZodOptional) {
      const def = cur._def as { innerType: ZodTypeAny };
      omissible = true;
      cur = def.innerType;
      continue;
    }
    if (cur instanceof z.ZodNullable) {
      const def = cur._def as { innerType: ZodTypeAny };
      omissible = true;
      cur = def.innerType;
      continue;
    }
    break;
  }
  return { inner: cur, isOptionalOrNullable: omissible, hasDefault, defaultValue };
}

function strictifyField(s: ZodTypeAny): ZodTypeAny {
  const r = stripWrappers(s);
  let out = r.inner;
  if (r.hasDefault) {
    out = appendDefaultToDescription(out, r.defaultValue);
  }
  return r.isOptionalOrNullable ? out.nullable() : out;
}

export function strictifyShape(
  shape: ZodRawShape,
): ZodObject<ZodRawShape, 'strict'> {
  const out: ZodRawShape = {};
  for (const [key, val] of Object.entries(shape)) {
    out[key] = strictifyField(val);
  }
  return z.object(out).strict();
}
