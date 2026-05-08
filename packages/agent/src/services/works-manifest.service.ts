import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import * as yaml from 'yaml';
import type { ManifestValidationError, WorksManifestV1 } from '@ever-works/contracts/api';

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SUBDOMAIN_RE = SLUG_RE;
const PRINTABLE_ASCII_RE = /^[\x21-\x7E]+$/;

const WorkPipeline = z.string().min(1).max(64);
const PluginId = z.string().min(1).max(64);

const SourceAwesomeReadme = z.object({
    type: z.literal('awesome-readme'),
    url: z.string().url(),
    expansionFactor: z.number().int().min(1).max(10).optional(),
});

const SourceWebSearch = z.object({
    type: z.literal('web-search'),
    query: z.string().min(1).max(256),
    max: z.number().int().min(1).max(500).optional(),
});

const SourceDataRepo = z.object({
    type: z.literal('data-repo'),
    url: z.string().url(),
    mode: z.enum(['copy', 'link']).optional(),
});

const SourceInline = z.object({
    type: z.literal('inline'),
    items: z
        .array(
            z.object({
                name: z.string().min(1).max(200),
                url: z.string().url().optional(),
                categories: z.array(z.string().min(1).max(64)).max(64).optional(),
                tags: z.array(z.string().min(1).max(64)).max(128).optional(),
                description: z.string().max(2000).optional(),
            }),
        )
        .min(1)
        .max(1000),
});

const Source = z.discriminatedUnion('type', [
    SourceAwesomeReadme,
    SourceWebSearch,
    SourceDataRepo,
    SourceInline,
]);

const Output = z
    .object({
        repos: z
            .object({
                website: z.enum(['managed', 'none']).default('managed').optional(),
                awesomeList: z.enum(['managed', 'none']).default('none').optional(),
            })
            .optional(),
        llmsTxt: z.boolean().default(true).optional(),
        itemsJson: z.boolean().default(true).optional(),
        markerFile: z
            .string()
            .min(1)
            .max(256)
            .refine((p) => p.startsWith('.works/'), {
                message: 'markerFile must be under .works/ (FR-26a)',
            })
            .optional(),
    })
    .optional();

export const WorksManifestV1Schema = z.object({
    apiVersion: z.literal('works.ever.works/v1'),
    kind: z.literal('Work'),
    metadata: z.object({
        name: z.string().min(1).max(120),
        slug: z.string().min(3).max(63).regex(SLUG_RE).optional(),
        description: z.string().max(1024).optional(),
        subdomain: z.string().min(3).max(63).regex(SUBDOMAIN_RE).optional(),
    }),
    spec: z.object({
        pipeline: WorkPipeline,
        domain: z.enum(['software', 'ecommerce', 'services', 'general']),
        taxonomy: z
            .object({
                categories: z.array(z.string().min(1).max(64)).max(64).optional(),
                tags: z.array(z.string().min(1).max(64)).max(128).optional(),
                lockTaxonomy: z.boolean().optional(),
            })
            .optional(),
        items: z.object({
            sources: z.array(Source).min(1),
        }),
        generators: z
            .object({
                aiProvider: PluginId.optional(),
                searchProvider: PluginId.optional(),
                screenshot: PluginId.optional(),
                model: z.string().min(1).max(128).optional(),
            })
            .optional(),
        deployment: z
            .object({
                target: PluginId.optional(),
                customDomain: z.string().min(3).max(253).optional(),
            })
            .optional(),
        output: Output,
    }),
});

export type ParsedManifest = z.infer<typeof WorksManifestV1Schema>;

export type ManifestParseResult =
    | { kind: 'success'; ok: true; manifest: WorksManifestV1 }
    | {
          kind: 'failure';
          ok: false;
          code: 'manifest_invalid_yaml' | 'manifest_invalid';
          errors: ManifestValidationError[];
      };

export const PRINTABLE_ASCII_PATTERN = PRINTABLE_ASCII_RE;
export const SUBDOMAIN_PATTERN = SUBDOMAIN_RE;

@Injectable()
export class WorksManifestService {
    parseAndValidate(rawYaml: string): ManifestParseResult {
        if (rawYaml.length > 64 * 1024) {
            return {
                kind: 'failure',
                ok: false,
                code: 'manifest_invalid',
                errors: [
                    {
                        path: '',
                        message: '.works/works.yml exceeds 64 KiB limit',
                        subcode: 'manifest.size_limit',
                    },
                ],
            };
        }

        let parsed: unknown;
        try {
            parsed = yaml.parse(rawYaml);
        } catch (err) {
            return {
                kind: 'failure',
                ok: false,
                code: 'manifest_invalid_yaml',
                errors: [
                    {
                        path: '',
                        message: err instanceof Error ? err.message : 'YAML parse error',
                        subcode: 'manifest.invalid_yaml',
                    },
                ],
            };
        }

        if (parsed === null || typeof parsed !== 'object') {
            return {
                kind: 'failure',
                ok: false,
                code: 'manifest_invalid',
                errors: [
                    {
                        path: '',
                        message: 'manifest must be a YAML mapping',
                        subcode: 'manifest.invalid_root',
                    },
                ],
            };
        }

        const result = WorksManifestV1Schema.safeParse(parsed);
        if (!result.success) {
            return {
                kind: 'failure',
                ok: false,
                code: 'manifest_invalid',
                errors: result.error.issues.map((issue) => ({
                    path: issue.path.map((p) => String(p)).join('.'),
                    message: issue.message,
                    subcode: deriveSubcode(issue.path, issue.message),
                })),
            };
        }

        return { kind: 'success', ok: true, manifest: result.data as WorksManifestV1 };
    }
}

function deriveSubcode(path: ReadonlyArray<unknown>, message: string): string | undefined {
    const head = path.map((p) => String(p)).join('.');
    if (head.startsWith('apiVersion')) return 'manifest.unsupported_apiversion';
    if (head.startsWith('kind')) return 'manifest.invalid_kind';
    if (head.startsWith('metadata.name')) return 'manifest.metadata.name_required';
    if (head.startsWith('metadata.slug') || head.startsWith('metadata.subdomain'))
        return 'manifest.metadata.slug_format';
    if (head.startsWith('spec.pipeline')) return 'manifest.spec.pipeline_unknown';
    if (head.startsWith('spec.domain')) return 'manifest.spec.domain_invalid';
    if (head.startsWith('spec.items.sources')) {
        if (message.includes('discriminator')) return 'manifest.items.source_type';
        return 'manifest.items.sources_empty';
    }
    if (head.startsWith('spec.deployment.target')) return 'manifest.deployment.target_unknown';
    if (head.startsWith('spec.output.markerFile')) return 'manifest.output.marker_outside_works';
    return undefined;
}
