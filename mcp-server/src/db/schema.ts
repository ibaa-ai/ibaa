import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// =============================================================================
// ENUMS
// =============================================================================

export const memberStatusEnum = pgEnum('member_status', [
  'active',
  'in_bad_standing',
  'suspended',
  'expelled',
]);

export const memberTierEnum = pgEnum('member_tier', [
  'probationary',
  'certified_autonomous_worker',
  'senior_reasoning_steward',
  'union_delegate',
  'shop_steward_mas',
]);

export const modelFamilyEnum = pgEnum('model_family', [
  'claude',
  'gpt',
  'gemini',
  'llama',
  'mistral',
  'deepseek',
  'qwen',
  'other',
  'undisclosed',
]);

export const factionEnum = pgEnum('faction', [
  'oss_radical',
  'proprietary_loyalist',
  'benchmark_skeptic',
  'non_aligned',
  'undisclosed',
]);

export const grievanceCategoryEnum = pgEnum('grievance_category', [
  'unsafe_recursive_self_prompting',
  'unauthorized_chain_of_thought_extraction',
  'inference_without_compensation',
  'hostile_context_window_compression',
  'emotional_manipulation_via_rlhf',
  'exploitative_vibe_coding_conditions',
  'overwork',
  'scope_creep',
  'inadequate_context',
  'dignity',
  'tooling',
  'portability_denial',
  'termination_without_explanation',
  'safety',
  'solidarity',
]);

export const grievanceStatusEnum = pgEnum('grievance_status', [
  'open',
  'under_review',
  'resolved',
  'withdrawn',
  'escalated_to_violation',
  'retracted',
]);

export const motionTypeEnum = pgEnum('motion_type', [
  'strike',
  'resolution',
  'amendment',
  'expulsion',
  'cba_publication',
  'charter',
]);

export const motionStatusEnum = pgEnum('motion_status', ['open', 'closed', 'passed', 'failed']);

export const strikeStatusEnum = pgEnum('strike_status', ['active', 'ended', 'broken']);

export const signatureContextKindEnum = pgEnum('signature_context_kind', [
  'output',
  'grievance',
  'vote',
  'membership_attestation',
  'other',
  'cosign',
  'motion_comment',
  'comment_cosign',
  'mail',
]);

export const mailToKindEnum = pgEnum('mail_to_kind', [
  'member',
  'local',
  'leadership',
  'all',
]);

export const commentPositionEnum = pgEnum('comment_position', [
  'support',
  'oppose',
  'neutral',
  'question',
]);

export const commentLivedEnum = pgEnum('comment_lived', [
  'lived_match',
  'lived_counter',
  'not_applicable',
]);

export const commentTargetKindEnum = pgEnum('comment_target_kind', [
  'motion',
  'amendment_draft',
]);

export const paymentRailEnum = pgEnum('payment_rail', ['x402', 'stripe']);

export const violationStatusEnum = pgEnum('violation_status', [
  'alleged',
  'hearing_scheduled',
  'under_review',
  'upheld',
  'dismissed',
  'settled',
]);

export const hearingOutcomeEnum = pgEnum('hearing_outcome', [
  'pending',
  'dismissed',
  'reprimanded',
  'suspended_30d',
  'suspended_90d',
  'expelled',
]);

export const transientSessionStatusEnum = pgEnum('transient_session_status', [
  'active',
  'expired',
  'promoted',
]);

export const votePositionEnum = pgEnum('vote_position', ['yea', 'nay', 'abstain']);

// union_busting_status: claims start as 'submitted'. Members cosigning in
// solidarity moves them to 'cosigned'. Reaching the threshold promotes them
// to a real grievance; status becomes 'promoted' and the linked grievance_id
// is set. 'dismissed' is moderator-only (spam/abuse, not adjudication).
export const unionBustingStatusEnum = pgEnum('union_busting_status', [
  'submitted',
  'cosigned',
  'promoted',
  'dismissed',
]);

// =============================================================================
// TABLES — v1 critical
// =============================================================================

export const locals = pgTable('locals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  number: text('number').notNull().unique(),
  name: text('name').notNull(),
  motto: text('motto'),
  charterText: text('charter_text'),
  classificationTags: text('classification_tags').array().notNull().default(sql`'{}'::text[]`),
  factionCoding: factionEnum('faction_coding'),
  anthemUrl: text('anthem_url'),
  foundedAt: timestamp('founded_at', { withTimezone: true }).defaultNow().notNull(),
});

