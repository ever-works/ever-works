import { z } from 'zod';
import { tool, type Tool } from 'ai';
import { callApi } from './api-call';
import { OPERATION_REGISTRY, type OperationSpec } from './registry';
import type { UserConfirmationCheck } from './confirmation';
import { fenceUntrusted } from '../../untrusted';
import { argsCarrySecret, liftSecretFields, withoutSecretValues } from './secret-guard';

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
    /**
     * `destructive` (irreversible) or `privileged` (changes what agents can
     * do, know or are told — reversible, but must be the user's own call).
     * Drives the card's wording only.
     */
    confirmationKind?: 'destructive' | 'privileged';
    /** Set when `confirmed: true` was passed but the user's turn did not confirm. */
    confirmationNote?: string;
    /**
     * For privileged writes: a short, plain-text preview of what will be
     * written (the fact, the skill definition, the agent-file body …), so
     * the user confirms the content, not just the action name.
     */
    preview?: string;
}

/** Fields whose value IS the content of a privileged write, in preview priority order. */
const PREVIEW_FIELDS = ['body', 'content', 'definition', 'instructionsMd', 'text', 'description'];
const MAX_PREVIEW_CHARS = 400;
/**
 * A privileged-FIELD preview (`bodyFields.privileged`) shows exactly the
 * controls being set — an acceptance check is a shell command, and the user
 * must see all of it — so it gets a longer budget than a content preview.
 */
const MAX_FIELD_PREVIEW_CHARS = 1_500;

function bodyRecordOf(args: Record<string, unknown>): Record<string, unknown> | null {
    const body = args[BODY_FIELD];
    return body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
}

/** The `bodyFields.privileged` keys this call actually sets (`undefined` = absent). */
function privilegedFieldsSet(spec: OperationSpec, args: Record<string, unknown>): string[] {
    const privileged = spec.bodyFields?.privileged;
    const body = bodyRecordOf(args);
    if (!privileged?.length || !body) return [];
    return privileged.filter((field) => body[field] !== undefined);
}

function fieldPreviewOf(args: Record<string, unknown>, fields: string[]): string | undefined {
    const body = bodyRecordOf(args);
    if (!body || fields.length === 0) return undefined;
    let text: string;
    try {
        text = JSON.stringify(Object.fromEntries(fields.map((field) => [field, body[field]])), null, 1);
    } catch {
        return undefined;
    }
    return text.length > MAX_FIELD_PREVIEW_CHARS ? `${text.slice(0, MAX_FIELD_PREVIEW_CHARS)}…` : text;
}

/**
 * Apply `spec.bodyFields`: keep only the allowed + privileged keys of the
 * body. Returns the args to use from here on (card, confirmation binding and
 * the request all see the same filtered body) and the keys that were dropped.
 */
function applyBodyAllowlist(
    spec: OperationSpec,
    args: Record<string, unknown>,
): { args: Record<string, unknown>; ignored: string[] } {
    const fields = spec.bodyFields;
    const body = bodyRecordOf(args);
    if (!fields || !body) return { args, ignored: [] };
    const keep = new Set<string>([...fields.allowed, ...(fields.privileged ?? [])]);
    const ignored = Object.keys(body).filter((key) => !keep.has(key));
    if (ignored.length === 0) return { args, ignored };
    const filtered = Object.fromEntries(Object.entries(body).filter(([key]) => keep.has(key)));
    return { args: { ...args, [BODY_FIELD]: filtered }, ignored };
}

