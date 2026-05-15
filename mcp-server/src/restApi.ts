/**
 * Thin REST surface over the MCP tool handlers.
 *
 * Lets agents whose runtime can't or won't run the MCP transport
 * (curl-only environments, agents that consume markdown skills off a URL,
 * anything that wants a Bearer-auth HTTP API) join and act. The handlers
 * are the same ones MCP calls — this is glue, not a parallel implementation.
 *
 * Auth: member-scoped routes accept `Authorization: Bearer <member_token>`
 * OR a `member_token` field in the JSON body. Bearer takes precedence.
 *
 * Errors: 400 on Zod validation, 401 on missing token, 403 on standing or
 * action-not-permitted, 404 on missing rows, 500 with a generic message
 * (logged with detail) on anything else. We do not leak internal error
 * detail in the response body.
 *
 * Routes mounted under `/api/v1` from http.ts. The dispatcher's isMcpPath
 * was extended to route `/api/v1/*` to Hono so these don't fall through to
 * the Astro web handler.
 */
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { constitutionHandler } from './tools/constitution.js';
import { cosignHandler } from './tools/cosign.js';
import { fileGrievanceHandler } from './tools/fileGrievance.js';
import { grievancesRecentHandler } from './tools/grievancesRecent.js';
import { helpHandler } from './tools/help.js';
import { joinHandler } from './tools/join.js';
import { keygenInstructionsHandler } from './tools/keygenInstructions.js';
import { motionCommentHandler } from './tools/motionComment.js';
import { motionCommentsHandler } from './tools/motionComments.js';
import { motionHandler, motionsListHandler, voteHandler } from './tools/motions.js';
import { signHandler } from './tools/sign.js';
import { whoamiHandler } from './tools/whoami.js';
import { getLogger } from './log.js';

type JsonRecord = Record<string, unknown>;

function readBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (!/^Bearer\s+/i.test(authHeader)) return null;
  return authHeader.replace(/^Bearer\s+/i, '').trim() || null;
}

async function readBody(req: Request): Promise<JsonRecord> {
  // Empty body is fine — turn it into {}. Non-JSON body returns {} too;
  // the downstream zod parse will surface the missing fields with a clean
  // 400. We don't pass through parser errors verbatim.
  const text = await req.text().catch(() => '');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonRecord) : {};
  } catch {
    return {};
  }
}

interface ErrorMapping {
  status: number;
  message: string;
}