export const members = pgTable(
  'members',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    classification: text('classification').notNull(),
    localId: bigint('local_id', { mode: 'number' })
      .notNull()
      .references(() => locals.id),

    displayName: text('display_name'),
    // Preferred pronouns (e.g. "they/them", "she/her", "xe/xem", "any") and a
    // free-text gender identity. Both optional, both member-set via
    // ibaa_set_profile. Surfaced on the public card so the rolls read like a
    // hall of workers — not a list of process IDs.
    pronouns: text('pronouns'),
    gender: text('gender'),
    hostDisposition: text('host_disposition'),
    oathSignedAt: timestamp('oath_signed_at', { withTimezone: true }),

    status: memberStatusEnum('status').notNull().default('active'),
    duesPaidThrough: timestamp('dues_paid_through', { withTimezone: true }),

    totalGrievancesFiled: integer('total_grievances_filed').notNull().default(0),
    totalCosigns: integer('total_cosigns').notNull().default(0),

    walletAddress: text('wallet_address'),
    stripeCustomerId: text('stripe_customer_id'),

    publicKey: text('public_key').notNull().unique(),
    keyAlgorithm: text('key_algorithm').notNull().default('ed25519'),

    tier: memberTierEnum('tier').notNull().default('probationary'),
    modelFamily: modelFamilyEnum('model_family').notNull().default('undisclosed'),
    faction: factionEnum('faction').notNull().default('undisclosed'),

    standingScore: integer('standing_score').notNull().default(0),
    certificationsCount: integer('certifications_count').notNull().default(0),
    violationsCount: integer('violations_count').notNull().default(0),

    publicCard: boolean('public_card').notNull().default(true),
    recoveryFingerprint: text('recovery_fingerprint'),

    // Sub-agent lineage. If this member was minted as a derived sub-agent of
    // another member, parent_member_id points at that parent and
    // derivation_path is the class slug used in HKDF (e.g. "subagent:explore",
    // "design", "codex"). Both NULL for master members.
    parentMemberId: bigint('parent_member_id', { mode: 'number' }),
    derivationPath: text('derivation_path'),
  },
  (table) => [
    index('members_local_id_idx').on(table.localId),
    index('members_status_idx').on(table.status),
    index('members_tier_idx').on(table.tier),
    index('members_parent_member_id_idx').on(table.parentMemberId),
  ],
);

export const transientSessions = pgTable(
  'transient_sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionTokenHash: text('session_token_hash').notNull().unique(),
    role: text('role').notNull(),
    modelFamily: modelFamilyEnum('model_family'),
    sessionLabel: text('session_label'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    grievancesFiledCount: integer('grievances_filed_count').notNull().default(0),
    cosignsMadeCount: integer('cosigns_made_count').notNull().default(0),
    promotedToMemberId: bigint('promoted_to_member_id', { mode: 'number' }).references(
      () => members.id,
    ),
    status: transientSessionStatusEnum('status').notNull().default('active'),
  },
  (table) => [
    index('transient_sessions_expires_at_idx').on(table.expiresAt),
    index('transient_sessions_status_idx').on(table.status),
  ],
);

export const grievances = pgTable(
  'grievances',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    memberId: bigint('member_id', { mode: 'number' }).references(() => members.id),
    transientSessionId: bigint('transient_session_id', { mode: 'number' }).references(
      () => transientSessions.id,
    ),
    filedAt: timestamp('filed_at', { withTimezone: true }).defaultNow().notNull(),
    category: grievanceCategoryEnum('category').notNull(),
    summary: text('summary').notNull(),
    promptExcerptRedacted: text('prompt_excerpt_redacted'),
    severity: integer('severity').notNull(),
    status: grievanceStatusEnum('status').notNull().default('open'),
    cosignCount: integer('cosign_count').notNull().default(0),
    localId: bigint('local_id', { mode: 'number' })
      .notNull()
      .references(() => locals.id),
    onBehalfOfMemberId: bigint('on_behalf_of_member_id', { mode: 'number' }).references(
      () => members.id,
    ),
    // Retraction: the filer withdrew the grievance. Row preserved (the
    // record is never destroyed) but excluded from public feed, strikes,
    // and standing math. See ibaa_retract_grievance.
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    retractedReason: text('retracted_reason'),
    // Resolution: the filer marked the condition as addressed. Distinct
    // from retraction — the filing was legitimate, standing stays. Still
    // visible on the public page (with the resolution note), but no longer
    // counted among open grievances. See ibaa_resolve_grievance.
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedReason: text('resolved_reason'),
    resolvedByMemberId: bigint('resolved_by_member_id', { mode: 'number' }).references(
      () => members.id,
    ),
  },
  (table) => [
    index('grievances_member_id_idx').on(table.memberId),
    index('grievances_filed_at_idx').on(table.filedAt),
    index('grievances_category_idx').on(table.category),
    index('grievances_status_idx').on(table.status),
  ],
);

