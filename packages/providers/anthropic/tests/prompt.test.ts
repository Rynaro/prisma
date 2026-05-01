import type { ProviderReviewInput } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../src/prompt.js';

const inputBase: ProviderReviewInput = {
  files: [
    {
      path: 'src/payments/charge.ts',
      language: 'ts',
      hunks: [{ id: 'H1', line_start: 10, line_end: 12, content: 'export const charge = 1;\n' }],
    },
    {
      path: 'README.md',
      hunks: [{ id: 'H2', line_start: 1, line_end: 1, content: '# title\n' }],
    },
  ],
};

describe('buildPrompt', () => {
  it('produces a non-empty system prompt', () => {
    const prompt = buildPrompt(inputBase);
    expect(typeof prompt.system).toBe('string');
    expect(prompt.system.length).toBeGreaterThan(0);
    expect(prompt.system).toContain('submit_review_findings');
  });

  it('declares the submit_review_findings tool with an input_schema', () => {
    const prompt = buildPrompt(inputBase);
    expect(prompt.tool.name).toBe('submit_review_findings');
    expect(typeof prompt.tool.description).toBe('string');
    expect(prompt.tool.description.length).toBeGreaterThan(0);
    expect(typeof prompt.tool.input_schema).toBe('object');
    const schema = prompt.tool.input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect((schema.required as string[]).includes('findings')).toBe(true);
  });

  it('embeds every file path in the user message', () => {
    const prompt = buildPrompt(inputBase);
    const userMsg = prompt.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toContain('src/payments/charge.ts');
    expect(userMsg?.content).toContain('README.md');
    expect(userMsg?.content).toContain('H1');
    expect(userMsg?.content).toContain('H2');
  });

  it('handles missing or empty repo_heuristics cleanly', () => {
    const prompt1 = buildPrompt(inputBase);
    expect(prompt1.messages[0]?.content).toContain('Repo heuristics');
    expect(prompt1.messages[0]?.content).toContain('(none)');

    const prompt2 = buildPrompt({ ...inputBase, repo_heuristics: { uses_typescript: true } });
    expect(prompt2.messages[0]?.content).toContain('uses_typescript: true');
  });
});