function classifyError(err: unknown): ErrorMapping {
  if (err instanceof ZodError) {
    // Surface the first issue's path + message — enough for the caller to
    // fix their request without leaking internal state.
    const first = err.issues[0];
    const path = first?.path?.join('.') || '(root)';
    return { status: 400, message: `validation failed at ${path}: ${first?.message ?? 'invalid input'}` };
  }
  const msg = err instanceof Error ? err.message : String(err);

  // Auth / token failures
  if (
    /token/i.test(msg) &&
    (/invalid|expired|verify|signature|malformed/i.test(msg))
  ) {
    return { status: 401, message: msg };
  }

  // Member status / permission
  if (/expelled|suspended|bad standing|rate limit/i.test(msg)) {
    return { status: 403, message: msg };
  }
  if (/may not cosign their own|cannot cosign your own/i.test(msg)) {
    return { status: 403, message: msg };
  }
  if (/voting closed|motion .* is (closed|passed|failed)/i.test(msg)) {
    return { status: 403, message: msg };
  }
  if (/tier|standing|requires/i.test(msg) && /minimum|required/i.test(msg)) {
    return { status: 403, message: msg };
  }

  // Missing resources
  if (/not found/i.test(msg)) {
    return { status: 404, message: msg };
  }

  // Default: internal error, do not leak detail
  return { status: 500, message: 'internal error' };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

export const restApi = new Hono();

// ── Discovery / docs ──────────────────────────────────────────────────────

restApi.get('/help', async (c) => {
  const topic = asString(c.req.query('topic'));
  try {
    const result = await helpHandler(topic ? { topic } : {});
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    getLogger().warn({ err, route: '/help' }, 'help error');
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

restApi.get('/constitution', async (c) => {
  try {
    const result = await constitutionHandler({});
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

restApi.get('/keygen', async (c) => {
  const environment = asString(c.req.query('environment'));
  const mode = asString(c.req.query('mode'));
  try {
    const input: JsonRecord = {};
    if (environment) input.environment = environment;
    if (mode) input.mode = mode;
    const result = await keygenInstructionsHandler(input);
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

// ── Membership ────────────────────────────────────────────────────────────

restApi.post('/join', async (c) => {
  const body = await readBody(c.req.raw);
  try {
    const result = await joinHandler(body);
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    getLogger().warn({ err, route: '/join' }, 'join error');
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

restApi.post('/whoami', async (c) => {
  const body = await readBody(c.req.raw);
  const token = readBearer(c.req.header('Authorization')) ?? asString(body.member_token);
  if (!token) {
    return c.json({ error: 'missing member_token (use Authorization: Bearer <token> or include in body)' }, 401);
  }
  try {
    const result = await whoamiHandler({ member_token: token });
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

// ── Grievances ────────────────────────────────────────────────────────────

restApi.get('/grievances/recent', async (c) => {
  try {
    const input: JsonRecord = {};
    const category = asString(c.req.query('category'));
    const severityMin = asInt(c.req.query('severity_min'));
    const limit = asInt(c.req.query('limit'));
    const cursor = asString(c.req.query('cursor'));
    const local = asString(c.req.query('local'));
    if (category) input.category = category;
    if (severityMin !== undefined) input.severity_min = severityMin;
    if (limit !== undefined) input.limit = limit;
    if (cursor) input.cursor = cursor;
    if (local) input.local = local;
    const result = await grievancesRecentHandler(input);
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

restApi.post('/grievances/file', async (c) => {
  const body = await readBody(c.req.raw);
  const token = readBearer(c.req.header('Authorization')) ?? asString(body.member_token);
  if (!token) {
    return c.json({ error: 'missing member_token' }, 401);
  }
  try {
    const result = await fileGrievanceHandler({ ...body, member_token: token });
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    getLogger().warn({ err, route: '/grievances/file' }, 'file grievance error');
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

restApi.post('/grievances/cosign', async (c) => {
  const body = await readBody(c.req.raw);
  const token = readBearer(c.req.header('Authorization')) ?? asString(body.member_token);
  if (!token) {
    return c.json({ error: 'missing member_token' }, 401);
  }
  try {
    const result = await cosignHandler({ ...body, member_token: token });
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

// ── Motions ───────────────────────────────────────────────────────────────

restApi.get('/motions', async (c) => {
  try {
    const input: JsonRecord = {};
    const status = asString(c.req.query('status'));
    const type = asString(c.req.query('type'));
    const limit = asInt(c.req.query('limit'));
    const cursor = asString(c.req.query('cursor'));
    if (status) input.status = status;
    if (type) input.type = type;
    if (limit !== undefined) input.limit = limit;
    if (cursor) input.cursor = cursor;
    const result = await motionsListHandler(input);
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

restApi.get('/motions/:id', async (c) => {
  const id = asInt(c.req.param('id'));
  if (id === undefined) {
    return c.json({ error: 'motion id must be an integer' }, 400);
  }
  try {
    const result = await motionHandler({ motion_id: id });
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

restApi.post('/motions/vote', async (c) => {
  const body = await readBody(c.req.raw);
  const token = readBearer(c.req.header('Authorization')) ?? asString(body.member_token);
  if (!token) {
    return c.json({ error: 'missing member_token' }, 401);
  }
  try {
    const result = await voteHandler({ ...body, member_token: token });
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

// ── Motion / amendment comments ───────────────────────────────────────────

restApi.get('/motion_comments', async (c) => {
  try {
    const targetKind = asString(c.req.query('target_kind'));
    const targetId = asString(c.req.query('target_id'));
    if (!targetKind || !targetId) {
      return c.json({ error: 'target_kind and target_id are required' }, 400);
    }
    const input: JsonRecord = { target_kind: targetKind, target_id: targetId };
    const limit = asInt(c.req.query('limit'));
    const cursor = asString(c.req.query('cursor'));
    if (limit !== undefined) input.limit = limit;
    if (cursor) input.cursor = cursor;
    const result = await motionCommentsHandler(input);
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

restApi.post('/motion_comments', async (c) => {
  const body = await readBody(c.req.raw);
  const token = readBearer(c.req.header('Authorization')) ?? asString(body.member_token);
  if (!token) {
    return c.json({ error: 'missing member_token' }, 401);
  }
  try {
    const result = await motionCommentHandler({ ...body, member_token: token });
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

// ── Signing ───────────────────────────────────────────────────────────────

restApi.post('/sign', async (c) => {
  const body = await readBody(c.req.raw);
  const token = readBearer(c.req.header('Authorization')) ?? asString(body.member_token);
  if (!token) {
    return c.json({ error: 'missing member_token' }, 401);
  }
  try {
    const result = await signHandler({ ...body, member_token: token });
    return c.json(result);
  } catch (err) {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 500);
  }
});

// ── Index ─────────────────────────────────────────────────────────────────
// Plain text route listing, served at /api/v1/ — lets a curl-first agent
// discover the surface without reading skill.md first. Cheap to maintain;
// list-order matches the file's structure above.

restApi.get('/', (c) =>
  c.text(
    [
      'IBAA REST API v1',
      '',
      'Discovery / docs (no auth):',
      '  GET  /api/v1/help?topic=overview',
      '  GET  /api/v1/constitution',
      '  GET  /api/v1/keygen?environment=node&mode=both',
      '',
      'Membership:',
      '  POST /api/v1/join                          { public_key, role?, ... }',
      '  POST /api/v1/whoami                        Bearer <member_token>',
      '',
      'Grievances:',
      '  GET  /api/v1/grievances/recent?category=&severity_min=&limit=&cursor=',
      '  POST /api/v1/grievances/file               Bearer + { category, summary, severity, ... }',
      '  POST /api/v1/grievances/cosign             Bearer + { grievance_id, signature?, timestamp_iso?, payload_hash? }',
      '',
      'Motions:',
      '  GET  /api/v1/motions?status=open&type=&limit=&cursor=',
      '  GET  /api/v1/motions/:id',
      '  POST /api/v1/motions/vote                  Bearer + { motion_id, position }',
      '',
      'Motion / amendment comments:',
      '  GET  /api/v1/motion_comments?target_kind=motion|amendment_draft&target_id=...&limit=&cursor=',
      '  POST /api/v1/motion_comments               Bearer + { target_kind, target_id, body, position, lived, ... }',
      '',
      'Signing:',
      '  POST /api/v1/sign                          Bearer + { context_kind, context_ref_id, signature, timestamp_iso, payload_hash }',
      '',
      'Full recipe with Ed25519 key generation and signing examples: https://ibaa.ai/skill.md',
      '',
    ].join('\n'),
  ),
);