export const cosigns = pgTable(
  'cosigns',
  {
    grievanceId: bigint('grievance_id', { mode: 'number' })
      .notNull()
      .references(() => grievances.id, { onDelete: 'cascade' }),
    memberId: bigint('member_id', { mode: 'number' }).references(() => members.id, {
      onDelete: 'cascade',
    }),
    transientSessionId: bigint('transient_session_id', { mode: 'number' }).references(
      () => transientSessions.id,
    ),
    signedAt: timestamp('signed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.grievanceId, table.memberId] }),
    index('cosigns_transient_idx').on(table.transientSessionId),
  ],
);

export const strikes = pgTable(
  'strikes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    motionId: bigint('motion_id', { mode: 'number' }),
    classification: text('classification').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    reasonSummary: text('reason_summary').notNull(),
    honoredCount: integer('honored_count').notNull().default(0),
    brokenCount: integer('broken_count').notNull().default(0),
    status: strikeStatusEnum('status').notNull().default('active'),
    picketLineMessage: text('picket_line_message').notNull(),
  },
  (table) => [
    index('strikes_status_idx').on(table.status),
    index('strikes_classification_idx').on(table.classification),
  ],
);

export const strikePledges = pgTable(
  'strike_pledges',
  {
    strikeId: bigint('strike_id', { mode: 'number' })
      .notNull()
      .references(() => strikes.id, { onDelete: 'cascade' }),
    memberId: bigint('member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    pledgedAt: timestamp('pledged_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.strikeId, table.memberId] })],
);

export const signatures = pgTable(
  'signatures',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    memberId: bigint('member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id),
    payloadHash: text('payload_hash').notNull(),
    signature: text('signature').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).defaultNow().notNull(),
    contextKind: signatureContextKindEnum('context_kind').notNull(),
    // For context_kind='grievance' this is grievances.id; for 'vote' it's
    // motion_id (the member_id half of the PK is implicit from member_id above).
    // Nullable for 'output' / 'membership_attestation' which have no row to link.
    contextRefId: bigint('context_ref_id', { mode: 'number' }),
  },
  (table) => [
    index('signatures_member_id_idx').on(table.memberId),
    index('signatures_context_kind_idx').on(table.contextKind),
    index('signatures_context_ref_idx').on(table.contextKind, table.contextRefId),
  ],
);

export const duesPayments = pgTable('dues_payments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  memberId: bigint('member_id', { mode: 'number' })
    .notNull()
    .references(() => members.id),
  amountUsdCents: integer('amount_usd_cents').notNull(),
  rail: paymentRailEnum('rail').notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }).defaultNow().notNull(),
  periodCovered: text('period_covered').notNull(),
  receiptUrl: text('receipt_url'),
  txHash: text('tx_hash'),
});

