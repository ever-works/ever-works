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
 *   4. Credentials never travel over plain HTTP. A connection whose headers
 *      carry any value is refused unless its endpoint is `https:`.
 */

/** Stable code the health classifier and the Settings screen key on. */
export const MCP_CREDENTIAL_MISSING_CODE = 'credential_missing' as const;
export const MCP_INSECURE_CREDENTIAL_TRANSPORT_CODE = 'insecure_transport' as const;

/** Message stored on the row and returned to callers when the endpoint is not TLS. */
export const MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE = 'Credentials require an https:// endpoint';

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
 * Thrown BEFORE the SDK factory is called when a connection that carries
 * credentials points at a non-`https:` endpoint (a row written before the
 * create/update rule, or edited out of band).
 */
export class McpInsecureCredentialTransportError extends Error {
    readonly code = MCP_INSECURE_CREDENTIAL_TRANSPORT_CODE;

    constructor() {
        super(MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE);
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
 * May this connection send its headers over this endpoint?
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
