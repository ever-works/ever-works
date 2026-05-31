import { z } from 'zod';
import { tool, type Tool } from 'ai';
import { callApi } from './api-call';
import { OPERATION_REGISTRY, type OperationSpec } from './registry';

/**
 * Marker returned (instead of performing the mutation) when a destructive /
 * irreversible operation is invoked without `confirmed: true`. The chat UI
 * (`ChatToolResult`) renders a confirmation card for this shape; the model is
 * instructed to only re-call with `confirmed: true` after the user agrees.
 */
export interface ConfirmationRequired {
    __confirmationRequired: true;
    toolName: string;
    action: string;
    target?: string;
    args: Record<string, unknown>;
}

/** Result shape when the single-entity / no-bulk guard rejects a call. */
export interface BulkRejected {
    success: false;
    error: string;
    bulkRejected: true;
}

const CONFIRM_FIELD = 'confirmed';
const BODY_FIELD = 'body';

function zForParamType(type?: string): z.ZodTypeAny {
    if (type === 'number') return z.number();
    if (type === 'boolean') return z.boolean();
    return z.string();
}

function buildInputSchema(spec: OperationSpec): z.ZodObject<z.ZodRawShape> {
    const shape: z.ZodRawShape = {};

    for (const param of spec.params ?? []) {
        let base = zForParamType(param.type);
        if (param.description) base = base.describe(param.description);
        shape[param.name] = param.required ? base : base.optional();
    }

    if (spec.body) {
        shape[BODY_FIELD] = z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
                spec.bodyHint
                    ? `Request body as a JSON object. Fields: ${spec.bodyHint}`
                    : 'Request body as a JSON object.',
            );
    }

    if (spec.requiresConfirmation) {
        shape[CONFIRM_FIELD] = z
            .boolean()
            .optional()
            .describe(
                'Set to true ONLY after the user has explicitly confirmed this ' +
                    'irreversible action in chat. Omit it on the first call so the ' +
                    'user is shown a confirmation prompt first.',
            );
    }

    return z.object(shape);
}

function buildDescription(spec: OperationSpec): string {
    const tags: string[] = [];
    if (spec.kind === 'destructive' || spec.requiresConfirmation) {
        tags.push(
            'Destructive — requires user confirmation (call once without `confirmed`, then again with `confirmed: true` after the user agrees).',
        );
    }
    if (spec.canvas) {
        tags.push(`Result renders well in the canvas as "${spec.canvas}".`);
    }
    return [spec.summary, ...tags].join(' ');
}

/**
 * Single-entity guard. The product rule is "one entity at a time, no bulk".
 * The registry already excludes bulk endpoints, but this is a second line of
 * defence against a model trying to smuggle an array of ids through a body
 * field (e.g. `{ ids: [...] }`).
 */
function detectBulk(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(val) && val.length > 1 && /id|item|member|email/i.test(key)) {
            return `Multiple values were supplied for "${key}".`;
        }
    }
    return null;
}

function deriveTarget(args: Record<string, unknown>): string | undefined {
    for (const key of ['id', 'workId', 'memberId', 'budgetId', 'docId', 'pluginId', 'slug']) {
        const v = args[key];
        if (typeof v === 'string' && v) return v;
    }
    return undefined;
}

/**
 * Build the full set of generated chat tools from the operation registry.
 *
 * Each tool:
 *  - validates input with a Zod schema derived from the operation's params,
 *  - enforces the no-bulk guard,
 *  - gates destructive ops behind a confirmation handshake,
 *  - and otherwise routes through `callApi`, which runs as the logged-in user.
 */
export function buildGeneratedTools(
    specs: OperationSpec[] = OPERATION_REGISTRY,
): Record<string, Tool> {
    const tools: Record<string, Tool> = {};

    for (const spec of specs) {
        const pathParamNames = new Set(
            (spec.params ?? []).filter((p) => p.in === 'path').map((p) => p.name),
        );
        const queryParamNames = new Set(
            (spec.params ?? []).filter((p) => p.in === 'query').map((p) => p.name),
        );

        tools[spec.toolName] = tool({
            description: buildDescription(spec),
            inputSchema: buildInputSchema(spec),
            execute: async (rawArgs) => {
                const args = (rawArgs ?? {}) as Record<string, unknown>;

                // 1. No-bulk guard (top-level args + nested body).
                const bulk = detectBulk(args) ?? detectBulk(args[BODY_FIELD]);
                if (bulk) {
                    const rejected: BulkRejected = {
                        success: false,
                        bulkRejected: true,
                        error:
                            `Bulk operations are not allowed in chat. ${bulk} ` +
                            'Please ask me to do this one entity at a time.',
                    };
                    return rejected;
                }

                // 2. Confirmation gate for destructive / irreversible ops.
                if (spec.requiresConfirmation && args[CONFIRM_FIELD] !== true) {
                    const confirmation: ConfirmationRequired = {
                        __confirmationRequired: true,
                        toolName: spec.toolName,
                        action: spec.summary,
                        target: deriveTarget(args),
                        args,
                    };
                    return confirmation;
                }

                // 3. Route the call as the logged-in user.
                const pathParams: Record<string, string | number> = {};
                const query: Record<string, string | number | boolean> = {};
                for (const [key, value] of Object.entries(args)) {
                    if (key === CONFIRM_FIELD || key === BODY_FIELD) continue;
                    if (value === undefined || value === null) continue;
                    if (pathParamNames.has(key)) {
                        pathParams[key] = value as string | number;
                    } else if (queryParamNames.has(key)) {
                        query[key] = value as string | number | boolean;
                    }
                }

                return callApi({
                    method: spec.method,
                    path: spec.path,
                    pathParams,
                    query,
                    body: spec.body ? (args[BODY_FIELD] as Record<string, unknown>) : undefined,
                });
            },
        });
    }

    return tools;
}
