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
