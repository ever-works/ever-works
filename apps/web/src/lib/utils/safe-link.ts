/**
 * Link guards for URLs that come from data, not from code.
 *
 * A pull request, CI job, log, invoice, repository or website URL that an agent
 * run, a worker or a provider response wrote is rendered into `<a href>`. A
 * `javascript:` / `vbscript:` / `data:` value there runs in the app's origin on
 * click (`rel="noopener noreferrer"` does not stop it), so it must be checked
 * before it is rendered (C-12). Both guards:
 *
 *  - parse the value as an ABSOLUTE URL (a relative one would resolve against
 *    the app's own origin) and accept only the schemes named below;
 *  - refuse embedded credentials, the `https://github.com@evil.test/` shape;
 *  - never throw: junk answers `null`, and the caller renders inert text.
 *
 * An accepted value is returned trimmed but otherwise as written, so a valid
 * link renders byte-for-byte as before. That is safe because the browser
 * resolves the `href` with the same URL parser, which gives the same scheme.
 */

function guard(raw: string | null | undefined, schemes: readonly string[]): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;
    try {
        const url = new URL(value);
        if (!schemes.includes(url.protocol)) return null;
        if (url.username || url.password) return null;
        return value;
    } catch {
        return null;
    }
}

/**
 * `https:` only. For links a git or billing provider hosts: pull requests,
 * CI jobs and run logs, invoices. Matches `safePrUrl` on the Task board.
 */
export function safeHttpsUrl(raw: string | null | undefined): string | null {
    return guard(raw, ['https:']);
}

/**
 * `http:` or `https:`. For a site or repository a deployment target or a
 * self-hosted provider may serve over plain http, and for links an operator
 * typed or a connector delivered (a meeting's or an ingested event's source).
 */
export function safeWebUrl(raw: string | null | undefined): string | null {
    return guard(raw, ['https:', 'http:']);
}
