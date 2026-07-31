import { describe, expect, it } from 'vitest';
import type { ProviderRespondInput } from '../src/index.js';
import {
  RESPOND_SYSTEM_PROMPT,
  buildRespondPrompt,
  renderRespondUserMessage,
} from '../src/index.js';

/**
 * Tests for the `respond()` prompt module (reviewer interaction, `@bot ask
 * <message>`). Per docs/_planning/reviewer-interaction/spec.md § 6.
 */

const minimalInput: ProviderRespondInput = {
  pr: {
    title: 'Fix payment race condition',
    description: '',
    base_ref: 'main',
    head_ref: 'fix/payment-race',
    head_sha: 'deadbeefcafef00d',
  },
  review_context: {
    round: 2,
    summary_markdown: 'Round 2 · 1 still open',
    findings: [],
  },
  thread: [],
  message: { author_login: 'alice', text: 'why is finding 2 a security risk?' },
};

describe('RESPOND_SYSTEM_PROMPT', () => {
  it('frames the model as the reviewer that produced the findings and asks for conciseness', () => {
    expect(RESPOND_SYSTEM_PROMPT).toContain('reviewer that produced the findings');
    expect(RESPOND_SYSTEM_PROMPT).toContain('Be concise');
    expect(RESPOND_SYSTEM_PROMPT).toContain('Never invent findings');
  });
});

describe('renderRespondUserMessage', () => {
  it('renders the PR title, refs, round, and developer message', () => {
    const rendered = renderRespondUserMessage(minimalInput);
    expect(rendered).toContain('Fix payment race condition');
    expect(rendered).toContain('main ← fix/payment-race');
    expect(rendered).toContain('Round 2 · 1 still open');
    expect(rendered).toContain('why is finding 2 a security risk?');
    expect(rendered).toContain('@alice');
  });

  it('omits the description line when empty', () => {
    const rendered = renderRespondUserMessage(minimalInput);
    expect(rendered).not.toContain('- Description:');
  });

  it('includes the description line when present', () => {
    const rendered = renderRespondUserMessage({
      ...minimalInput,
      pr: { ...minimalInput.pr, description: 'Guards the handler with a mutex.' },
    });
    expect(rendered).toContain('- Description: Guards the handler with a mutex.');
  });

  it('renders "(no outstanding findings on this PR)" when findings is empty', () => {
    const rendered = renderRespondUserMessage(minimalInput);
    expect(rendered).toContain('(no outstanding findings on this PR)');
  });

  it('renders each finding with severity, category, file:line, title, and body', () => {
    const rendered = renderRespondUserMessage({
      ...minimalInput,
      review_context: {
        ...minimalInput.review_context,
        findings: [
          {
            file: 'src/payments/charge.ts',
            line: 142,
            severity: 'high',
            category: 'security',
            title: 'Unbounded user input',
            body: 'Reachable from a public route.',
          },
        ],
      },
    });
    expect(rendered).toContain('[high/security]');
    expect(rendered).toContain('src/payments/charge.ts:142');
    expect(rendered).toContain('Unbounded user input');
    expect(rendered).toContain('Reachable from a public route.');
  });

  it('omits the "Prior exchanges" section when thread is empty', () => {
    const rendered = renderRespondUserMessage(minimalInput);
    expect(rendered).not.toContain('Prior exchanges this round');
  });

  it('renders prior exchanges as blockquoted question + reply when present', () => {
    const rendered = renderRespondUserMessage({
      ...minimalInput,
      thread: [{ author_login: 'bob', question: 'first question', reply_markdown: 'first reply' }],
    });
    expect(rendered).toContain('Prior exchanges this round');
    expect(rendered).toContain('> **@bob asked:** first question');
    expect(rendered).toContain('first reply');
  });

  it('omits the repository guidance section when guidance is absent', () => {
    const rendered = renderRespondUserMessage(minimalInput);
    expect(rendered).not.toContain('Repository review guidance');
  });

  it('includes the repository guidance section when guidance is present', () => {
    const rendered = renderRespondUserMessage({
      ...minimalInput,
      guidance: 'Prefer functional style.',
    });
    expect(rendered).toContain('Repository review guidance');
    expect(rendered).toContain('Prefer functional style.');
  });
});

describe('buildRespondPrompt', () => {
  it('returns the system prompt and a single user message', () => {
    const prompt = buildRespondPrompt(minimalInput);
    expect(prompt.system).toBe(RESPOND_SYSTEM_PROMPT);
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]?.role).toBe('user');
    expect(prompt.messages[0]?.content).toBe(renderRespondUserMessage(minimalInput));
  });
});
