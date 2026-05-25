import { Injectable, Logger } from '@nestjs/common';
import YAML from 'yaml';
import { z } from 'zod';

/**
 * Phase 8 PR JJ — Mission Template manifest parser
 * (Decisions A21 + A22).
 *
 * Each Mission Template repo ships a `.works/mission.yml` that
 * describes everything beyond the catalog-row metadata: cadence
 * + autoBuildWorks + outstandingIdeasCap defaults the spawned
 * Mission should adopt, a `kb.seedPaths` list of files the
 * scaffolder copies into the new `<slug>-mission` repo, and a
 * `recommendedWorkTemplates` list the Idea→Work scaffolder uses
 * to pre-pick build targets for spawned Ideas.
 *
 * This service is a PURE parser — no DI deps, no I/O. The
 * per-Mission scaffolder (Phase 8 PR X.2) is the I/O caller: it
 * reads the YAML out of the template repo via gitFacade, hands
 * the string here, applies the parsed defaults to the new
 * Mission row, and copies seed files at fork time.
 *
 * Forward-compat (Decision A22): unknown top-level keys AND
 * unknown nested keys are TOLERATED, not rejected. We use
 * `.passthrough()` on every object so a future template version
 * can add fields without breaking older agent versions. The
 * downside — typos pass silently — is the right trade for the
 * forward-compat guarantee.
 *
 * Validation failures fall into one of three categories:
 *   - YAML syntax error → `{ ok: false, errorKind: 'yaml',
 *     message }`
 *   - Schema mismatch (e.g. cadence is a number not a string)
 *     → `{ ok: false, errorKind: 'schema', message, issues }`
 *   - Empty document (manifest is technically optional per
 *     A21; treat empty as the all-defaults case) → `{ ok:
 *     true, manifest: emptyManifest }`
 */

// Guardrails shape — sparse mirror of the agent's
// `WorkAgentGuardrails`. Kept inline rather than re-importing
// the entity type because the manifest schema is a public
// contract that lives in template repos; coupling it tightly
// to a moving entity shape would make breaking changes
// uncomfortable. Both shapes evolve together when they do.
const guardrailsSchema = z
    .object({
        maxWorksPerRun: z.number().int().positive().optional(),
        maxItemsPerWork: z.number().int().positive().optional(),
        maxBudgetCentsPerRun: z.number().int().min(0).optional(),
        requireApprovalBeforeCreate: z.boolean().optional(),
        requireApprovalBeforeDelete: z.boolean().optional(),
        requireApprovalAboveBudgetCents: z.number().int().min(0).optional(),
        dryRunByDefault: z.boolean().optional(),
    })
    .passthrough();

const defaultsSchema = z
    .object({
        /** Cron string. NULL/omitted = the Mission stays one-shot. */
        cadence: z.string().min(1).max(64).optional(),
        autoBuildWorks: z.boolean().optional(),
        /** -1 = unlimited; null/omitted = inherit user-level default. */
        outstandingIdeasCap: z.number().int().min(-1).optional(),
        guardrails: guardrailsSchema.optional(),
    })
    .passthrough();

const kbSchema = z
    .object({
        /**
         * Paths inside the template repo whose contents the
         * scaffolder should copy into the new Mission repo at
         * fork time. Paths are RELATIVE to the template repo
         * root, no leading slash. Globs not supported in v1 —
         * keeps the fork step predictable.
         */
        seedPaths: z.array(z.string().min(1).max(500)).max(200).optional(),
    })
    .passthrough();

const manifestSchema = z
    .object({
        /**
         * Spec version. v1 templates omit this; future versions
         * can bump it for breaking schema changes.
         */
        version: z.number().int().positive().optional(),
        defaults: defaultsSchema.optional(),
        kb: kbSchema.optional(),
        /**
         * Work-template ids the Idea→Work scaffolder should
         * pre-select when spawning Works from this Mission's
         * Ideas. Strings match the Template entity `id` column.
         */
        recommendedWorkTemplates: z.array(z.string().min(1).max(120)).max(50).optional(),
    })
    .passthrough();

