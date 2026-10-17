/**
 * `model-slug.ts` — pure slug parser for the vendor-neutral `model: provider/name`
 * config surface introduced in the easy-settings feature.
 *
 * Design spec: docs/_planning/config-dx/spec.md § 5.1 (OQ-2).
 * Design doc:  docs/_planning/config-dx/design.md § Proposed schema.
 *
 * ── Slug grammar ──────────────────────────────────────────────────────────────
 *   <slug>  ::= <provider> "/" <name>   (qualified)
 *             | <name>                  (bare — default provider)
 *
 * Parsing rules (spec § 4 edge cases):
 *   - "provider/name"   → { provider: "provider", model: "name" } — happy path
 *   - "name"            → { provider: undefined, model: "name" }  — bare slug
 *   - "provider/"       → invalid (empty name); warn + return undefined model
 *   - "/name"           → charitable parse: treat as bare "name" (empty provider
 *                         is set to undefined), emit a warning note
 *   - "a/b/c" (>1 /)   → ambiguous; warn + return undefined (fallback to env)
 *   - ""                → no override; return { provider: undefined, model: undefined }
 *
 * The function NEVER throws.  It returns a `notes` array for every non-fatal
 * parse issue; callers push these into `configNotes` so they surface in the
 * check-run summary and the `configuration` reply.
 *
 * Per spec OQ-2: this module is the single source of slug parsing — imported
 * by the orchestrator, the worker (`buildConfigReply`), and tests.  It has NO
 * dependency on `zod` or any schema module (pure JS/TS, easily tree-shaken).
 *
 * @module model-slug
 */

/**
 * Set of first-class provider slugs this release ships adapters for.  Used to
 * emit a config note when the slug names an unrecognised provider (spec § 4
 * "Unknown provider in slug").  Does NOT block parsing — forward-compat matters
 * more than hard-failing on provider names added by future adapters.
 */
const KNOWN_PROVIDERS = new Set(['openai', 'anthropic', 'copilot', 'fake']);

// ---------------------------------------------------------------------------
// Reasoning-family detector — shared single source of truth
// (see also the "Claude model-ID parser" banner below `isReasoningModel`)
// ---------------------------------------------------------------------------

/**
 * `REASONING_MODEL_RE` — regex that identifies OpenAI reasoning-family models
 * (o-series, gpt-5+ and `chat-latest`) from a bare model identifier (no
 * `provider/` prefix).
 *
 * Pattern rationale:
 *   - `o[1-9]`       — o-series: o1, o3, o4, o4-mini, …
 *   - `gpt-[5-9]`    — gpt-5, gpt-5.4-nano, gpt-6, gpt-6-astra, gpt-6.1-sol, …
 *   - `gpt-\d{2,}`   — gpt-10, gpt-11, … (future two-digit major versions)
 *   - `chat-latest$` — the moving `chat-latest` alias (currently a GPT-6
 *                      snapshot). Matched EXACTLY: the `$` anchors the end, so
 *                      `chat-latest-2026` and `chat-latestx` do not match.
 *
 * Classic models (`gpt-4o`, `gpt-4`, `gpt-4.1`, `gpt-3.5-turbo`) do NOT
 * match: `gpt-4` has a single-digit major ≤ 4; `gpt-4o` has a letter suffix.
 *
 * Anchored at the start to avoid false positives in suffix tokens.
 * The `i` flag is defensive for mixed-case API identifiers.
 *
 * This is the ONE family predicate (GPT-6 compat spec § 6 G-2): token param,
 * `tool_choice`, endpoint (`/responses`), tokenizer, default output cap,
 * sampling strip, the reasoning nudge and the empty-review notice all key off
 * it. No other regex may decide any of those.
 *
 * References:
 *   - OpenAI reasoning model docs: https://platform.openai.com/docs/guides/reasoning
 *   - The empty-review root cause: reasoning models' interleaved thinking is
 *     short-circuited when `tool_choice` names a specific function; they
 *     skip reasoning and emit an empty call. Detected models use
 *     `tool_choice: 'required'` instead.
 */
const REASONING_MODEL_RE = /^(o[1-9]|gpt-(?:[5-9]|\d{2,})|chat-latest$)/i;

