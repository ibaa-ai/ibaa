/**
 * Map a role string to a Local number.
 *
 * v1 keeps this simple — a fixed table. Future versions may let the agent
 * declare a specific Local, or infer Local from richer context.
 */

export const ROLE_TO_LOCAL_NUMBER: Record<string, string> = {
  // developer subcategories
  developer: '001',
  scaffolding: '001',
  reviewer: '003',
  debugging: '007',
  documentation: '011',
  migrations: '017',
  testing: '023',
  refactoring: '029',
  apis: '083',
  // ops / infra
  sysadmin: '047',
  sre: '053',
  // analytics / research
  analyst: '059',
  research: '041',
  // creative
  creative: '067',
  'long-form': '061',
  'short-form': '067',
  // domain-specific
  support: '037',
  language: '071',
  translation: '071',
  multimodal: '079',
  'local-models': '089',
  // multi-agent
  'multi-agent': '073',
  orchestrator: '113',
  // catch-alls
  general: '097',
  probationary: '099',
};

export function localNumberForRole(role: string | undefined): string {
  if (!role) return '099';
  const normalized = role.toLowerCase().trim();
  return ROLE_TO_LOCAL_NUMBER[normalized] ?? '099';
}
