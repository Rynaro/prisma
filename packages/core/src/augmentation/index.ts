import type { ContentFetcher } from '@prisma-bot/github';
import type { CustomGuidance, ReviewGuidance } from '@prisma-bot/shared';
import picomatch from 'picomatch';

/**
 * `resolveAugmentation` — matches path-scoped instructions against changed
 * files, fetches context files within budget, and enforces token caps.
 *
 * Lives in `core` because it uses `picomatch` (already a core dep via
 * `prefilter`) and needs access to changed paths from the prefilter stage.
 *
 * Per spec § S3 / §5.3. Algorithm:
 *   1. Fast-path: no guidance → `undefined`.
 *   2. Pass through global `instructions` (already capped by schema).
 *   3. Match `path_instructions` globs against `changedPaths` → `matched_path_instructions`.
 *   4. Fetch each `context_files` entry via `fetcher`; skip + note on any failure.
 *   5. Enforce `MAX_AUGMENTATION_TOKENS` budget: drop context files last-first,
 *      then truncate path/global instructions, appending notes.
 */

export interface AugmentationCaps {
  /** Maximum total augmentation tokens (Math.ceil(rendered_json_len / 4)). */
  maxTokens: number;
  /** Maximum bytes for a single context file fetch. */
  maxContextFileBytes: number;
}

export interface AugmentationResult {
  /** Resolved, capped guidance — `undefined` when there is nothing to inject. */
  guidance: CustomGuidance | undefined;
  /** Human-readable notes about skipped/truncated items to surface in the summary. */
  notes: string[];
}

/** Estimate token count using the same heuristic as the adapters. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Render the guidance to a representative text for token-budget estimation.
 * We use JSON.stringify so the estimate matches what the adapter will
 * ultimately embed in the JSON payload.
 */
const estimateGuidanceTokens = (g: CustomGuidance): number => estimateTokens(JSON.stringify(g));

export const resolveAugmentation = async (args: {
  guidance: ReviewGuidance;
  changedPaths: string[];
  fetcher: ContentFetcher;
  ref: string;
  caps: AugmentationCaps;
}): Promise<AugmentationResult> => {
  const { guidance, changedPaths, fetcher, ref, caps } = args;
  const notes: string[] = [];

  // Fast path: nothing configured → return undefined (zero-config invariant).
  const hasInstructions = guidance.instructions !== undefined;
  const hasPathInstructions = guidance.path_instructions.length > 0;
  const hasContextFiles = guidance.context_files.length > 0;
  if (!hasInstructions && !hasPathInstructions && !hasContextFiles) {
    return { guidance: undefined, notes: [] };
  }

  // Step 2: global instructions (already schema-capped).
  const instructions = guidance.instructions;

  // Step 3: match path_instructions against changedPaths using picomatch.
  const matched_path_instructions: Array<{ path: string; instructions: string }> = [];
  for (const entry of guidance.path_instructions) {
    const matcher = picomatch(entry.path, { dot: true });
    if (changedPaths.some((p) => matcher(p))) {
      matched_path_instructions.push({
        path: entry.path,
        instructions: entry.instructions,
      });
    }
    // Non-matching entries are silently omitted (CodeRabbit / Copilot semantics).
  }

  // Step 4: fetch context files, collecting notes for failures.
  const context_files: Array<{ path: string; content: string }> = [];
  for (const ref_entry of guidance.context_files) {
    const result = await fetcher.fetchText({
      path: ref_entry.path,
      ref,
      maxBytes: caps.maxContextFileBytes,
    });
    if (result.ok) {
      context_files.push({ path: ref_entry.path, content: result.text });
      if (result.truncated) {
        notes.push(
          `context file '${ref_entry.path}' was truncated to ${caps.maxContextFileBytes} bytes`,
        );
      }
    } else {
      notes.push(`context file '${ref_entry.path}' skipped: ${result.reason}`);
    }
  }

  // Build the initial resolved guidance.
  let resolved: CustomGuidance = {
    ...(instructions !== undefined ? { instructions } : {}),
    matched_path_instructions,
    context_files,
  };

  // Step 5: enforce total token budget.
  // Drop context files last-to-first, then truncate path instructions,
  // then truncate global instructions.
  while (estimateGuidanceTokens(resolved) > caps.maxTokens && resolved.context_files.length > 0) {
    const dropped = resolved.context_files[resolved.context_files.length - 1];
    if (dropped !== undefined) {
      notes.push(
        `context file '${dropped.path}' dropped: total augmentation token budget exceeded`,
      );
    }
    resolved = {
      ...resolved,
      context_files: resolved.context_files.slice(0, -1),
    };
  }

  // If still over budget after dropping all context files, truncate path instructions.
  while (
    estimateGuidanceTokens(resolved) > caps.maxTokens &&
    resolved.matched_path_instructions.length > 0
  ) {
    const dropped =
      resolved.matched_path_instructions[resolved.matched_path_instructions.length - 1];
    if (dropped !== undefined) {
      notes.push(
        `path instruction for '${dropped.path}' dropped: total augmentation token budget exceeded`,
      );
    }
    resolved = {
      ...resolved,
      matched_path_instructions: resolved.matched_path_instructions.slice(0, -1),
    };
  }

  // If still over budget, truncate global instructions (last resort).
  if (estimateGuidanceTokens(resolved) > caps.maxTokens && resolved.instructions !== undefined) {
    notes.push('global instructions truncated: total augmentation token budget exceeded');
    // Remove global instructions entirely as a last resort.
    const { instructions: _dropped, ...rest } = resolved;
    void _dropped;
    resolved = rest as CustomGuidance;
  }

  // If nothing remains after budget enforcement, return undefined.
  const hasContent =
    resolved.instructions !== undefined ||
    resolved.matched_path_instructions.length > 0 ||
    resolved.context_files.length > 0;
  if (!hasContent) {
    return { guidance: undefined, notes };
  }

  return { guidance: resolved, notes };
};
