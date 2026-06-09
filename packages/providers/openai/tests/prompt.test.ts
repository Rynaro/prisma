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

// T10: tool name + forced tool_choice + path/hunk embedding
describe('buildPrompt (openai)', () => {
  it('produces a non-empty system message that mentions the tool', () => {
    const prompt = buildPrompt(inputBase);
    const sys = prompt.messages.find((m) => m.role === 'system');
    expect(sys).toBeDefined();
    expect(typeof sys?.content).toBe('string');
    expect((sys?.content ?? '').length).toBeGreaterThan(0);
    expect(sys?.content).toContain('submit_review_findings');
  });

  it('declares the submit_review_findings tool with OpenAI function shape', () => {
    const prompt = buildPrompt(inputBase);
    expect(prompt.tool.type).toBe('function');
    expect(prompt.tool.function.name).toBe('submit_review_findings');
    expect(typeof prompt.tool.function.description).toBe('string');
    expect(prompt.tool.function.description.length).toBeGreaterThan(0);
    const params = prompt.tool.function.parameters as Record<string, unknown>;
    expect(params.type).toBe('object');
    expect((params.required as string[]).includes('findings')).toBe(true);
    expect(prompt.tool_choice.function.name).toBe('submit_review_findings');
  });

  it('embeds every file path and hunk id in the user message', () => {
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
    const userMsg1 = prompt1.messages.find((m) => m.role === 'user');
    expect(userMsg1?.content).toContain('Repo heuristics');
    expect(userMsg1?.content).toContain('(none)');

    const prompt2 = buildPrompt({ ...inputBase, repo_heuristics: { uses_typescript: true } });
    const userMsg2 = prompt2.messages.find((m) => m.role === 'user');
    expect(userMsg2?.content).toContain('uses_typescript: true');
  });
});