/**
 * `isReasoningModel` — returns `true` when `model` belongs to the OpenAI
 * reasoning family (o-series, gpt-5+ or `chat-latest`) that requires
 * `tool_choice: 'required'` rather than a forced-specific function call.
 *
 * This is the **single source of truth** for the reasoning-family classification.
 * Both the OpenAI adapter (`resolveToolChoice`) and the orchestrator
 * (`no_findings` hint branch) import this helper so the classification is
 * never duplicated.
 *
 * @param model - Bare model identifier (no `provider/` prefix). The caller
 *                is responsible for stripping the prefix via `parseModelSlug`
 *                before calling this function.
 *
 * @returns `true`  for o1, o3, o4-mini, gpt-5, gpt-5.4-nano, gpt-6, gpt-6-astra,
 *                   gpt-6.1-sol, gpt-10, chat-latest, …
 *          `false` for gpt-4o, gpt-4.1, gpt-4, gpt-3.5-turbo, chat-latest-2026, …
 *
 * Exported from `@prisma-bot/shared` so every package that needs the
 * classification imports from one place.
 */
export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_RE.test(model);
}

// ---------------------------------------------------------------------------
// Claude model-ID parser — shared single source of truth (ADR-009 D1)
// ---------------------------------------------------------------------------

export interface ClaudeModelId {
  /** Lower-cased letters: opus | sonnet | haiku | fable | mythos | … */
  family: string;
  major: number;
  /** `undefined` for `claude-opus-5` and when the second group is a date. */
  minor: number | undefined;
}

const CLAUDE_MODEL_ID_RE = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i;
const DATE_GROUP_RE = /^\d{8}$/;

/**
 * `parseClaudeModelId` — parse a Claude model ID of the form
 * `claude-<family>-<major>[-<minor>][-<date>]`.
 *
 * - Unanchored and case-insensitive, so gateway/Bedrock-style prefixes
 *   (`us.anthropic.claude-opus-5-5`) and `CLAUDE-OPUS-5-5` parse.
 * - The family must be letters, so version-first IDs (`claude-3-5-sonnet-latest`,
 *   `claude-3-opus-20240229`) return `undefined`.
 * - An 8-digit group is a date, never a version: `claude-opus-4-20250514` is
 *   `{ opus, 4, undefined }`; an 8-digit major returns `undefined`.
 *
 * This is the ONLY Claude family source (ADR-009 G-2). The Anthropic adapter's
 * tool-choice mode, default output cap, context window and tokenizer family,
 * and the orchestrator's empty-review gate, all derive from it. Do not extend
 * `REASONING_MODEL_RE` for Claude.
 */
export function parseClaudeModelId(model: string): ClaudeModelId | undefined {
  const m = CLAUDE_MODEL_ID_RE.exec(model);
  if (m === null) return undefined;
  const family = m[1];
  const majorRaw = m[2];
  const minorRaw = m[3];
  if (family === undefined || majorRaw === undefined) return undefined;
  if (DATE_GROUP_RE.test(majorRaw)) return undefined;
  const minor =
    minorRaw === undefined || DATE_GROUP_RE.test(minorRaw)
      ? undefined
      : Number.parseInt(minorRaw, 10);
  return { family: family.toLowerCase(), major: Number.parseInt(majorRaw, 10), minor };
}

/**
 * `isClaudeAdaptiveThinkingModel` — `true` for Claude 5.x and later (adaptive
 * thinking on by default; forced `tool_choice` is rejected or skips thinking).
 */
export function isClaudeAdaptiveThinkingModel(model: string): boolean {
  const parsed = parseClaudeModelId(model);
  return parsed !== undefined && parsed.major >= 5;
}

export interface ParsedModelSlug {
  /** Provider portion of the slug, or `undefined` for a bare slug. */
  provider: string | undefined;
  /** Bare model name (no `provider/` prefix), or `undefined` if the slug was
   *  invalid or empty. */
  model: string | undefined;
  /** Human-readable config notes for any parse issues.  Empty on a clean parse.
   *  Callers should surface these via the `configNotes` mechanism. */
  notes: string[];
}