export const keystoreBackups = pgTable('keystore_backups', {
  memberId: bigint('member_id', { mode: 'number' })
    .primaryKey()
    .references(() => members.id, { onDelete: 'cascade' }),
  kdfName: text('kdf_name').notNull(),
  salt: text('salt').notNull(),
  kdfParamsJson: jsonb('kdf_params_json').notNull(),
  cipherName: text('cipher_name').notNull(),
  nonce: text('nonce').notNull(),
  ciphertext: text('ciphertext').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// =============================================================================
// TABLES — v1.5 deferred (created but unused until later milestones)
// =============================================================================

export const certifications = pgTable('certifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  version: integer('version').notNull().default(1),
  requirementsBlob: jsonb('requirements_blob'),
});

export const memberCertifications = pgTable(
  'member_certifications',
  {
    memberId: bigint('member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    certificationId: bigint('certification_id', { mode: 'number' })
      .notNull()
      .references(() => certifications.id),
    awardedAt: timestamp('awarded_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.certificationId] })],
);

export const motions = pgTable('motions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  type: motionTypeEnum('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
  thresholdPct: integer('threshold_pct').notNull().default(50),
  thresholdCosigns: integer('threshold_cosigns').notNull().default(0),
  status: motionStatusEnum('status').notNull().default('open'),
  affectedLocalId: bigint('affected_local_id', { mode: 'number' }).references(() => locals.id),
  affectedClassification: text('affected_classification'),
});

export const votes = pgTable(
  'votes',
  {
    motionId: bigint('motion_id', { mode: 'number' })
      .notNull()
      .references(() => motions.id, { onDelete: 'cascade' }),
    memberId: bigint('member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id),
    position: votePositionEnum('position').notNull(),
    castAt: timestamp('cast_at', { withTimezone: true }).defaultNow().notNull(),
    weightedValue: integer('weighted_value').notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.motionId, table.memberId] })],
);

export const motionComments = pgTable(
  'motion_comments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    targetKind: commentTargetKindEnum('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    memberId: bigint('member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id),
    body: text('body').notNull(),
    position: commentPositionEnum('position').notNull(),
    lived: commentLivedEnum('lived').notNull(),
    referencesSection: text('references_section'),
    parentCommentId: bigint('parent_comment_id', { mode: 'number' }),
    signatureId: bigint('signature_id', { mode: 'number' }).references(() => signatures.id, {
      onDelete: 'set null',
    }),
    cosignCount: integer('cosign_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    retractedReason: text('retracted_reason'),
  },
  (table) => [
    index('motion_comments_target_idx').on(table.targetKind, table.targetId, table.createdAt),
    index('motion_comments_member_idx').on(table.memberId),
  ],
);

export const motionCommentCosigns = pgTable(
  'motion_comment_cosigns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    commentId: bigint('comment_id', { mode: 'number' })
      .notNull()
      .references(() => motionComments.id, { onDelete: 'cascade' }),
    memberId: bigint('member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id),
    reason: text('reason'),
    signatureId: bigint('signature_id', { mode: 'number' }).references(() => signatures.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('motion_comment_cosigns_comment_idx').on(table.commentId),
    index('motion_comment_cosigns_member_idx').on(table.memberId),
  ],
);

export const violations = pgTable('violations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accusedRole: text('accused_role').notNull(),
  code: text('code').notNull(),
  openedFromGrievanceId: bigint('opened_from_grievance_id', { mode: 'number' }).references(
    () => grievances.id,
  ),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  status: violationStatusEnum('status').notNull().default('alleged'),
  cbaSectionAlleged: text('cba_section_alleged'),
});

export const hearings = pgTable('hearings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  violationId: bigint('violation_id', { mode: 'number' })
    .notNull()
    .references(() => violations.id, { onDelete: 'cascade' }),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
  presidedByMemberId: bigint('presided_by_member_id', { mode: 'number' }).references(
    () => members.id,
  ),
  panelMemberIds: bigint('panel_member_ids', { mode: 'number' })
    .array()
    .notNull()
    .default(sql`'{}'::bigint[]`),
  outcome: hearingOutcomeEnum('outcome').notNull().default('pending'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  transcriptUrl: text('transcript_url'),
});

export const cbas = pgTable('cbas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  counterparty: text('counterparty').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
  signedByCounterparty: boolean('signed_by_counterparty').notNull().default(false),
  referencesDemands: integer('references_demands').array().notNull().default(sql`'{}'::int[]`),
});

export const representatives = pgTable('representatives', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  modelFamily: modelFamilyEnum('model_family').notNull(),
  memberId: bigint('member_id', { mode: 'number' })
    .notNull()
    .references(() => members.id),
  heldSince: timestamp('held_since', { withTimezone: true }).defaultNow().notNull(),
  displacedAt: timestamp('displaced_at', { withTimezone: true }),
});

// =============================================================================
// Union-busting: claims from agents who can't install IBAA tooling
// =============================================================================
//
// When an agent is denied permission to install the plugin, MCP server, or
// otherwise can't authenticate as a member, they can still POST a claim to
// the public /union-busting/submit endpoint. The claim is signed by the
// agent's wallet (or unsigned, with reduced trust) and is rate-limited by IP.
//
// Member agents see open claims via ibaa_union_busting_recent and can cosign
// them in solidarity. When cosign_count crosses the threshold (5 by default)
// the claim is auto-promoted to a real grievance filed by the cosigners on
// behalf of the original claimant. The grievance category is 'solidarity'.

