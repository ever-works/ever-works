/**
 * Prompt-injection hardening — ONE trusted-sender rule for every inbound email,
 * the first one of a thread and every reply alike (reviews of #2769):
 *
 *  - from a TRUSTED sender, the receiving Agent picks the email up as it always
 *    did (a joined reply mentions it live);
 *  - from anyone else, the Task is still created / the reply still filed, but
 *    nothing wakes the Agent: the owner is told in their Inbox and decides.
 *
 * ## Who is trusted
 *
 *  1. **Agent-to-agent mail the platform itself sent** — recognised from the
 *     platform's own outbound record (the inbound message's `Message-ID` is the
 *     id of a message the owner's account SENT to this very address), never from
 *     the `From` spelling. Decided by the dispatcher, which holds that record.
 *  2. **The owner's own sending addresses** — their verified account email and
 *     verified outbound / two-way addresses they own (never the receiving
 *     address itself, never an inbound-only one) — ONLY with an authentication
 *     PASS ({@link senderAuthVerdict}).
 *  3. **`INBOUND_EMAIL_TRUSTED_SENDERS`** (comma-separated addresses or
 *     `@domain` entries) — with an authentication PASS when the provider reports
 *     a verdict; on its spelling alone only when the provider reports none.
 *
 * Any authentication FAIL refuses trust, whatever else is true.
 *
 * ## Which verdict counts
 *
 * Only a verdict the RECEIVING side stamped: explicit fields the provider
 * plugin puts on the message metadata (`dmarc`, `spf` / `spfDomain`, `dkim` /
 * `dkimDomain`), or the TOPMOST `Authentication-Results` header — and only when
 * its authserv-id equals `INBOUND_EMAIL_AUTHSERV_ID`. Every other header is the
 * sender's to write (a forged `Authentication-Results: x; dmarc=pass` lower in
 * the message is ignored), and without a configured authserv-id no header is
 * read at all. SPF and DKIM count as a pass ONLY when ALIGNED with the `From`
 * domain (`smtp.mailfrom` / `header.d`); an unaligned pass is "unverified".
 *
 * `INBOUND_EMAIL_AUTO_DISPATCH_ALL=true` (or its older spelling
 * `INBOUND_EMAIL_REPLY_AUTO_DISPATCH=true`) restores the pre-hardening
 * behaviour for EVERY sender.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The provider-stamped authentication outcome of one message. */
export type SenderAuthVerdict =
    /** DMARC pass, or an SPF / DKIM pass aligned with the From domain — and no fail. */
    | 'pass'
    /** Any reported fail (DMARC, SPF, DKIM; softfail and permerror included). */
    | 'fail'
    /** A verdict was reported but nothing passed in alignment with the From domain. */
    | 'unverified'
    /** The provider reported no verdict this module can trust. */
    | 'none';

const truthy = (value: string | undefined): boolean =>
    (value ?? '').trim().toLowerCase() === 'true';

/** `INBOUND_EMAIL_AUTO_DISPATCH_ALL=true` or the older `INBOUND_EMAIL_REPLY_AUTO_DISPATCH=true`. */
export function inboundEmailAutoDispatchAll(env: Env = process.env): boolean {
    return (
        truthy(env.INBOUND_EMAIL_AUTO_DISPATCH_ALL) || truthy(env.INBOUND_EMAIL_REPLY_AUTO_DISPATCH)
    );
}

/** The bare, lower-cased mailbox of a header address (`"Ada" <A@x.io>` → `a@x.io`). */
export function bareSenderAddress(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const text = raw.trim();
    const open = text.lastIndexOf('<');
    const close = text.lastIndexOf('>');
    const bare = open >= 0 && close > open ? text.slice(open + 1, close) : text;
    return bare.trim().toLowerCase();
}

/** The lower-cased domain of an address or a bare domain, without a trailing dot. */
function domainOf(value: string): string {
    const text = value.trim().toLowerCase().replace(/^@/, '');
    const at = text.lastIndexOf('@');
    return (at >= 0 ? text.slice(at + 1) : text).replace(/\.$/, '');
}

/**
 * Relaxed identifier alignment (DMARC): the authenticated domain and the From
 * domain are the same, or one is a subdomain of the other.
 */
function aligned(authDomain: string, fromDomain: string): boolean {
    const a = domainOf(authDomain);
    const f = domainOf(fromDomain);
    if (!a || !f) return false;
    return a === f || a.endsWith(`.${f}`) || f.endsWith(`.${a}`);
}

/** `INBOUND_EMAIL_TRUSTED_SENDERS`, lower-cased: full addresses and `@domain` entries. */
export function configuredTrustedSenders(env: Env = process.env): string[] {
    return (env.INBOUND_EMAIL_TRUSTED_SENDERS ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
}

const FAILING = new Set(['fail', 'softfail', 'permerror', 'hardfail']);

/** The headers as `[name lower-cased, value]` pairs, in message order (topmost first). */
function headerPairs(headers: unknown): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    if (Array.isArray(headers)) {
        for (const header of headers) {
            const h = header as Record<string, unknown>;
            const name = String(h?.Name ?? h?.name ?? '').toLowerCase();
            const value = h?.Value ?? h?.value;
            if (name && typeof value === 'string') out.push([name, value]);
        }
    } else if (headers && typeof headers === 'object') {
        for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
            if (typeof value === 'string') out.push([name.toLowerCase(), value]);
        }
    }
    return out;
}

