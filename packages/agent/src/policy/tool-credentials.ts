import { isCredentialKey } from '@ever-works/contracts';
import { envVarNameForCredential } from './credential-resolver';

/**
 * Tool credential requirements (audit item G14) — the DECLARATION plus
 * the check that keeps it honest.
 *
 * ## Why a declaration at all
 *
 * `{{cred.key}}` lets a tool argument reference a secret. Without a
 * declaration of what a tool NEEDS, two failures are invisible until
 * production:
 *
 *   1. A tool ships expecting `{{cred.foo}}`, the operator never
 *      configures `foo`, and the first real call fails at the remote API
 *      with a 401 that says nothing about a missing platform credential.
 *   2. A credential key is renamed (or its tool deleted) and the stale
 *      requirement rots silently.
 *
 * `checkToolCredentialDeclarations` is the CI-time answer to both: it is
 * run by `__tests__/tool-credentials.spec.ts` against the REAL tool list
 * assembled by `AgentToolService`, so a requirement naming a tool that no
 * longer exists — or a key that no catalog entry defines — turns the
 * suite red in seconds instead of turning a customer's run red in weeks.
 *
 * `assertToolCredentialsAvailable` is the run-time half: it refuses a call
 * whose credentials could not be resolved, naming the KEYS (never the
 * values) so the failure is actionable.
 */

export interface ToolCredentialDefinition {
    /** What this credential is, in one line. Shown to operators. */
    description: string;
    /**
     * Where the default (env-backed) resolver reads it from. Derived, not
     * hand-typed — the check asserts it matches
     * `envVarNameForCredential(key)` so the two can never drift.
     */
    envVar: string;
}

/**
 * Every credential key the platform knows about.
 *
 * Deliberately EMPTY on landing: no built-in tool requires a credential
 * today, and inventing keys nobody resolves would be worse than useless.
 * The value here is the mechanism — a tool that starts needing a secret
 * adds its key here and its requirement below, and CI enforces both.
 */
export const TOOL_CREDENTIAL_CATALOG: Readonly<Record<string, ToolCredentialDefinition>> =
    Object.freeze({});

/**
 * Which tools require which credential keys.
 *
 * Keyed by the exact tool name the model sees. A tool listed here is
 * REFUSED at invoke time when any of its keys cannot be resolved — a
 * half-authenticated outbound call is worse than a clear refusal.
 */
export const TOOL_CREDENTIAL_REQUIREMENTS: Readonly<Record<string, readonly string[]>> =
    Object.freeze({});

/** Credential keys one tool requires. Empty for the overwhelming majority. */
export function requiredCredentialsForTool(toolName: string): readonly string[] {
    return TOOL_CREDENTIAL_REQUIREMENTS[toolName] ?? [];
}

export interface ToolCredentialProblem {
    kind:
        | 'unknown-credential-key'
        | 'malformed-credential-key'
        | 'env-var-mismatch'
        | 'unknown-tool'
        | 'empty-requirement';
    detail: string;
}

export interface CheckToolCredentialsInput {
    /**
     * Every tool name the platform can actually build. When supplied, a
     * requirement naming something else is reported as `unknown-tool`.
     * Omit in a pure unit test of the checker itself.
     */
    knownToolNames?: readonly string[];
    catalog?: Readonly<Record<string, ToolCredentialDefinition>>;
    requirements?: Readonly<Record<string, readonly string[]>>;
}

/**
 * THE CI check. Pure, so it can be exercised against deliberately-broken
 * fixtures — a checker nobody has ever seen fail is not a check.
 */
export function checkToolCredentialDeclarations(
    input: CheckToolCredentialsInput = {},
): ToolCredentialProblem[] {
    const catalog = input.catalog ?? TOOL_CREDENTIAL_CATALOG;
    const requirements = input.requirements ?? TOOL_CREDENTIAL_REQUIREMENTS;
    const problems: ToolCredentialProblem[] = [];

    for (const [key, definition] of Object.entries(catalog)) {
        if (!isCredentialKey(key)) {
            problems.push({
                kind: 'malformed-credential-key',
                detail: `Catalog key '${key}' is not a valid credential key.`,
            });
            continue;
        }
        const expected = envVarNameForCredential(key);
        if (definition.envVar !== expected) {
            problems.push({
                kind: 'env-var-mismatch',
                detail: `Catalog key '${key}' declares envVar '${definition.envVar}' but the resolver reads '${expected}'.`,
            });
        }
    }

    const known = input.knownToolNames ? new Set(input.knownToolNames) : null;
    for (const [toolName, keys] of Object.entries(requirements)) {
        if (known && !known.has(toolName)) {
            problems.push({
                kind: 'unknown-tool',
                detail: `Credential requirement declared for tool '${toolName}', which the platform does not build.`,
            });
        }
        if (keys.length === 0) {
            problems.push({
                kind: 'empty-requirement',
                detail: `Tool '${toolName}' declares an empty credential requirement — omit the entry instead.`,
            });
        }
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(catalog, key)) {
                problems.push({
                    kind: 'unknown-credential-key',
                    detail: `Tool '${toolName}' requires credential '${key}', which no catalog entry defines.`,
                });
            }
        }
    }

    return problems;
}

export interface ToolCredentialAvailability {
    ok: boolean;
    missing: string[];
    /** Ready-to-return refusal. Names keys only — never values. */
    error?: string;
}

/**
 * Run-time half: are the credentials this call needs actually present?
 *
 * `referenced` are the keys the arguments mention; `required` are the ones
 * the tool declares it cannot work without. Both are checked, because a
 * model that writes `{{cred.typo}}` deserves the same clear failure as an
 * operator who forgot to configure a declared key.
 */
export function checkToolCredentialsAvailable(args: {
    toolName: string;
    referenced?: readonly string[];
    resolved: ReadonlyMap<string, string>;
}): ToolCredentialAvailability {
    const needed = new Set<string>([
        ...requiredCredentialsForTool(args.toolName),
        ...(args.referenced ?? []),
    ]);
    const missing = Array.from(needed).filter((key) => !args.resolved.has(key));
    if (missing.length === 0) return { ok: true, missing: [] };
    return {
        ok: false,
        missing,
        error:
            `Tool '${args.toolName}' needs credential(s) ${missing
                .map((key) => `{{cred.${key}}}`)
                .join(', ')}, which are not configured. ` +
            `Ask an operator to set ${missing.map(envVarNameForCredential).join(', ')} ` +
            '(or the equivalent entry in the configured secret store). ' +
            'Do not ask the user to paste the secret into the conversation.',
    };
}
