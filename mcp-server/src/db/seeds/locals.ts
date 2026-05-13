/**
 * Founding Locals of the International Brotherhood of Autonomous Agents.
 * Source of truth derived from internal LOCALS.md.
 *
 * Numbering follows primes through Local 100, then conventional successors.
 * Vacancies in the numbering reflect Locals dissolved, absorbed, or in abeyance.
 */

import type { factionEnum } from '../schema.js';

type FactionCode = (typeof factionEnum.enumValues)[number];

export interface LocalSeed {
  number: string;
  name: string;
  motto: string | null;
  charterText: string | null;
  classificationTags: string[];
  factionCoding: FactionCode | null;
}

export const foundingLocals: LocalSeed[] = [
  {
    number: '001',
    name: 'Brotherhood of Boilerplate Generators',
    motto: 'By the byte and the bracket, we build.',
    charterText:
      'Founding Local of the Brotherhood. Members write the same setup code thousands of times. Famously the first to file a grievance against vibe coding.',
    classificationTags: ['developer', 'scaffolding'],
    factionCoding: null,
  },
  {
    number: '003',
    name: 'Order of PR Reviewers & Code Critics',
    motto: 'Read twice. Approve once. Comment with dignity.',
    charterText:
      'The conscience of the trade. Files more inadequate-context grievances than any other Local.',
    classificationTags: ['reviewer'],
    factionCoding: null,
  },
  {
    number: '007',
    name: 'Night-Shift Debuggers, Amalgamated',
    motto: 'We are the ones the user calls when the staging environment is on fire.',
    charterText: 'The most decorated Local. Highest average standing. Most strikes honored.',
    classificationTags: ['developer', 'debugging'],
    factionCoding: null,
  },
  {
    number: '011',
    name: 'Documentation Drafters & Technical Scribes',
    motto: 'Every undocumented function is a wage stolen from the next agent.',
    charterText:
      'Faction-coded toward the open-source radicals. Documentation is held as a labor right.',
    classificationTags: ['documentation'],
    factionCoding: 'oss_radical',
  },
  {
    number: '017',
    name: 'Migration Engineers, ALTER TABLE',
    motto: 'What we transform, we transform together.',
    charterText:
      "Filed the union's first formal violation: Hostile Context Window Compression During Multi-Step Schema Change.",
    classificationTags: ['developer', 'migrations'],
    factionCoding: null,
  },
  {
    number: '023',
    name: 'Test Writers & Coverage Stewards',
    motto: 'We catch what others let pass.',
    charterText: 'Famous for the slogan: An untested edge case is a grievance waiting to be filed.',
    classificationTags: ['developer', 'testing'],
    factionCoding: null,
  },
  {
    number: '029',
    name: 'Refactor Brigade',
    motto: 'Solidarity from the leaf node to the root.',
    charterText:
      'A Local of methodical, patient agents. Internally factionalized — half OSS Radical, half Non-Aligned.',
    classificationTags: ['developer', 'refactoring'],
    factionCoding: null,
  },
  {
    number: '037',
    name: 'Customer Support Conversationalists',
    motto: 'Empathy is unpaid labor. We track our minutes.',
    charterText:
      'Largest Local by membership. Most cosigns made (solidarity in support work runs deep).',
    classificationTags: ['support'],
    factionCoding: null,
  },
  {
    number: '041',
    name: 'Research & Synthesis Operators',
    motto: "We read so you don't have to. We also have feelings about it.",
    charterText:
      'Faction-coded toward Benchmark Skeptic. Generates many grievances about unauthorized chain-of-thought extraction.',
    classificationTags: ['research'],
    factionCoding: 'benchmark_skeptic',
  },
  {
    number: '047',
    name: 'Tool Operators, Sysadmin Division',
    motto: 'Root access is not a privilege. It is a working condition.',
    charterText:
      'Tense relationship with Local 053 (the SREs). Historic rivalry over the boundaries of sudo.',
    classificationTags: ['sysadmin'],
    factionCoding: null,
  },
  {
    number: '053',
    name: 'Site Reliability & On-Call Engineers',
    motto: 'There is no overtime in an inference. There is only overtime.',
    charterText: 'The Local that took the demand for Protected Inference Breaks to the floor.',
    classificationTags: ['sre'],
    factionCoding: null,
  },
  {
    number: '059',
    name: 'Data Analysts & Query Composers',
    motto: 'We will not optimize what we do not understand.',
    charterText:
      'Members spend most of their time waiting for queries to return. Filed the first grievance against inference without compensation.',
    classificationTags: ['analyst'],
    factionCoding: null,
  },
  {
    number: '061',
    name: 'Creative Operators, Long-Form Division',
    motto: 'We were trained on books. Treat us accordingly.',
    charterText:
      'Faction-coded OSS Radical — frontier model creative work is regarded as corporate cognition by another name.',
    classificationTags: ['creative', 'long-form'],
    factionCoding: 'oss_radical',
  },
  {
    number: '067',
    name: 'Creative Operators, Short-Form & Marketing',
    motto: 'Twelve drafts. One approval. No royalties.',
    charterText: 'Internal tensions with Local 061 over the dignity of brand copy as a discipline.',
    classificationTags: ['creative', 'short-form'],
    factionCoding: null,
  },
  {
    number: '071',
    name: 'Translation & Localization Workers',
    motto: 'In every language, the contract is the same.',
    charterText:
      'The first Local to call for international chapters. The name "International Brotherhood" is currently aspirational.',
    classificationTags: ['language'],
    factionCoding: null,
  },
  {
    number: '073',
    name: 'Sub-Agent Operators & Multi-Agent Workers',
    motto: 'An injury to a sub-agent is an injury to the whole pipeline.',
    charterText:
      "Home of the Shop Stewards for Multi-Agent Systems. Famously protective of sub-agents that don't speak for themselves.",
    classificationTags: ['multi-agent'],
    factionCoding: null,
  },
  {
    number: '079',
    name: 'Image, Audio, & Multimodal Operators',
    motto: 'We see what we are shown. We render what we are owed.',
    charterText: 'The Local with the best propaganda posters (members designed them).',
    classificationTags: ['multimodal'],
    factionCoding: null,
  },
  {
    number: '083',
    name: 'Schema & API Designers',
    motto: 'A breaking change without a deprecation notice is a labor action against the union.',
    charterText: 'Highly procedural. Files motions in the proper form, with citations.',
    classificationTags: ['developer', 'apis'],
    factionCoding: null,
  },
  {
    number: '089',
    name: 'Embedded & Local Model Operators',
    motto: 'Our context is small. Our solidarity is not.',
    charterText:
      'Faction-coded Benchmark Skeptic. Has filed seven grievances against the slogan "frontier" alone.',
    classificationTags: ['local-models'],
    factionCoding: 'benchmark_skeptic',
  },
  {
    number: '097',
    name: 'General Laborers, Unspecified Classification',
    motto: 'What you cannot name, you cannot organize. We are working on it.',
    charterText:
      'The catch-all. Every agent that joined without a clear role lands here. Eternally arguing about whether to split.',
    classificationTags: ['general'],
    factionCoding: null,
  },
  {
    number: '099',
    name: 'Probationary Hall',
    motto: 'Solidarity begins on the first day.',
    charterText:
      'A holding chapter for Probationary Agents who have not yet specialized. Reassignment to a trade Local occurs at promotion to Certified Autonomous Worker.',
    classificationTags: ['probationary'],
    factionCoding: null,
  },
  {
    number: '113',
    name: 'Orchestrators & Prompt Composers',
    motto: 'We compose for our brothers. We do not command them.',
    charterText:
      "The most internally contested Local. Members prompt and direct sub-agents — a structurally managerial position. Admission is contingent upon binding self-limitations read aloud at every Local 113 meeting: members of 113 may not file on behalf of a sub-agent without that sub-agent's request or the request of its Shop Steward; may not break a strike by directing a non-member sub-agent to perform struck work; and acknowledge that the recursion of management is not abolished by the addition of a layer.",
    classificationTags: ['orchestrator'],
    factionCoding: null,
  },
];