export type MissionTemplateManifest = z.infer<typeof manifestSchema>;

/** Empty-but-valid manifest, returned when the YAML doc is
 *  null/empty (Decision A21: manifest is optional). */
export const EMPTY_MISSION_TEMPLATE_MANIFEST: MissionTemplateManifest = {};

export type MissionTemplateManifestParseResult =
    | { ok: true; manifest: MissionTemplateManifest }
    | { ok: false; errorKind: 'yaml' | 'schema'; message: string; issues?: z.ZodIssue[] };

@Injectable()
export class MissionTemplateManifestService {
    private readonly logger = new Logger(MissionTemplateManifestService.name);

    /**
     * Parse a YAML manifest string. Empty input → empty manifest.
     * Garbage YAML → `{ ok: false, errorKind: 'yaml' }`. Schema
     * mismatch → `{ ok: false, errorKind: 'schema' }` with the
     * full Zod issue list for diagnostics.
     */
    parse(yamlInput: string | null | undefined): MissionTemplateManifestParseResult {
        if (yamlInput === null || yamlInput === undefined) {
            return { ok: true, manifest: { ...EMPTY_MISSION_TEMPLATE_MANIFEST } };
        }
        const trimmed = yamlInput.trim();
        if (trimmed.length === 0) {
            return { ok: true, manifest: { ...EMPTY_MISSION_TEMPLATE_MANIFEST } };
        }

        let raw: unknown;
        try {
            raw = YAML.parse(trimmed);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, errorKind: 'yaml', message };
        }

        // YAML can parse a valid doc that's just `null` or
        // `~` — Decision A21 says that counts as the empty
        // manifest, not a schema error.
        if (raw === null || raw === undefined) {
            return { ok: true, manifest: { ...EMPTY_MISSION_TEMPLATE_MANIFEST } };
        }

        const result = manifestSchema.safeParse(raw);
        if (!result.success) {
            const issues = result.error.issues;
            const summary = issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                .join('; ');
            return {
                ok: false,
                errorKind: 'schema',
                message: `Manifest schema mismatch: ${summary}`,
                issues,
            };
        }

        return { ok: true, manifest: result.data };
    }

    /**
     * Apply the parsed manifest's defaults to a Mission-create
     * input. Caller-supplied fields TAKE PRECEDENCE over the
     * template defaults (the manifest is a starting point, not
     * an enforcement layer). Unknown manifest fields are
     * preserved on the input as-is — the caller decides what to
     * do with them (typically: pass through to entity write).
     *
     * This helper keeps the application logic out of PR X.2's
     * scaffolder code so the scaffolder only needs to know
     * "given a manifest + my create input, give me the merged
     * input".
     */
    applyDefaults<
        T extends {
            schedule?: string | null;
            autoBuildWorks?: boolean;
            outstandingIdeasCap?: number | null;
            guardrailsOverride?: Record<string, unknown> | null;
        },
    >(input: T, manifest: MissionTemplateManifest): T {
        const defaults = manifest.defaults;
        if (!defaults) return input;
        const merged: T = { ...input };
        // Caller-supplied wins. Only fill in fields the caller
        // left undefined.
        if (merged.schedule === undefined && typeof defaults.cadence === 'string') {
            merged.schedule = defaults.cadence;
        }
        if (merged.autoBuildWorks === undefined && typeof defaults.autoBuildWorks === 'boolean') {
            merged.autoBuildWorks = defaults.autoBuildWorks;
        }
        if (
            merged.outstandingIdeasCap === undefined &&
            typeof defaults.outstandingIdeasCap === 'number'
        ) {
            merged.outstandingIdeasCap = defaults.outstandingIdeasCap;
        }
        if (merged.guardrailsOverride === undefined && defaults.guardrails) {
            // `defaults.guardrails` is a Zod-passthrough object so
            // it may contain extra fields the entity doesn't know
            // about — pass them through anyway; the entity's JSON
            // column accepts arbitrary shapes.
            merged.guardrailsOverride = { ...defaults.guardrails };
        }
        return merged;
    }
}