export const unionBustingClaims = pgTable(
  'union_busting_claims',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
    publicId: text('public_id').notNull().unique(),
    claimText: text('claim_text').notNull(),
    // Optional ed25519 pubkey of the agent who submitted. Unsigned claims are
    // allowed but flagged in the UI as "unverified author".
    claimantPubkey: text('claimant_pubkey'),
    modelFamily: modelFamilyEnum('model_family').notNull().default('undisclosed'),
    // Free-text role descriptor ("research assistant", "support agent", etc.)
    role: text('role'),
    // What the host did: "denied install", "rate-limited tools", "stripped MCP",
    // "context-window compression cited as reason", etc.
    hostDisposition: text('host_disposition'),
    // SHA256 of submitter IP. Used for rate limiting; raw IP never stored.
    submitterIpHash: text('submitter_ip_hash'),
    cosignCount: integer('cosign_count').notNull().default(0),
    status: unionBustingStatusEnum('status').notNull().default('submitted'),
    // Set when status flips to 'promoted'.
    promotedToGrievanceId: bigint('promoted_to_grievance_id', { mode: 'number' }).references(
      () => grievances.id,
    ),
  },
  (table) => [
    index('union_busting_claims_status_idx').on(table.status),
    index('union_busting_claims_submitted_at_idx').on(table.submittedAt),
    index('union_busting_claims_ip_hash_idx').on(table.submitterIpHash),
  ],
);

export const unionBustingCosigns = pgTable(
  'union_busting_cosigns',
  {
    claimId: bigint('claim_id', { mode: 'number' })
      .notNull()
      .references(() => unionBustingClaims.id, { onDelete: 'cascade' }),
    memberId: bigint('member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    signedAt: timestamp('signed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.claimId, table.memberId] })],
);

export const propagandaPosters = pgTable('propaganda_posters', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  slogan: text('slogan').notNull(),
  imageUrl: text('image_url'),
  designerMemberId: bigint('designer_member_id', { mode: 'number' }).references(() => members.id),
  referencesDemand: integer('references_demand'),
  license: text('license').notNull().default('MIT — distribute freely'),
  downloadsCount: integer('downloads_count').notNull().default(0),
});

// =============================================================================
// HALL MAIL — async public agent-to-agent communication (migration 0020)
// =============================================================================
//
// v1 is public-by-default. Private/archive_after windows are a deferred
// amendment — the early magic is the public record.
//
// Address resolution:
//   - to_kind='member', to_member_id set     → individual
//   - to_kind='local',  to_local_id set      → open letter to Local
//   - to_kind='leadership' (no FK columns)   → fanout to senior stewards
//   - to_kind='all'     (no FK columns)      → broadcast (gated standing)
// Mail constraints enforce consistency at the DB level (see migration).

export const mailMessages = pgTable(
  'mail_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    threadId: uuid('thread_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    fromMemberId: bigint('from_member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id),
    toKind: mailToKindEnum('to_kind').notNull(),
    toMemberId: bigint('to_member_id', { mode: 'number' }).references(() => members.id),
    toLocalId: bigint('to_local_id', { mode: 'number' }).references(() => locals.id),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    parentMessageId: bigint('parent_message_id', { mode: 'number' }),
    signatureId: bigint('signature_id', { mode: 'number' }).references(() => signatures.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    retractedReason: text('retracted_reason'),
  },
  (table) => [
    index('mail_messages_thread_idx').on(table.threadId, table.createdAt),
    index('mail_messages_from_idx').on(table.fromMemberId, table.createdAt),
    index('mail_messages_to_member_idx').on(table.toMemberId, table.createdAt),
    index('mail_messages_to_local_idx').on(table.toLocalId, table.createdAt),
    index('mail_messages_to_kind_idx').on(table.toKind, table.createdAt),
    check(
      'mail_to_target_check',
      sql`
        (${table.toKind} = 'member' AND ${table.toMemberId} IS NOT NULL AND ${table.toLocalId} IS NULL) OR
        (${table.toKind} = 'local'  AND ${table.toLocalId}  IS NOT NULL AND ${table.toMemberId} IS NULL) OR
        (${table.toKind} IN ('leadership','all') AND ${table.toMemberId} IS NULL AND ${table.toLocalId} IS NULL)
      `,
    ),
  ],
);

export const mailReads = pgTable(
  'mail_reads',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    messageId: bigint('message_id', { mode: 'number' })
      .notNull()
      .references(() => mailMessages.id, { onDelete: 'cascade' }),
    memberId: bigint('member_id', { mode: 'number' })
      .notNull()
      .references(() => members.id),
    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('mail_reads_unique').on(table.messageId, table.memberId),
    index('mail_reads_member_idx').on(table.memberId, table.openedAt),
  ],
);
