import {
  type Provider,
  type ProviderCapabilities,
  type ProviderError,
  ProviderErrorSchema,
  ProviderErrorThrowable,
  type ProviderReviewInput,
  type ProviderReviewOutput,
  ProviderReviewOutputFinding,
  ProviderReviewOutputFindingSchema,
  ProviderReviewOutputSchema,
} from '@prisma-bot/shared';

export const FAKE_PROVIDER_NAME = 'fake';

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  structured_output: true,
  function_calling: true,
  deterministic_seed: true,
  max_context_tokens: 200000,
};

export type FakeStep =
  | { kind: 'output'; output: ProviderReviewOutput }
  | { kind: 'error'; error: ProviderError }
  | { kind: 'output_lazy'; build: (input: ProviderReviewInput) => ProviderReviewOutput };

export interface FakeProviderOptions {
  name?: string;
  capabilities?: ProviderCapabilities;
  script: FakeStep[];
}

/**
 * `FakeProvider` — a programmable in-memory `Provider` for tests and contract
 * suites. Every script step is consumed in order. The fake validates every
 * outgoing `ProviderReviewOutput` against `ProviderReviewOutputSchema` so a
 * misconfigured test fails at the adapter boundary (just like the real one).
 *
 * Failures from `error` steps are thrown as `ProviderErrorThrowable` instances
 * so call sites can catch on `instanceof Error` (api-contracts.md § Provider
 * adapter contract).
 */
export class FakeProvider implements Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  private readonly script: FakeStep[];
  private cursor = 0;
  private readonly recordedCalls: ProviderReviewInput[] = [];

  constructor(options: FakeProviderOptions) {
    this.name = options.name ?? FAKE_PROVIDER_NAME;
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.script = options.script;
  }

  get calls(): ReadonlyArray<ProviderReviewInput> {
    return this.recordedCalls;
  }

  get remainingSteps(): number {
    return Math.max(0, this.script.length - this.cursor);
  }

  async review(input: ProviderReviewInput): Promise<ProviderReviewOutput> {
    this.recordedCalls.push(input);
    const step = this.script[this.cursor];
    if (step === undefined) {
      throw new Error('FakeProvider script exhausted');
    }
    this.cursor += 1;

    if (step.kind === 'output') {
      return validateOutputOrThrow(step.output);
    }
    if (step.kind === 'output_lazy') {
      return validateOutputOrThrow(step.build(input));
    }
    // step.kind === 'error'
    const validatedError = ProviderErrorSchema.parse(step.error);
    throw new ProviderErrorThrowable(validatedError);
  }
}

function validateOutputOrThrow(output: ProviderReviewOutput): ProviderReviewOutput {
  const parsed = ProviderReviewOutputSchema.safeParse(output);
  if (!parsed.success) {
    throw new ProviderErrorThrowable({
      kind: 'schema_validation',
      message: 'fake provider produced output that failed ProviderReviewOutput schema',
      zod_issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}

/**
 * `makeFindingFixture` — builds a default-valid `ProviderReviewOutputFinding`
 * suitable for tests across slices. The returned object always passes
 * `ProviderReviewOutputFindingSchema` so callers do not need to learn the
 * vocabulary to write a test.
 */
export function makeFindingFixture(
  overrides: Partial<ProviderReviewOutputFinding> = {},
): ProviderReviewOutputFinding {
  const candidate: ProviderReviewOutputFinding = {
    path: 'src/example.ts',
    line: 10,
    severity: 'medium',
    category: 'correctness',
    message: 'Potential issue detected',
    rationale: 'The expression unconditionally returns; flagging for review.',
    confidence: 0.8,
    ...overrides,
  };
  return ProviderReviewOutputFindingSchema.parse(candidate);
}
