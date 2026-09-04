import { Injectable, Logger } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    loadPluginPackage,
    serializeManifest,
    serializeSkillMd,
    toSpecSkillName,
    type Finding,
    type NameNarrowing,
    type SerializeManifestInput,
} from '@ever-works/agent-plugins';

/**
 * Exports skills as a conforming Agent Plugins package (T35, AP-22/AP-23).
 *
 * ## The round-trip gate is the feature, not a check on it
 *
 * AP-22 requires that anything we export validates against our own importer.
 * That is not a nicety: a producer that emits packages its own consumer
 * rejects has published a format nobody can rely on, and the failure would
 * surface in someone else's client rather than in ours. So
 * {@link buildPackage} writes the package to a temporary directory, runs the
 * REAL `loadPluginPackage` over it, and refuses to return anything that does
 * not load — with the loader's own findings attached.
 *
 * Validating the in-memory strings instead would test a different thing.
 * Directory naming, the `skills/<name>/SKILL.md` layout and path containment
 * are facts about a tree, and the tree is what a consumer receives.
 */

/** A file in the exported package, keyed by its package-relative path. */
export type PackageFiles = ReadonlyMap<string, string>;

export interface ExportSkillInput {
    /** Platform slug. Narrowed to the spec's name rule, or reported. */
    readonly slug: string;
    readonly description: string;
    readonly body: string;
    readonly license?: string;
    readonly allowedTools?: readonly string[];
    readonly metadata?: Readonly<Record<string, string>>;
}

export interface ExportInput {
    readonly manifest: SerializeManifestInput;
    readonly skills: readonly ExportSkillInput[];
}

export interface ExportResult {
    readonly files: PackageFiles;
    /**
     * Skills whose slug could not be narrowed to a legal name.
     *
     * Reported rather than silently renamed. A renamed skill is a DIFFERENT
     * skill from the consumer's point of view — bindings, references and
     * documentation all key on the name — so the caller is given the
     * suggestion and asked, instead of having a rename applied behind them.
     */
    readonly rejected: readonly { slug: string; reason: string; suggestion?: string }[];
    /** Non-fatal findings the importer reported while validating the result. */
    readonly findings: readonly Finding[];
}

export class ExportFailed extends Error {
    constructor(
        message: string,
        readonly findings: readonly Finding[],
    ) {
        super(message);
        this.name = 'ExportFailed';
    }
}

/**
 * Read a failed {@link toSpecSkillName} result.
 *
 * `NameNarrowing` is a discriminated union, and `packages/agent` compiles with
 * `strictNullChecks: false`, under which TypeScript does NOT narrow a
 * boolean-literal discriminant — `if (!narrowed.ok)` leaves the value
 * unnarrowed and `narrowed.finding` fails to compile. The conformance library
 * is strict and uses unions freely; every crossing into this package needs
 * this, and this is the third place in the programme that has.
 */
function narrowingFailure(value: NameNarrowing): { reason: string; suggestion?: string } {
    const failed = value as Extract<NameNarrowing, { ok: false }>;
    return {
        reason: failed.finding.message,
        ...(failed.suggestion ? { suggestion: failed.suggestion } : {}),
    };
}

@Injectable()
export class AgentPluginExportService {
    private readonly logger = new Logger(AgentPluginExportService.name);

    /**
     * Build a package and prove it imports.
     *
     * Throws {@link ExportFailed} when the result does not load, carrying the
     * importer's findings — the caller needs to know WHICH rule its own data
     * broke, not merely that something did.
     */
    async buildPackage(input: ExportInput): Promise<ExportResult> {
        const files = new Map<string, string>();
        const rejected: { slug: string; reason: string; suggestion?: string }[] = [];

        files.set('plugin.json', serializeManifest(input.manifest));

        const usedNames = new Set<string>();

        for (const skill of input.skills) {
            const narrowed = toSpecSkillName(skill.slug);
            if (!narrowed.ok) {
                rejected.push({ slug: skill.slug, ...narrowingFailure(narrowed) });
                continue;
            }

            // Two platform slugs can narrow onto the same spec name. Emitting
            // both would produce one directory silently containing whichever
            // was written last — a skill that vanishes with no error anywhere.
            if (usedNames.has(narrowed.name)) {
                rejected.push({
                    slug: skill.slug,
                    reason:
                        `"${skill.slug}" narrows to "${narrowed.name}", which another ` +
                        `selected skill already uses.`,
                });
                continue;
            }
            usedNames.add(narrowed.name);

            files.set(
                `skills/${narrowed.name}/SKILL.md`,
                serializeSkillMd({
                    name: narrowed.name,
                    description: skill.description,
                    body: skill.body,
                    ...(skill.license ? { license: skill.license } : {}),
                    ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
                    ...(skill.metadata ? { metadata: skill.metadata } : {}),
                }),
            );
        }

        const findings = await this.proveItImports(files);

        return { files, rejected, findings };
    }

    /**
     * Write the package to a temporary directory and load it back.
     *
     * The directory is removed in a `finally`, so a failure that throws does
     * not leave the exported contents on disk — an export can carry a user's
     * private instructions, and a temp directory nobody cleans is where those
     * would linger.
     */
    private async proveItImports(files: PackageFiles): Promise<readonly Finding[]> {
        const dir = await mkdtemp(join(tmpdir(), 'ap-export-'));
        try {
            for (const [relative, content] of files) {
                const target = join(dir, relative);
                await mkdir(join(target, '..'), { recursive: true });
                await writeFile(target, content, 'utf8');
            }

            const load = await loadPluginPackage(dir);
            if (!load.ok) {
                throw new ExportFailed(
                    'The exported package does not validate against our own importer.',
                    load.findings,
                );
            }

            // A package that loads but contributed nothing is almost certainly
            // not what the user asked for, and it would be a confusing thing
            // to hand them a zip of.
            if (load.skills.length === 0) {
                throw new ExportFailed(
                    'The exported package contains no valid skills.',
                    load.findings,
                );
            }

            this.logger.log(
                `Exported package "${load.manifest.name}" with ${load.skills.length} skill(s)`,
            );
            return load.findings;
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /**
     * Zip the built package.
     *
     * Separate from {@link buildPackage} so the round-trip gate runs against
     * the FILES, not against an archive — an importer reads a directory, so
     * validating the archive would validate something no consumer sees.
     */
    async toZip(files: PackageFiles): Promise<Buffer> {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        for (const [relative, content] of files) {
            zip.file(relative, content);
        }
        return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    }
}
