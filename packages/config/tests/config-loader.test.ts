import { DEFAULT_REPO_CONFIG } from '@prisma-bot/shared';
import { describe, expect, it } from 'vitest';
import { ConfigParseError, loadRepoConfig, parseRepoConfigYaml } from '../src/index.js';

const WORKED_EXAMPLE_YAML = `enabled: true
mode: dry-run
provider: anthropic
model: claude-4-class-model-id
thresholds:
  severity_floor:
    inline: medium
  confidence_floor:
    inline: 0.7
comment_cap:
  per_pr: 5
  per_file: 1
path_rules:
  include:
    - "src/**"
  exclude:
    - "src/generated/**"
exclude_generated: true
exclude_vendored: true
max_files: 50
max_changed_lines: 2000
categories_enabled:
  - security
  - correctness
  - performance
  - tests
  - style
  - migration
  - dependency
severity:
  tests: low
  style: info
language_overrides:
  typescript:
    thresholds:
      confidence_floor:
        inline: 0.8
repo_heuristics:
  security: true
  tests: true
  migrations: true
  layering: true
`;

describe('loadRepoConfig', () => {
  it('returns DEFAULT_REPO_CONFIG when yamlContents is null', () => {
    const cfg = loadRepoConfig({ yamlContents: null });
    expect(cfg).toEqual(DEFAULT_REPO_CONFIG);
    // OQ-2 defaults explicit assertions
    expect(cfg.mode).toBe('dry-run');
    expect(cfg.comment_cap.per_pr).toBe(5);
    expect(cfg.comment_cap.per_file).toBe(1);
    expect(cfg.thresholds.severity_floor.inline).toBe('medium');
    expect(cfg.thresholds.confidence_floor.inline).toBe(0.7);
    expect(cfg.provider).toBe('anthropic');
  });

  it('parses the complete worked example YAML from config-spec.md', () => {
    const cfg = loadRepoConfig({ yamlContents: WORKED_EXAMPLE_YAML });
    expect(cfg.mode).toBe('dry-run');
    expect(cfg.comment_cap.per_pr).toBe(5);
    expect(cfg.comment_cap.per_file).toBe(1);
    expect(cfg.thresholds.severity_floor.inline).toBe('medium');
    expect(cfg.thresholds.confidence_floor.inline).toBe(0.7);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-4-class-model-id');
    expect(cfg.path_rules.include).toEqual(['src/**']);
    expect(cfg.path_rules.exclude).toEqual(['src/generated/**']);
    expect(cfg.exclude_generated).toBe(true);
    expect(cfg.exclude_vendored).toBe(true);
    expect(cfg.max_files).toBe(50);
    expect(cfg.max_changed_lines).toBe(2000);
    expect(cfg.categories_enabled).toEqual([
      'security',
      'correctness',
      'performance',
      'tests',
      'style',
      'migration',
      'dependency',
    ]);
    expect(cfg.severity).toEqual({ tests: 'low', style: 'info' });
    expect(cfg.language_overrides.typescript?.thresholds?.confidence_floor.inline).toBe(0.8);
    expect(cfg.repo_heuristics).toEqual({
      security: true,
      tests: true,
      migrations: true,
      layering: true,
    });
  });

  it('partial YAML (only mode) merges with defaults; caps and floors stay at defaults', () => {
    const cfg = loadRepoConfig({ yamlContents: 'mode: summary-plus-inline\n' });
    expect(cfg.mode).toBe('summary-plus-inline');
    expect(cfg.comment_cap.per_pr).toBe(5);
    expect(cfg.comment_cap.per_file).toBe(1);
    expect(cfg.thresholds.severity_floor.inline).toBe('medium');
    expect(cfg.thresholds.confidence_floor.inline).toBe(0.7);
    expect(cfg.provider).toBe('anthropic');
  });

  it('throws ConfigParseError with code "invalid_yaml" for invalid YAML syntax', () => {
    // ":" without a key is a YAML parse error.
    let caught: unknown;
    try {
      parseRepoConfigYaml('mode: [unterminated\n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigParseError);
    expect((caught as ConfigParseError).code).toBe('invalid_yaml');
  });

  it('throws ConfigParseError with code "schema_violation" for an unknown mode value', () => {
    let caught: unknown;
    try {
      parseRepoConfigYaml('mode: invalid-mode\n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigParseError);
    expect((caught as ConfigParseError).code).toBe('schema_violation');
    expect((caught as ConfigParseError).message).toContain('mode');
  });

  it('warns-and-ignores unknown top-level keys (config-spec.md § Failure modes)', () => {
    const cfg = loadRepoConfig({
      yamlContents: 'mode: summary-only\nfuture_unknown_key: ok\n',
    });
    expect(cfg.mode).toBe('summary-only');
    // Unknown key absent from the resulting object.
    expect((cfg as Record<string, unknown>).future_unknown_key).toBeUndefined();
  });

  it('throws ConfigParseError with code "schema_violation" for type mismatch on a known key', () => {
    let caught: unknown;
    try {
      parseRepoConfigYaml('comment_cap:\n  per_pr: "five"\n  per_file: 1\n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigParseError);
    expect((caught as ConfigParseError).code).toBe('schema_violation');
    expect((caught as ConfigParseError).message).toContain('per_pr');
  });
});
