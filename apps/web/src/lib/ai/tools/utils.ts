import { getGlobalFormSchema, getFormSchema } from '@/app/actions/dashboard/generator-form';
import { buildSelectedProviders } from '@ever-works/plugin';
import { workAPI } from '@/lib/api/work';
import type { ProvidersDto } from '@ever-works/contracts/api';

export interface ResolvedGenerationConfig {
    providers?: ProvidersDto;
    pluginConfig?: Record<string, unknown>;
    pipelineId?: string;
}

/**
 * Resolve generation config — providers + pluginConfig.
 *
 * - With workId: reuses last request config if available,
 *   then falls back to work-scoped schema via getFormSchema().
 * - Without workId: uses global schema via getGlobalFormSchema().
 *
 * Mirrors the same logic as:
 * - WorkAICreator (new work) → getGlobalFormSchema
 * - GeneratorForm (existing work) → getFormSchema(workId)
 */
export async function resolveGenerationConfig(workId?: string): Promise<ResolvedGenerationConfig> {
    // For existing works, try to reuse last request data first
    if (workId) {
        try {
            const configRes = await workAPI.getConfig(workId);
            const lastRequest = configRes?.config?.metadata?.last_request_data;

            if (lastRequest) {
                return {
                    providers: lastRequest.providers,
                    pluginConfig: lastRequest.pluginConfig,
                    pipelineId: lastRequest.providers?.pipeline ?? undefined,
                };
            }
        } catch {
            // Fall through to schema resolution
        }
    }

    // Resolve from form schema — work-scoped or global
    try {
        const result = workId ? await getFormSchema(workId) : await getGlobalFormSchema();

        if (!result.success || !result.data) return {};

        const providers = buildSelectedProviders({}, result.data);
        return {
            providers: providers as ProvidersDto | undefined,
            pluginConfig: result.data.defaultValues,
            pipelineId: result.data.resolvedPipelineId,
        };
    } catch {
        return {};
    }
}

/**
 * Extract upload IDs from `/api/uploads/<userId>/<sha256>.<ext>` URLs.
 *
 * The PromptComposer forwards completed uploads into the chat prompt
 * as a markdown-style bullet list ("Attached files:\n- name (mime) —
 * url"). Each chat AI create-entity tool accepts an `attachmentIds`
 * array, but the model often passes URLs verbatim instead — this
 * helper normalizes both shapes so callers can hand `attachmentIds`
 * straight to the tool without forcing a perfect upstream parse.
 *
 * Returns deduped uploadIds in input order. Strings that don't match
 * the URL shape are passed through unchanged (so a model that does the
 * right thing — passes bare `<sha256>` strings — gets them respected).
 * Bare sha256-shaped hex strings (64 lowercase hex chars) are also
 * accepted as-is.
 *
 * Backed by the wire contract documented at
 * `apps/api/src/uploads/uploads.service.ts` (saveImage / saveFile
 * write the canonical key `<userId>/<sha256>.<ext>`; the `id` field
 * on UploadResult IS the sha256).
 */
const UPLOAD_URL_RE = /\/api\/uploads\/[^/?#]+\/([0-9a-f]{64})\.[a-z0-9]+(?:\?[^#]*)?(?:#.*)?$/i;
const BARE_SHA256_RE = /^[0-9a-f]{64}$/i;

export function extractUploadIds(refs: ReadonlyArray<string> | undefined): string[] {
    if (!refs || refs.length === 0) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of refs) {
        if (typeof raw !== 'string') continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        let candidate: string | null = null;
        const urlMatch = trimmed.match(UPLOAD_URL_RE);
        if (urlMatch) {
            candidate = urlMatch[1].toLowerCase();
        } else if (BARE_SHA256_RE.test(trimmed)) {
            candidate = trimmed.toLowerCase();
        }
        if (candidate && !seen.has(candidate)) {
            seen.add(candidate);
            out.push(candidate);
        }
    }
    return out;
}

/**
 * Best-effort "attach this list of uploadIds to the just-created
 * entity" helper. Calls the supplied `attach` function per id,
 * swallowing per-id failures so a single 404 / 409 doesn't unwind the
 * whole chat-tool run — the entity is already created and the user
 * can re-attach manually if needed.
 *
 * Returns the count of successful + failed attaches so callers can
 * surface a partial-success message back to the model.
 */
export async function attachUploadsBestEffort(
    uploadIds: ReadonlyArray<string>,
    attach: (uploadId: string) => Promise<unknown>,
): Promise<{ attached: number; failed: number }> {
    let attached = 0;
    let failed = 0;
    for (const uploadId of uploadIds) {
        try {
            await attach(uploadId);
            attached++;
        } catch {
            failed++;
        }
    }
    return { attached, failed };
}
