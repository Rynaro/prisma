/**
 * Command parser module — pure functions, no Octokit/GitHub dependency.
 * Lives in `shared` so both the ingress (cheap pre-filter) and the worker
 * (authoritative resolution) can import it.
 *
 * Per spec § Track 4:
 *   - `parseMentionCandidate` — cheap ingress regex; first-line only; returns
 *     null fast for non-mentions (no I/O).
 *   - `parseCommand` — maps the remainder after the mention to the v1 vocabulary.
 *   - `requiresWrite` — gate seam for follow-up write-gated commands; currently
 *     returns false for all v1 commands.
 */

// ---------------------------------------------------------------------------
// parseMentionCandidate
// ---------------------------------------------------------------------------

/**
 * Result of a successful mention candidate parse.
 */
export interface MentionCandidateResult {
  /** The login-shaped token following `@`. */
  candidate: string;
  /** The remainder of the first line after the mention token (trimmed). */
  rest: string;
}

/**
 * Cheap ingress pre-filter. Matches a `@<login>` at the start of the comment
 * body (leading whitespace allowed), case-insensitive, first line only.
 *
 * Returns `null` fast for non-mentions — no I/O, no config fetch.
 * Does NOT validate whether the candidate is the bot's login or a configured
 * nickname; that authoritative check is done in the worker.
 */
export const parseMentionCandidate = (body: string): MentionCandidateResult | null => {
  // Only inspect the first line of the comment.
  const firstLine = body.split('\n')[0] ?? '';
  // Pattern: optional leading whitespace, @<login>, optional trailing content.
  // Login-shaped: starts with alphanumeric, may contain hyphens, max 39 chars.
  const re = /^\s*@(?<candidate>[A-Za-z0-9][A-Za-z0-9-]{0,38})\b\s*(?<rest>.*)/i;
  const m = re.exec(firstLine);
  if (m === null || m.groups === undefined) {
    return null;
  }
  const candidate = m.groups.candidate;
  const rest = (m.groups.rest ?? '').trim();
  if (candidate === undefined || candidate.length === 0) {
    return null;
  }
  return { candidate, rest };
};

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

/**
 * V1 command vocabulary (closed discriminated union).
 */
export type Command =
  | { kind: 'review' }
  | { kind: 'full_review' }
  | { kind: 'help'; unknown: boolean }
  | { kind: 'configuration' };

/**
 * Map the text remainder after the `@<mention>` token to a v1 `Command`.
 * Comparison is case-insensitive and whitespace-normalized.
 * Unknown or empty input → `{ kind: 'help', unknown: true }` (graceful degradation).
 */
export const parseCommand = (rest: string): Command => {
  const normalized = rest.trim().toLowerCase().replace(/\s+/g, ' ');

  if (normalized === 'review') {
    return { kind: 'review' };
  }
  if (normalized === 'full review') {
    return { kind: 'full_review' };
  }
  if (normalized === 'help') {
    return { kind: 'help', unknown: false };
  }
  if (normalized === 'configuration' || normalized === 'config') {
    return { kind: 'configuration' };
  }

  // Unknown or empty → help with unknown flag set.
  return { kind: 'help', unknown: true };
};

// ---------------------------------------------------------------------------
// requiresWrite
// ---------------------------------------------------------------------------

/**
 * Gate seam for write-gated commands. All v1 commands are read-only;
 * this always returns `false`. The seam exists so follow-up commands
 * (`pause`, `resume`, `resolve`) can be added with a one-line change.
 */
export const requiresWrite = (_cmd: Command): boolean => {
  return false;
};
