import {
    REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING_LABEL,
    assessCredentialTransport,
    type CredentialTransportVerdict,
} from '@ever-works/contracts';
import { collectCredentialRefs, interpolateCredentials } from '../policy/credential-interpolation';

/**
 * `{{cred.key}}` references inside an MCP connection's auth headers — the
 * PURE half (no NestJS import, so every branch is a plain unit test).
 *
 * ## Why this exists
 *
 * `{{cred.key}}` interpolation already runs over TOOL ARGUMENTS (see
 * `policy/credential-interpolation.ts`), so an Agent can name a secret it
 * never sees. A connection's own request headers were the one outbound
 * credential path it did not reach: `McpClientService.connect` handed
 * `authHeaders` straight to the SDK factory, so a stored
 * `Authorization: Bearer {{cred.docs_token}}` would have reached the server
 * as that literal text — which looks exactly like a server-side auth
 * failure and hides the real cause.
 *
 * The rules this file makes checkable:
 *
 *   1. A header with no reference is returned byte-identical, so every row
 *      that stores a literal header keeps working as it does today.
 *   2. Resolution never mutates the stored object. The resolved headers are
 *      a NEW object that lives only for the one connection attempt.
 *   3. A reference the resolver cannot supply is reported by KEY and the
 *      caller refuses to connect. The literal `{{cred.key}}` text is never
 *      sent as a header value, and nothing is sent half-authenticated.
 *   4. A `{{cred.key}}` reference is never resolved for a plain-HTTP
 *      endpoint: the connection is refused before the key is looked up.
 *   5. LITERAL header values keep working over plain HTTP, exactly as they
 *      did before references existed — the attempt is stamped with the
 *      `insecure_transport` warning so the owner sees it is unencrypted. An
 *      organization that turns on "Require https for connection
 *      credentials" refuses them too. See `assessCredentialTransport` in
 *      `@ever-works/contracts`.
 */

/** Stable code the health classifier and the Settings screen key on. */
export const MCP_CREDENTIAL_MISSING_CODE = 'credential_missing' as const;
/** The WARNING code: literal credentials were sent over plain http and the attempt worked. */
export const MCP_INSECURE_CREDENTIAL_TRANSPORT_CODE = 'insecure_transport' as const;
/** The REFUSAL code: nothing was sent because the endpoint is not https. */
export const MCP_HTTPS_REQUIRED_CODE = 'https_required' as const;

/**
 * Message stored on the row and returned to callers when a credential is
 * refused on a non-TLS endpoint. Every transport refusal starts with it.
 */
export const MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE = 'Credentials require an https:// endpoint';

/**
 * The refusal when the organization setting is on. Names the setting so the
 * owner knows exactly what to change, and never names a header value.
 */
export const MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE = `${MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE} (organization setting "${REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING_LABEL}" is on)`;

/**
 * The refusal when that organization setting could not be read. Credentials
 * are not sent over plain http on a guess that the setting is off.
 */
export const MCP_ORGANIZATION_POLICY_UNAVAILABLE_MESSAGE = `${MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE} (organization setting "${REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING_LABEL}" could not be checked)`;

/** Why a credential transport was refused. */
export type McpCredentialTransportRefusal =
    | 'credential_references'
    | 'organization_policy'
    | 'policy_unavailable';

const TRANSPORT_REFUSAL_MESSAGES: Record<McpCredentialTransportRefusal, string> = {
    credential_references: MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE,
    organization_policy: MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE,
    policy_unavailable: MCP_ORGANIZATION_POLICY_UNAVAILABLE_MESSAGE,
};

/** Prefix of the stored message for an unresolvable reference. Keys only, never values. */
export const MCP_MISSING_CREDENTIAL_MESSAGE_PREFIX = 'Missing credential';

/**
 * Thrown BEFORE the SDK factory is called when a header references a key the
 * credential resolver could not supply. Carries key names only.
 */
export class McpHeaderCredentialMissingError extends Error {
    readonly code = MCP_CREDENTIAL_MISSING_CODE;

    constructor(readonly keys: readonly string[]) {
        super(formatMissingCredentialMessage(keys));
        this.name = 'McpHeaderCredentialMissingError';
    }
}

/**
 * Thrown BEFORE the SDK factory is called, and before any credential is looked
 * up, when a connection must not send its headers to a non-`https:` endpoint:
 * a `{{cred.key}}` reference (a row edited out of band), or any credential
 * while the organization requires https (`reason: 'organization_policy'`) or
 * while that setting cannot be read (`reason: 'policy_unavailable'`). The
 * message is fixed and value-free.
 */
export class McpInsecureCredentialTransportError extends Error {
    readonly code = MCP_HTTPS_REQUIRED_CODE;

