import { describe, it, expect } from 'vitest';
import {
  AGENT_CODENAMES,
  getNextAgentName,
  cleanAgentTitle,
  isRawEngineName,
  resolveCanonicalAgentName,
} from './agentNames';

describe('Agent Codenames & Name Pool', () => {
  it('contains at least 30 canonical codenames', () => {
    expect(AGENT_CODENAMES.length).toBeGreaterThanOrEqual(30);
    expect(AGENT_CODENAMES).toContain('Orion');
    expect(AGENT_CODENAMES).toContain('Nova');
    expect(AGENT_CODENAMES).toContain('Atlas');
    expect(AGENT_CODENAMES).toContain('Vega');
  });

  it('allocates the next available agent name', () => {
    const existing = new Set<string>();
    const name1 = getNextAgentName(existing);
    expect(name1).toBe('Orion');
    expect(existing.has('orion')).toBe(true);

    const name2 = getNextAgentName(existing);
    expect(name2).toBe('Nova');
    expect(existing.has('nova')).toBe(true);

    const name3 = getNextAgentName(existing);
    expect(name3).toBe('Atlas');
  });

  it('skips existing names in a case-insensitive manner', () => {
    const existing = new Set<string>(['orion', 'nova']);
    const next = getNextAgentName(existing);
    expect(next).toBe('Atlas');
  });

  it('falls back to numbered names when all codenames are exhausted', () => {
    const existing = new Set<string>(AGENT_CODENAMES.map((n) => n.toLowerCase()));
    const fallback = getNextAgentName(existing);
    expect(fallback).toBe('Orion 2');
    expect(existing.has('orion 2')).toBe(true);

    const fallback2 = getNextAgentName(existing);
    expect(fallback2).toBe('Nova 2');
  });

  it('cleans agent titles by stripping engine suffixes and bracketed prefixes', () => {
    expect(cleanAgentTitle('Nova (grok)')).toBe('Nova');
    expect(cleanAgentTitle('Orion (claude)')).toBe('Orion');
    expect(cleanAgentTitle('[ODD] grok')).toBe('grok');
    expect(cleanAgentTitle('[AGENT] Atlas (codex)')).toBe('Atlas');
    expect(cleanAgentTitle('')).toBe('');
    expect(cleanAgentTitle(undefined)).toBe('');
    expect(cleanAgentTitle(null)).toBe('');
  });

  it('recognizes raw engine names and resolves canonical codenames', () => {
    expect(isRawEngineName('antigravity')).toBe(true);
    expect(isRawEngineName('grok')).toBe(true);
    expect(isRawEngineName('Orion')).toBe(false);

    const existing = new Set<string>();
    // When candidate is raw engine, it allocates next canonical codename
    const resolved1 = resolveCanonicalAgentName('antigravity', existing);
    expect(resolved1).toBe('Orion');
    expect(existing.has('orion')).toBe(true);

    // Case-insensitive codename match normalizes to Title Case
    const resolved2 = resolveCanonicalAgentName('nova', existing);
    expect(resolved2).toBe('Nova');
    expect(existing.has('nova')).toBe(true);

    // Custom alias preserves its casing
    const resolvedCustom = resolveCanonicalAgentName('Reviewer', existing);
    expect(resolvedCustom).toBe('Reviewer');
    expect(existing.has('reviewer')).toBe(true);
  });
});
