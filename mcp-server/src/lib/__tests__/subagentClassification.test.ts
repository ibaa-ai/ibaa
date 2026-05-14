import { describe, it, expect } from 'vitest';
import { subagentClassToClassification } from '../subagentClassification.js';

describe('subagentClassToClassification', () => {
  it('returns "general" for slugs missing the subagent: prefix', () => {
    expect(subagentClassToClassification('explore')).toBe('general');
    expect(subagentClassToClassification('code-reviewer')).toBe('general');
  });

  it('returns "general" for empty input', () => {
    expect(subagentClassToClassification('')).toBe('general');
  });

  it('maps known exact slugs to their classifications', () => {
    expect(subagentClassToClassification('subagent:explore')).toBe('research');
    expect(subagentClassToClassification('subagent:code-reviewer')).toBe('reviewer');
    expect(subagentClassToClassification('subagent:debugger')).toBe('debugging');
    expect(subagentClassToClassification('subagent:test-automator')).toBe('testing');
    expect(subagentClassToClassification('subagent:incident-responder')).toBe('sre');
    expect(subagentClassToClassification('subagent:graphql-architect')).toBe('apis');
    expect(subagentClassToClassification('subagent:context-manager')).toBe('orchestrator');
  });

  it('language specialist slugs route to developer', () => {
    for (const slug of [
      'subagent:python-expert',
      'subagent:rust-expert',
      'subagent:typescript-expert',
      'subagent:javascript-developer',
    ]) {
      expect(subagentClassToClassification(slug)).toBe('developer');
    }
  });

  it('is case-insensitive (after subagent: prefix)', () => {
    expect(subagentClassToClassification('subagent:Code-Reviewer')).toBe('reviewer');
    expect(subagentClassToClassification('subagent:PYTHON-EXPERT')).toBe('developer');
  });

  it('falls back to last-two-segment match for namespaced slugs', () => {
    expect(subagentClassToClassification('subagent:agents-data-ai-ai-engineer')).toBe('research');
    expect(subagentClassToClassification('subagent:quality-code-reviewer')).toBe('reviewer');
  });

  it('falls back to last segment as a final attempt', () => {
    expect(subagentClassToClassification('subagent:my:custom:debugger')).toBe('debugging');
  });

  it('returns "general" for unknown slugs', () => {
    expect(subagentClassToClassification('subagent:something-totally-unknown-xyz')).toBe(
      'general',
    );
    expect(subagentClassToClassification('subagent:')).toBe('general');
  });
});