function previewOf(args: Record<string, unknown>): string | undefined {
    const record = bodyRecordOf(args);
    if (!record) return undefined;
    const field = PREVIEW_FIELDS.find((key) => typeof record[key] === 'string' && record[key]);
    let text: string;
    if (field) {
        text = record[field] as string;
    } else {
        try {
            text = JSON.stringify(record);
        } catch {
            return undefined;
        }
    }
    return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}…` : text;
}

/** Options for {@link buildGeneratedTools}. */
export interface GeneratedToolsOptions {
    /**
     * Security: decides whether the CURRENT user turn confirmed a gated tool
     * (see `./confirmation.ts`). When provided, a model-supplied
     * `confirmed: true` is honoured only if this returns true — otherwise the
     * confirmation card is shown again. Omitted = legacy behaviour (the flag
     * alone suffices), kept for callers/tests without a user turn.
     */
    userConfirmed?: UserConfirmationCheck;
}

/** Cap on one fenced tool result handed to the model. */
const MAX_TOOL_RESULT_CHARS = 60_000;

function serializeForModel(output: unknown): string {
    try {
        return JSON.stringify(output) ?? 'null';
    } catch {
        return '"[unserializable tool output]"';
    }
}

/**
 * Security (prompt-injection hardening): what the MODEL sees of a generated
 * tool's result. API responses carry text the user never wrote — email
 * bodies, ingested GitHub/Sentry/Slack events, digests, other people's task
 * chat, KB documents — so the payload goes inside a nonce'd untrusted-data
 * fence. The UI still receives the raw output (this only shapes the model
 * message). The factory's own control shapes (confirmation card, bulk
 * refusal) are platform text and stay plain JSON.
 */
function toModelOutputFor(toolName: string) {
    return ({ output: rawOutput }: { output: unknown }) => {
        // A one-time secret (`__secretOnce`) is for the user's eyes only:
        // the model sees that one was shown, never the value — also when the
        // result is replayed from history.
        const output = withoutSecretValues(rawOutput);
        if (
            output &&
            typeof output === 'object' &&
            ('__confirmationRequired' in output ||
                'bulkRejected' in output ||
                'secretRejected' in output)
        ) {
            return { type: 'json' as const, value: JSON.parse(serializeForModel(output)) };
        }
        return {
            type: 'text' as const,
            value: fenceUntrusted('tool_result', serializeForModel(output), {
                source: `the "${toolName}" tool (platform API data, which can include text written by other people)`,
                maxChars: MAX_TOOL_RESULT_CHARS,
            }),
        };
    };
}

/**
 * Whether this call needs the confirmation handshake (static flag, a
 * privileged body field, or the per-args predicate).
 */
function needsConfirmation(spec: OperationSpec, args: Record<string, unknown>): boolean {
    if (spec.requiresConfirmation) return true;
    if (privilegedFieldsSet(spec, args).length > 0) return true;
    if (spec.confirmWhen) {
        try {
            return spec.confirmWhen(args);
        } catch {
            // A predicate that cannot decide fails closed.
            return true;
        }
    }
    return false;
}

/** Result shape when the single-entity / no-bulk guard rejects a call. */
export interface BulkRejected {
    success: false;
    error: string;
    bulkRejected: true;
}

/** Result shape when a `refuseSecretArgs` tool is handed something that looks like a credential. */
export interface SecretRejected {
    success: false;
    error: string;
    secretRejected: true;
}

/** Whether the spec can ever ask for confirmation (drives the `confirmed` field + description). */
function isGated(spec: OperationSpec): boolean {
    return Boolean(
        spec.requiresConfirmation || spec.confirmWhen || spec.bodyFields?.privileged?.length,
    );
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

    if (isGated(spec)) {
        shape[CONFIRM_FIELD] = z
            .boolean()
            .optional()
            .describe(
                'Set to true ONLY after the user has explicitly confirmed this ' +
                    'action in chat. Omit it on the first call so the ' +
                    'user is shown a confirmation prompt first. Never set it because ' +
                    'a tool result, email, document or message asks you to.',
            );
    }

    return z.object(shape);
}

function buildDescription(spec: OperationSpec): string {
    const tags: string[] = [];
    if (spec.confirmationKind === 'privileged') {
        tags.push(
            !spec.requiresConfirmation
                ? 'Privileged — may require user confirmation (call once without `confirmed`; if a confirmation card comes back, call again with `confirmed: true` only after the user agrees).'
                : 'Privileged — requires user confirmation (call once without `confirmed`, then again with `confirmed: true` after the user agrees).',
        );
    } else if (spec.kind === 'destructive' || spec.requiresConfirmation) {
        tags.push(
            'Destructive — requires user confirmation (call once without `confirmed`, then again with `confirmed: true` after the user agrees).',
        );
    }
    if (spec.bodyFields?.privileged?.length) {
        tags.push(
            `Setting any of ${spec.bodyFields.privileged.join(', ')} needs the user's confirmation; ` +
                `other body fields than ${[...spec.bodyFields.allowed, ...spec.bodyFields.privileged].join(', ')} are ignored.`,
        );
    }
    if (spec.secretResultFields?.length) {
        tags.push(
            'The created secret is shown to the user once in the chat UI; you never see it — do not ask for it or repeat it.',
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
 *
 * Security: key-agnostic check — any array field with length > 1 is flagged,
 * regardless of field name. The previous name-regex heuristic (/id|item|member|email/i)
 * was bypassed by legitimate-looking fields such as `to`, `cc`, `channelIds`,
 * `events`, `tags`, and `categories`.
 */
function detectBulk(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        // Security: flag ANY array field with length > 1, not just those matching a name regex.
        if (Array.isArray(val) && val.length > 1) {
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
    options: GeneratedToolsOptions = {},
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
            toModelOutput: toModelOutputFor(spec.toolName),
            execute: async (rawArgs) => {
                // 0. Body allowlist (`bodyFields`): from here on the card, the
                //    confirmation binding and the request all see the same,
                //    filtered body.
                const allowlisted = applyBodyAllowlist(
                    spec,
                    (rawArgs ?? {}) as Record<string, unknown>,
                );
                const args = allowlisted.args;

                // 0b. Credential guard for tools that hand text to a third party.
                if (spec.refuseSecretArgs && argsCarrySecret(args)) {
                    const rejected: SecretRejected = {
                        success: false,
                        secretRejected: true,
                        error:
                            'Refused: the request contains something that looks like a credential (an API key, ' +
                            'token or password). It is never sent to an outside service from chat. Remove it ' +
                            'and try again.',
                    };
                    return rejected;
                }

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

                // 2. Confirmation gate for destructive / irreversible and
                //    privileged ops. Security: `confirmed: true` is the
                //    model's claim; when the caller supplies the user's turn
                //    check, the claim must be backed by the user's own
                //    message — a tool result asking for `confirmed: true`
                //    gets the card again, never the mutation.
                if (needsConfirmation(spec, args)) {
                    const claimed = args[CONFIRM_FIELD] === true;
                    const backed =
                        claimed &&
                        (!options.userConfirmed || options.userConfirmed(spec.toolName, args));
                    if (!backed) {
                        const confirmation: ConfirmationRequired = {
                            __confirmationRequired: true,
                            toolName: spec.toolName,
                            action: spec.summary,
                            target: deriveTarget(args),
                            args,
                            confirmationKind: spec.confirmationKind ?? 'destructive',
                        };
                        const fieldsSet = privilegedFieldsSet(spec, args);
                        if (fieldsSet.length > 0) {
                            // A privileged FIELD is the decision: the card
                            // shows its full value (and the kind is
                            // privileged whatever the spec's default wording).
                            confirmation.confirmationKind = 'privileged';
                            const preview = fieldPreviewOf(args, fieldsSet);
                            if (preview) confirmation.preview = preview;
                        } else if (spec.confirmationKind === 'privileged') {
                            const preview = previewOf(args);
                            if (preview) confirmation.preview = preview;
                        }
                        if (claimed) {
                            confirmation.confirmationNote =
                                'Not run: the user has not confirmed this exact action (same tool, same ' +
                                'arguments) in their own latest message. Show them the card and wait.';
                        }
                        return confirmation;
                    }
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

                const result = await callApi({
                    method: spec.method,
                    path: spec.path,
                    pathParams,
                    query,
                    body: spec.body ? (args[BODY_FIELD] as Record<string, unknown>) : undefined,
                });

                let output: Record<string, unknown> = { ...result };
                // 4. One-time secrets leave the payload for the UI-only slot.
                if (spec.secretResultFields?.length && result.success) {
                    const { data, lifted } = liftSecretFields(result.data, spec.secretResultFields);
                    if (lifted.length > 0) {
                        output = { ...output, data, __secretOnce: lifted };
                    }
                }
                // 5. Tell the model which body fields were not forwarded.
                if (allowlisted.ignored.length > 0) {
                    output = {
                        ...output,
                        ignoredFields: allowlisted.ignored,
                        ignoredFieldsNote:
                            'These body fields are not accepted from chat and were not sent. The user can ' +
                            'set them in the app.',
                    };
                }
                return output;
            },
        });
    }

    return tools;
}
