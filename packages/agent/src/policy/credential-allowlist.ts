import { envVarNameForCredential } from './credential-resolver';

/**
 * `{{cred.key}}` — WHERE a credential may be substituted (prompt-injection
 * hardening, reviews of #2769).
 *
 * Substituting a secret into an arbitrary tool argument hands it to wherever
 * that argument goes: a URL an injected instruction chose, an email body, a
 * Task comment. So a reference is substituted only where somebody who is not
 * the model declared it may go:
 *
 *  1. a tool argument the PLATFORM declared as a credential slot
 *     (`'x-credential': true` on a built-in descriptor's schema); or
 *  2. a tool the OPERATOR allowed for that one credential, in the environment:
 *
 *         EVERWORKS_CRED_<KEY>_ALLOW=tool[,tool@host,tool@host:port,...]
 *
 *     - `tool` — the exact tool name the model calls (case-insensitive), e.g.
 *       `mcp__billing__create_invoice`; the reference may appear in any of
 *       that tool's arguments;
 *     - `tool@host` — the same, but only when the call's `url` argument is an
 *       `https:` URL on exactly `host` (case-insensitive, no wildcard) and the
 *       default port; `tool@host:port` names a non-default port. A tool without
 *       a `url` argument never matches a host-bound entry, and neither does a
 *       URL that parsers could disagree on: one carrying a backslash,
 *       whitespace or a control character, or userinfo (`user@` before the host).
 *
 * Anything else is refused before the credential is resolved. MCP CONNECTION
 * headers (`Authorization: Bearer {{cred.x}}` stored on the connection) have
 * their own path (`mcp/mcp-header-credentials.ts`) and need no allow entry.
 *
 * Pure: reads only the environment it is given.
 */

export interface CredentialAllowEntry {
    /** Tool name, lower-cased. */
    readonly tool: string;
    /** Host the call's `url` argument must name, lower-cased; `null` = any. */
    readonly host: string | null;
    /** Port the call's `url` must use; `null` = the `https:` default (443). */
    readonly port: number | null;
}

/** The environment variable holding one credential's allow list. */
export function credentialAllowEnvVar(key: string): string {
    return `${envVarNameForCredential(key)}_ALLOW`;
}

/** The parsed allow list of one credential. Malformed entries are ignored. */
export function credentialAllowEntries(
    key: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialAllowEntry[] {
    const raw = env[credentialAllowEnvVar(key)] ?? '';
    const out: CredentialAllowEntry[] = [];
    for (const part of raw.split(',')) {
        const entry = part.trim();
        if (!entry) continue;
        const at = entry.lastIndexOf('@');
        const tool = (at > 0 ? entry.slice(0, at) : entry).trim().toLowerCase();
        if (!/^[a-z0-9_.:-]+$/.test(tool)) continue;
        if (at <= 0) {
            out.push({ tool, host: null, port: null });
            continue;
        }
        const target = /^([a-z0-9.-]+?)\.?(?::(\d{1,5}))?$/.exec(
            entry
                .slice(at + 1)
                .trim()
                .toLowerCase(),
        );
        if (!target || !target[1]) continue;
        const port = target[2] === undefined ? null : Number(target[2]);
        if (port !== null && (port < 1 || port > 65535)) continue;
        out.push({ tool, host: target[1], port: port === 443 ? null : port });
    }
    return out;
}

/** Backslash, whitespace or a control character — spellings URL parsers disagree on. */
const AMBIGUOUS_URL_CHARS = /[\\\s\u0000-\u001f\u007f]/;

/**
 * The `https:` target of a tool call's top-level `url` argument, or `null` when
 * there is none or it is not one a host-bound entry may match: not `https:`,
 * unparseable, carrying a backslash / whitespace / control character, or
 * carrying userinfo. `port` is `null` for the default port.
 */
export function urlArgumentTarget(args: unknown): { host: string; port: number | null } | null {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    const raw = (args as Record<string, unknown>).url;
    if (typeof raw !== 'string' || !raw || AMBIGUOUS_URL_CHARS.test(raw)) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;
    // Userinfo — parsed, or the empty `https://@host` form the parser drops silently.
    const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? '';
    if (url.username || url.password || authority.includes('@')) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    return { host, port: url.port === '' ? null : Number(url.port) };
}

/** Lower-cased host of a tool call's `url` argument (see {@link urlArgumentTarget}), or `null`. */
export function urlArgumentHost(args: unknown): string | null {
    return urlArgumentTarget(args)?.host ?? null;
}

/** Whether the operator allowed credential `key` in this call of `toolName`. */
export function credentialUseAllowed(
    input: { key: string; toolName: string; args: unknown },
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    const tool = input.toolName.toLowerCase();
    const entries = credentialAllowEntries(input.key, env).filter((entry) => entry.tool === tool);
    if (entries.length === 0) return false;
    if (entries.some((entry) => entry.host === null)) return true;
    const target = urlArgumentTarget(input.args);
    return (
        target !== null &&
        entries.some((entry) => entry.host === target.host && entry.port === target.port)
    );
}