/**
 * `parseModelSlug` — resolve a raw `model:` config value into a structured
 * `{ provider, model, notes }` result.
 *
 * @param rawModel      - The raw string value of the `model:` key, or
 *                        `undefined`/empty when the key is absent.
 * @param legacyProvider - The legacy `provider:` key value (deprecated;
 *                         used only when `rawModel` is a bare name and no
 *                         `provider/` prefix is present).
 *
 * Returns:
 *   - `provider` — the resolved provider slug (from the `provider/` prefix, or
 *     from `legacyProvider` when the slug is bare, or `undefined`).
 *   - `model`    — the bare model name to put in `request_shaping.model`.
 *   - `notes`    — any deprecation or parse-warning strings.
 *
 * Spec references:
 *   AS-1  bare name → default provider (provider=legacyProvider|undefined)
 *   AS-2  slug parses provider + name
 *   AS-3  legacy provider: + bare model: → deprecation note
 *   AS-4  conflict (legacy provider ≠ slug provider) → slug wins + warning
 *   §4    edge cases (empty name, empty provider, >1 slash, unknown provider)
 */
export function parseModelSlug(
  rawModel: string | undefined,
  legacyProvider?: string,
): ParsedModelSlug {
  const notes: string[] = [];

  // --- absent / empty ---
  if (rawModel === undefined || rawModel.trim() === '') {
    // No model key at all.  Carry forward the legacy provider if present but
    // don't emit any notes (the absence is fine; env defaults take over).
    return { provider: legacyProvider, model: undefined, notes };
  }

  const slashCount = (rawModel.match(/\//g) ?? []).length;

  // --- more than one slash: ambiguous, fall back to env default ---
  if (slashCount > 1) {
    notes.push(
      `invalid model slug "${rawModel}": expected provider/name or a bare name — ignoring`,
    );
    return { provider: legacyProvider, model: undefined, notes };
  }

  // --- bare name (no slash) ---
  if (slashCount === 0) {
    // AS-1 / AS-3 path: bare name, use legacyProvider (if any).
    if (legacyProvider !== undefined) {
      // AS-3: legacy provider: + bare model: is the old pattern.  It still
      // works but we flag it as deprecated so operators know to migrate.
      notes.push(
        `model "${rawModel}" with legacy provider: "${legacyProvider}" is deprecated — use model: "${legacyProvider}/${rawModel}" instead`,
      );
    }
    return { provider: legacyProvider, model: rawModel, notes };
  }

  // --- qualified slug (exactly one slash): "provider/name" ---
  const slashIdx = rawModel.indexOf('/');
  const slugProvider = rawModel.slice(0, slashIdx);
  const slugModel = rawModel.slice(slashIdx + 1);

  // Edge: empty name → "openai/" or similar
  if (slugModel === '') {
    notes.push(`invalid model slug "${rawModel}": empty model name — ignoring model override`);
    return { provider: legacyProvider, model: undefined, notes };
  }

  // Edge: empty provider → "/gpt-4o" — charitable parse as bare name
  if (slugProvider === '') {
    notes.push(
      `model slug "${rawModel}": empty provider — treating "${slugModel}" as a bare model name`,
    );
    return { provider: legacyProvider, model: slugModel, notes };
  }

  // AS-4: conflict check — legacy provider: ≠ slug provider
  if (legacyProvider !== undefined && legacyProvider !== slugProvider) {
    notes.push(
      `model slug provider "${slugProvider}" overrides deprecated provider: "${legacyProvider}"`,
    );
  } else if (legacyProvider !== undefined && legacyProvider === slugProvider) {
    // Both set and they match — still deprecated but no conflict note needed;
    // just nudge toward the slug form.
    notes.push(
      `provider: "${legacyProvider}" is redundant with slug "${rawModel}" — set model: "${rawModel}" only`,
    );
  }

  // Emit a note for unrecognised providers (forward-compat, not an error).
  if (!KNOWN_PROVIDERS.has(slugProvider)) {
    notes.push(
      `model slug provider "${slugProvider}" is not a recognised provider; the active provider will be used`,
    );
  }

  // AS-2 happy path.
  return { provider: slugProvider, model: slugModel, notes };
}
