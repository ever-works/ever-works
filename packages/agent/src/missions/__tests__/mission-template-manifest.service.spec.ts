import {
    EMPTY_MISSION_TEMPLATE_MANIFEST,
    MissionTemplateManifestService,
    type MissionTemplateManifest,
    type MissionTemplateManifestParseResult,
} from '../mission-template-manifest.service';

// Helper narrowers — the agent package compiles with
// `strictNullChecks: false`, so TS's discriminated-union narrowing on
// `result.ok` doesn't fire cleanly inside `if` blocks. Cast explicitly.
type ParseOk = Extract<MissionTemplateManifestParseResult, { ok: true }>;
type ParseErr = Extract<MissionTemplateManifestParseResult, { ok: false }>;
const asOk = (r: MissionTemplateManifestParseResult) => r as ParseOk;
const asErr = (r: MissionTemplateManifestParseResult) => r as ParseErr;

describe('MissionTemplateManifestService', () => {
    let service: MissionTemplateManifestService;

    beforeEach(() => {
        service = new MissionTemplateManifestService();
    });

    describe('parse — empty / null inputs (Decision A21: manifest is optional)', () => {
        it('returns empty manifest for null input', () => {
            const result = service.parse(null);
            expect(result).toEqual({ ok: true, manifest: EMPTY_MISSION_TEMPLATE_MANIFEST });
        });

        it('returns empty manifest for undefined input', () => {
            const result = service.parse(undefined);
            expect(result).toEqual({ ok: true, manifest: EMPTY_MISSION_TEMPLATE_MANIFEST });
        });

        it('returns empty manifest for empty string', () => {
            const result = service.parse('');
            expect(result).toEqual({ ok: true, manifest: EMPTY_MISSION_TEMPLATE_MANIFEST });
        });

        it('returns empty manifest for whitespace-only string', () => {
            const result = service.parse('   \n  \t  \n');
            expect(result).toEqual({ ok: true, manifest: EMPTY_MISSION_TEMPLATE_MANIFEST });
        });

        it('returns empty manifest for YAML document that parses to null (`~`)', () => {
            const result = service.parse('~');
            expect(result).toEqual({ ok: true, manifest: EMPTY_MISSION_TEMPLATE_MANIFEST });
        });

        it('returns empty manifest for YAML doc with only comments', () => {
            const result = service.parse('# just a comment\n# nothing else here');
            expect(result).toEqual({ ok: true, manifest: EMPTY_MISSION_TEMPLATE_MANIFEST });
        });
    });

    describe('parse — minimal valid manifests', () => {
        it('parses a manifest with only version', () => {
            const result = service.parse('version: 1');
            expect(result.ok).toBe(true);
            expect(asOk(result).manifest.version).toBe(1);
        });

        it('parses a manifest with only defaults.cadence', () => {
            const result = service.parse('defaults:\n  cadence: "0 9 * * *"');
            expect(result.ok).toBe(true);
            expect(asOk(result).manifest.defaults?.cadence).toBe('0 9 * * *');
        });

        it('parses a manifest with only recommendedWorkTemplates', () => {
            const result = service.parse(
                'recommendedWorkTemplates:\n  - directory-classic\n  - blog-modern',
            );
            expect(result.ok).toBe(true);
            expect(asOk(result).manifest.recommendedWorkTemplates).toEqual([
                'directory-classic',
                'blog-modern',
            ]);
        });
    });

    describe('parse — full valid manifest', () => {
        it('parses a full v1 manifest with all sections', () => {
            const yaml = `
version: 1
defaults:
  cadence: "0 */6 * * *"
  autoBuildWorks: true
  outstandingIdeasCap: 10
  guardrails:
    maxWorksPerRun: 3
    maxItemsPerWork: 50
    maxBudgetCentsPerRun: 5000
    requireApprovalBeforeCreate: false
    requireApprovalBeforeDelete: true
    requireApprovalAboveBudgetCents: 1000
    dryRunByDefault: false
kb:
  seedPaths:
    - README.md
    - docs/strategy.md
    - prompts/seed-ideas.md
recommendedWorkTemplates:
  - directory-classic
  - blog-modern
`;
            const result = service.parse(yaml);
            expect(result.ok).toBe(true);
            const { manifest } = asOk(result);
            expect(manifest.version).toBe(1);
            expect(manifest.defaults?.cadence).toBe('0 */6 * * *');
            expect(manifest.defaults?.autoBuildWorks).toBe(true);
            expect(manifest.defaults?.outstandingIdeasCap).toBe(10);
            expect(manifest.defaults?.guardrails).toEqual({
                maxWorksPerRun: 3,
                maxItemsPerWork: 50,
                maxBudgetCentsPerRun: 5000,
                requireApprovalBeforeCreate: false,
                requireApprovalBeforeDelete: true,
                requireApprovalAboveBudgetCents: 1000,
                dryRunByDefault: false,
            });
            expect(manifest.kb?.seedPaths).toEqual([
                'README.md',
                'docs/strategy.md',
                'prompts/seed-ideas.md',
            ]);
            expect(manifest.recommendedWorkTemplates).toEqual([
                'directory-classic',
                'blog-modern',
            ]);
        });

        it('accepts outstandingIdeasCap of -1 (unlimited)', () => {
            const result = service.parse('defaults:\n  outstandingIdeasCap: -1');
            expect(result.ok).toBe(true);
            expect(asOk(result).manifest.defaults?.outstandingIdeasCap).toBe(-1);
        });
    });

    describe('parse — forward-compat (Decision A22: unknown keys tolerated)', () => {
        it('preserves unknown top-level keys via passthrough', () => {
            const yaml = `
version: 1
futureField: hello
anotherFutureField:
  nested: value
`;
            const result = service.parse(yaml);
            expect(result.ok).toBe(true);
            const m = asOk(result).manifest as MissionTemplateManifest & {
                futureField?: string;
                anotherFutureField?: { nested: string };
            };
            expect(m.futureField).toBe('hello');
            expect(m.anotherFutureField).toEqual({ nested: 'value' });
        });

        it('preserves unknown nested keys inside defaults', () => {
            const yaml = `
defaults:
  cadence: "0 9 * * *"
  futureDefault: 42
`;
            const result = service.parse(yaml);
            expect(result.ok).toBe(true);
            const defaults = asOk(result).manifest.defaults as
                | (MissionTemplateManifest['defaults'] & { futureDefault?: number })
                | undefined;
            expect(defaults?.cadence).toBe('0 9 * * *');
            expect(defaults?.futureDefault).toBe(42);
        });

        it('preserves unknown nested keys inside guardrails', () => {
            const yaml = `
defaults:
  guardrails:
    maxWorksPerRun: 3
    futureGuardrail: experimental
`;
            const result = service.parse(yaml);
            expect(result.ok).toBe(true);
            const guardrails = asOk(result).manifest.defaults?.guardrails as
                | (Record<string, unknown> & { futureGuardrail?: string })
                | undefined;
            expect(guardrails?.maxWorksPerRun).toBe(3);
            expect(guardrails?.futureGuardrail).toBe('experimental');
        });
    });

    describe('parse — YAML syntax errors', () => {
        it('returns errorKind="yaml" for malformed YAML', () => {
            // Unclosed flow mapping triggers a YAML parse error.
            const result = service.parse('{ unclosed: bracket');
            expect(result.ok).toBe(false);
            const err = asErr(result);
            expect(err.errorKind).toBe('yaml');
            expect(typeof err.message).toBe('string');
            expect(err.message.length).toBeGreaterThan(0);
        });

        it('returns errorKind="yaml" for tab-indented mapping (YAML forbids tabs for indent)', () => {
            const result = service.parse('defaults:\n\tcadence: foo');
            expect(result.ok).toBe(false);
            expect(asErr(result).errorKind).toBe('yaml');
        });
    });

    describe('parse — schema mismatches', () => {
        it('returns errorKind="schema" when cadence is a number', () => {
            const result = service.parse('defaults:\n  cadence: 42');
            expect(result.ok).toBe(false);
            const err = asErr(result);
            expect(err.errorKind).toBe('schema');
            expect(err.message).toContain('Manifest schema mismatch');
            expect(err.issues).toBeDefined();
            expect(err.issues?.[0]?.path).toEqual(['defaults', 'cadence']);
        });

        it('returns errorKind="schema" when outstandingIdeasCap is < -1', () => {
            const result = service.parse('defaults:\n  outstandingIdeasCap: -5');
            expect(result.ok).toBe(false);
            expect(asErr(result).errorKind).toBe('schema');
        });

        it('returns errorKind="schema" when recommendedWorkTemplates is not an array', () => {
            const result = service.parse('recommendedWorkTemplates: "not-a-list"');
            expect(result.ok).toBe(false);
            expect(asErr(result).errorKind).toBe('schema');
        });

        it('returns errorKind="schema" when kb.seedPaths contains an empty string', () => {
            const result = service.parse('kb:\n  seedPaths:\n    - ""');
            expect(result.ok).toBe(false);
            expect(asErr(result).errorKind).toBe('schema');
        });

        it('returns errorKind="schema" when version is zero or negative', () => {
            const result = service.parse('version: 0');
            expect(result.ok).toBe(false);
            expect(asErr(result).errorKind).toBe('schema');
        });

        it('caps the summary message at the first 3 issues for readability', () => {
            // Five obvious schema errors at once.
            const yaml = `
version: -1
defaults:
  cadence: 99
  autoBuildWorks: "yes"
  outstandingIdeasCap: "nope"
recommendedWorkTemplates: 42
`;
            const result = service.parse(yaml);
            expect(result.ok).toBe(false);
            const err = asErr(result);
            expect(err.errorKind).toBe('schema');
            // The full issue list is returned but the SUMMARY only
            // includes the first 3 — count `; ` separators in summary.
            const summary = err.message.replace('Manifest schema mismatch: ', '');
            const segmentCount = summary.split('; ').length;
            expect(segmentCount).toBeLessThanOrEqual(3);
            expect(err.issues?.length ?? 0).toBeGreaterThanOrEqual(3);
        });
    });

    describe('applyDefaults', () => {
        it('returns the input unchanged when manifest has no defaults', () => {
            const input = { schedule: undefined, autoBuildWorks: undefined };
            const out = service.applyDefaults(input, {});
            expect(out).toEqual(input);
        });

        it('fills in manifest defaults when caller fields are undefined', () => {
            const input: {
                schedule?: string | null;
                autoBuildWorks?: boolean;
                outstandingIdeasCap?: number | null;
                guardrailsOverride?: Record<string, unknown> | null;
            } = {};
            const manifest: MissionTemplateManifest = {
                defaults: {
                    cadence: '0 */4 * * *',
                    autoBuildWorks: true,
                    outstandingIdeasCap: 7,
                    guardrails: { maxWorksPerRun: 2 },
                },
            };
            const out = service.applyDefaults(input, manifest);
            expect(out.schedule).toBe('0 */4 * * *');
            expect(out.autoBuildWorks).toBe(true);
            expect(out.outstandingIdeasCap).toBe(7);
            expect(out.guardrailsOverride).toEqual({ maxWorksPerRun: 2 });
        });

        it('caller-supplied values WIN over manifest defaults (manifest is a starting point)', () => {
            const input = {
                schedule: '0 0 * * 0' as string | null,
                autoBuildWorks: false,
                outstandingIdeasCap: 100 as number | null,
                guardrailsOverride: { maxWorksPerRun: 99 } as Record<string, unknown> | null,
            };
            const manifest: MissionTemplateManifest = {
                defaults: {
                    cadence: '0 */4 * * *',
                    autoBuildWorks: true,
                    outstandingIdeasCap: 7,
                    guardrails: { maxWorksPerRun: 2 },
                },
            };
            const out = service.applyDefaults(input, manifest);
            expect(out.schedule).toBe('0 0 * * 0');
            expect(out.autoBuildWorks).toBe(false);
            expect(out.outstandingIdeasCap).toBe(100);
            expect(out.guardrailsOverride).toEqual({ maxWorksPerRun: 99 });
        });

        it('caller `null` (explicit reset) is NOT overwritten by manifest defaults', () => {
            // null means "explicitly reset" — only `undefined` means
            // "caller didn't say". Verify the gate uses `=== undefined`.
            const input: {
                schedule?: string | null;
                outstandingIdeasCap?: number | null;
                guardrailsOverride?: Record<string, unknown> | null;
            } = {
                schedule: null,
                outstandingIdeasCap: null,
                guardrailsOverride: null,
            };
            const manifest: MissionTemplateManifest = {
                defaults: {
                    cadence: '0 */4 * * *',
                    outstandingIdeasCap: 7,
                    guardrails: { maxWorksPerRun: 2 },
                },
            };
            const out = service.applyDefaults(input, manifest);
            expect(out.schedule).toBeNull();
            expect(out.outstandingIdeasCap).toBeNull();
            expect(out.guardrailsOverride).toBeNull();
        });

        it('partially fills in only the fields the manifest provides', () => {
            const input: {
                schedule?: string | null;
                autoBuildWorks?: boolean;
            } = {};
            const manifest: MissionTemplateManifest = {
                defaults: { cadence: '0 9 * * *' },
            };
            const out = service.applyDefaults(input, manifest);
            expect(out.schedule).toBe('0 9 * * *');
            expect(out.autoBuildWorks).toBeUndefined();
        });

        it('passes through unknown guardrail fields onto the merged input', () => {
            // The entity's `guardrailsOverride` JSON column accepts
            // arbitrary shapes, so extra fields in the manifest's
            // guardrails block come along for the ride.
            const input: { guardrailsOverride?: Record<string, unknown> | null } = {};
            const parsed = service.parse(
                'defaults:\n  guardrails:\n    maxWorksPerRun: 5\n    futureField: kept',
            );
            expect(parsed.ok).toBe(true);
            const out = service.applyDefaults(input, asOk(parsed).manifest);
            expect(out.guardrailsOverride).toEqual({
                maxWorksPerRun: 5,
                futureField: 'kept',
            });
        });

        it('does not mutate the input object', () => {
            const input = { schedule: undefined as string | null | undefined };
            const manifest: MissionTemplateManifest = {
                defaults: { cadence: '0 9 * * *' },
            };
            const out = service.applyDefaults(input, manifest);
            expect(input.schedule).toBeUndefined();
            expect(out.schedule).toBe('0 9 * * *');
            expect(out).not.toBe(input);
        });
    });
});