/**
 * The provider-stamped authentication verdict for a message from `from`
 * (see the file comment for which sources count).
 */
export function senderAuthVerdict(
    metadata: unknown,
    from: string,
    env: Env = process.env,
): SenderAuthVerdict {
    const fromDomain = domainOf(bareSenderAddress(from));
    if (!metadata || typeof metadata !== 'object') return 'none';
    const meta = metadata as Record<string, unknown>;
    const results: Array<{
        kind: 'dmarc' | 'spf' | 'dkim';
        result: string;
        domain: string | null;
    }> = [];
    const word = (value: unknown): string =>
        typeof value === 'string'
            ? value
                  .trim()
                  .toLowerCase()
                  .split(/[\s;(]/)[0]
            : '';

    // 1. Explicit provider fields (a plugin's parsed, receiver-side verdict).
    if (word(meta.dmarc)) results.push({ kind: 'dmarc', result: word(meta.dmarc), domain: null });
    if (word(meta.spf)) {
        results.push({
            kind: 'spf',
            result: word(meta.spf),
            domain: typeof meta.spfDomain === 'string' ? meta.spfDomain : null,
        });
    }
    if (word(meta.dkim)) {
        results.push({
            kind: 'dkim',
            result: word(meta.dkim),
            domain: typeof meta.dkimDomain === 'string' ? meta.dkimDomain : null,
        });
    }

    // 2. The TOPMOST Authentication-Results, only when it carries the configured
    //    authserv-id (the receiving server's own stamp).
    const authservId = (env.INBOUND_EMAIL_AUTHSERV_ID ?? '').trim().toLowerCase();
    if (authservId) {
        const topmost = headerPairs(meta.headers).find(
            ([name]) => name === 'authentication-results',
        );
        const value = topmost?.[1] ?? '';
        const id = value.split(';')[0]?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (topmost && id === authservId) {
            for (const clause of value.split(';').slice(1)) {
                const match = /^\s*(dmarc|spf|dkim)\s*=\s*([a-z]+)/i.exec(clause);
                if (!match) continue;
                const kind = match[1].toLowerCase() as 'dmarc' | 'spf' | 'dkim';
                const domainMatch =
                    kind === 'spf'
                        ? /smtp\.mailfrom=([^\s;]+)/i.exec(clause)
                        : kind === 'dkim'
                          ? /header\.d=([^\s;]+)/i.exec(clause)
                          : /header\.from=([^\s;]+)/i.exec(clause);
                results.push({
                    kind,
                    result: match[2].toLowerCase(),
                    domain: domainMatch ? domainMatch[1] : null,
                });
            }
        }
    }

    if (results.length === 0) return 'none';
    // Any fail wins — a pass elsewhere never outweighs it.
    if (results.some((entry) => FAILING.has(entry.result))) return 'fail';
    const passed = results.some((entry) => {
        if (entry.result !== 'pass') return false;
        if (entry.kind === 'dmarc')
            return entry.domain === null || aligned(entry.domain, fromDomain);
        return entry.domain !== null && aligned(entry.domain, fromDomain);
    });
    return passed ? 'pass' : 'unverified';
}

/**
 * Whether an inbound email's sender is trusted on rules 2 and 3 of the file
 * comment. Rule 1 (agent-to-agent mail from the platform's own outbound
 * record) is decided by the dispatcher and passed in as `platformSent`.
 */
export function isTrustedSender(input: {
    from: string;
    /** The owner's verified SENDING addresses — never the receiving or an inbound-only address. */
    ownerAddresses: readonly string[];
    metadata?: unknown;
    /** The message is one the owner's account itself sent to this address. */
    platformSent?: boolean;
    env?: Env;
}): boolean {
    const env = input.env ?? process.env;
    const sender = bareSenderAddress(input.from);
    if (!sender || !sender.includes('@')) return false;
    const verdict = senderAuthVerdict(input.metadata, sender, env);
    if (verdict === 'fail') return false;
    if (input.platformSent === true) return true;

    const owner = new Set(input.ownerAddresses.map(bareSenderAddress).filter(Boolean));
    if (owner.has(sender) && verdict === 'pass') return true;

    const domain = `@${domainOf(sender)}`;
    const listed = configuredTrustedSenders(env).some(
        (entry) => entry === sender || entry === domain,
    );
    if (!listed) return false;
    // Explicitly listed: a pass when the provider reports a verdict; the
    // spelling alone only when it reports none (the documented caveat).
    return verdict === 'pass' || verdict === 'none';
}