    constructor(readonly reason: McpCredentialTransportRefusal = 'credential_references') {
        super(TRANSPORT_REFUSAL_MESSAGES[reason]);
        this.name = 'McpInsecureCredentialTransportError';
    }
}

/** ``Missing credential `a`, `b` `` — the only shape a missing-key message takes. */
export function formatMissingCredentialMessage(keys: readonly string[]): string {
    const named = keys.map((key) => `\`${key}\``).join(', ');
    return `${MCP_MISSING_CREDENTIAL_MESSAGE_PREFIX} ${named}`;
}

/** Every distinct `{{cred.key}}` key referenced by the header VALUES, first-seen order. */
export function collectHeaderCredentialRefs(
    headers: Readonly<Record<string, string>> | null | undefined,
): string[] {
    if (!headers) return [];
    return collectCredentialRefs(Object.values(headers));
}

/**
 * Does this header map carry a credential at all?
 *
 * Any non-empty value counts, whether it is a literal token or a
 * `{{cred.key}}` reference — the create path already refuses empty values, so
 * in practice "has any header" is "has a credential". Header NAMES alone are
 * not inspected: a custom `X-Api-Key` is as much a credential as
 * `Authorization`.
 */
export function headersCarryCredentials(
    headers: Readonly<Record<string, string>> | null | undefined,
): boolean {
    if (!headers) return false;
    return Object.values(headers).some((value) => typeof value === 'string' && value.length > 0);
}

/** `https:` only. A string that does not parse as a URL is not secure. */
export function isHttpsUrl(url: string | null | undefined): boolean {
    if (typeof url !== 'string' || url.length === 0) return false;
    try {
        return new URL(url).protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Does this connection send its headers ONLY over TLS? The strict predicate:
 * any credential on a plain-http endpoint is `false`, literal or reference.
 *
 * It is what an organization with "Require https for connection credentials"
 * enforces. Without that setting, literal credentials over plain http stay
 * allowed (with a warning) — use `mcpCredentialTransport` for the verdict a
 * create, update or connection attempt acts on.
 *
 * `stdio` rows are exempt: they never dial a network address (their `url` is
 * an opaque `stdio:<package>/<server>` pointer) and never carry headers.
 */
export function credentialTransportAllowed(input: {
    url: string | null | undefined;
    transport?: string | null;
    headers: Readonly<Record<string, string>> | null | undefined;
}): boolean {
    if (input.transport === 'stdio') return true;
    if (!headersCarryCredentials(input.headers)) return true;
    return isHttpsUrl(input.url);
}

/**
 * The verdict a create, update or connection attempt acts on:
 * `secure` / `insecure` (literal credentials over plain http — allowed, with
 * the `insecure_transport` warning) / `refused` (nothing is sent).
 */
export function mcpCredentialTransport(input: {
    url: string | null | undefined;
    transport?: string | null;
    headers: Readonly<Record<string, string>> | null | undefined;
    requireHttpsForCredentials?: boolean;
}): CredentialTransportVerdict {
    return assessCredentialTransport(input);
}

export interface ResolvedHeaderCredentials {
    /** A NEW header object with every resolved reference substituted. */
    headers: Record<string, string>;
    /** Keys that were substituted. Keys only — never values. */
    used: string[];
    /** Keys the resolver could not supply. Non-empty ⇒ the caller must not connect. */
    missing: string[];
    /** Key → resolved value for exactly the keys used, so errors can be redacted. */
    secrets: Map<string, string>;
}

/**
 * Substitute `{{cred.key}}` references inside header values using an already
 * resolved key → value map.
 *
 * When any key is missing the returned `headers` still hold the literal
 * references (never a partial substitution the caller might be tempted to
 * send) and `missing` names them — callers MUST refuse to connect.
 */
export function resolveHeaderCredentials(
    headers: Readonly<Record<string, string>> | null | undefined,
    resolved: ReadonlyMap<string, string>,
): ResolvedHeaderCredentials {
    const source: Record<string, string> = { ...(headers ?? {}) };
    const keys = collectHeaderCredentialRefs(source);
    if (keys.length === 0) {
        return { headers: source, used: [], missing: [], secrets: new Map() };
    }

    const result = interpolateCredentials(source, resolved);
    if (result.missing.length > 0) {
        return {
            headers: { ...(headers ?? {}) },
            used: [],
            missing: result.missing,
            secrets: new Map(),
        };
    }

    const secrets = new Map<string, string>();
    for (const key of result.used) {
        const value = resolved.get(key);
        if (typeof value === 'string') secrets.set(key, value);
    }
    return { headers: result.value, used: result.used, missing: [], secrets };
}
