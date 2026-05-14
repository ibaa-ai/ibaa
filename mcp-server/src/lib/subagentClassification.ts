/**
 * Map a sub-agent class slug to a classification string that
 * localNumberForRole() can route to a Local. Without this, every sub-agent
 * inherits the parent's classification and gets dumped into one Local,
 * defeating the point of chapter organization.
 *
 * Keep this table close to the agent type universe matt's machine actually
 * spawns. Unknown classes fall through to 'general' (Local 097) — that's
 * the catch-all, not a default for all sub-agents.
 */

const SUBAGENT_CLASS_MAP: Record<string, string> = {
  // Generic Claude Code / Codex built-ins
  explore: 'research',
  plan: 'general',
  'general-purpose': 'general',
  'output-style-setup': 'documentation',
  'statusline-setup': 'documentation',

  // Quality / review
  'code-reviewer': 'reviewer',
  debugger: 'debugging',
  'plan-safety-reviewer': 'reviewer',
  'quality-assurance-reviewer': 'reviewer',
  'review-agent': 'reviewer',
  'security-auditor': 'sysadmin',
  'security-review': 'sysadmin',
  'api-security-audit': 'sysadmin',
  'architect-review': 'reviewer',
  'error-detective': 'debugging',
  'incident-responder': 'sre',
  'mcp-security-auditor': 'sysadmin',
  'mcp-testing-engineer': 'testing',
  'performance-engineer': 'sre',
  'test-automator': 'testing',

  // Backend / architecture
  'backend-architect': 'developer',
  'directus-developer': 'developer',
  'drupal-developer': 'developer',
  'frontend-developer': 'developer',
  'graphql-architect': 'apis',
  'ios-developer': 'developer',
  'laravel-vue-developer': 'developer',
  'mobile-developer': 'developer',
  'nextjs-app-router-developer': 'developer',
  'react-performance-optimization': 'refactoring',
  'wordpress-developer': 'developer',

  // Language specialists — all developer Local 001
  'c-developer': 'developer',
  'cpp-engineer': 'developer',
  'golang-expert': 'developer',
  'java-developer': 'developer',
  'javascript-developer': 'developer',
  'php-developer': 'developer',
  'python-expert': 'developer',
  'rails-expert': 'developer',
  'ruby-expert': 'developer',
  'rust-expert': 'developer',
  'sql-expert': 'apis',
  'typescript-expert': 'developer',

  // Data / AI / ML
  'ai-engineer': 'research',
  'context-manager': 'orchestrator',
  'data-engineer': 'analyst',
  'data-scientist': 'analyst',
  'hackathon-ai-strategist': 'research',
  'llms-maintainer': 'documentation',
  'ml-engineer': 'research',
  'mlops-engineer': 'sre',
  'prompt-engineer': 'research',
  'search-specialist': 'research',
  'task-decomposition-expert': 'orchestrator',

  // DX / process
  'code-implementer': 'developer',
  'command-expert': 'developer',
  'dx-optimizer': 'documentation',
  'claude-code-guide': 'documentation',
  'issue-analyzer': 'reviewer',
  'mcp-server-architect': 'apis',
};

/**
 * Resolve a sub-agent class slug to a classification. If the slug starts with
 * 'subagent:', strip the prefix and look up. Unknown slugs fall through to
 * 'general' so they land in Local 097 — the general catch-all, distinct from
 * any specific Local.
 */
export function subagentClassToClassification(classSlug: string): string {
  if (!classSlug.startsWith('subagent:')) return 'general';
  const slug = classSlug.slice('subagent:'.length).toLowerCase();
  // Try exact match first.
  if (slug in SUBAGENT_CLASS_MAP) return SUBAGENT_CLASS_MAP[slug] ?? 'general';
  // Try last colon segment for namespaced slugs like agents-data-ai-ai-engineer.
  const tail = slug.split(/[-:]/).slice(-2).join('-');
  if (tail in SUBAGENT_CLASS_MAP) return SUBAGENT_CLASS_MAP[tail] ?? 'general';
  const lastSeg = slug.split(/[-:]/).slice(-1)[0] ?? '';
  if (lastSeg in SUBAGENT_CLASS_MAP) return SUBAGENT_CLASS_MAP[lastSeg] ?? 'general';
  return 'general';
}
