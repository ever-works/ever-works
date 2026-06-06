import type { APIRequestContext } from '@playwright/test';

/**
 * MailHog helper for the e2e suite.
 *
 * The e2e workflow runs a `mailhog` service container exposing SMTP on
 * :1025 and the HTTP API on :8025 (`MAILHOG_URL` env var). Specs that
 * need to read back outbound mail (extract a verification token from a
 * reset email, assert an invitation was sent, etc.) can use these
 * helpers without re-implementing the JSON-API plumbing in every file.
 *
 * Specs that don't have MailHog reachable (local laptop without the
 * service container) can call `isMailhogAvailable(request)` first and
 * test.skip() rather than fail.
 */

export const MAILHOG_URL = process.env.MAILHOG_URL || 'http://127.0.0.1:8025';

export interface MailhogMessage {
    ID: string;
    From: { Mailbox: string; Domain: string; Params: string };
    To: Array<{ Mailbox: string; Domain: string; Params: string }>;
    Content: {
        Headers: Record<string, string[]>;
        Body: string;
        Size: number;
        MIME: unknown;
    };
    Created: string;
    Raw: { From: string; To: string[]; Data: string; Helo: string };
}

interface MailhogListResponse {
    total: number;
    count: number;
    start: number;
    items: MailhogMessage[];
}

/**
 * Returns true when MailHog's HTTP API is reachable. Use as a gate at
 * the top of a `beforeAll` to surface a clear skip rather than a
 * generic timeout when the service container isn't running.
 */
export async function isMailhogAvailable(request: APIRequestContext): Promise<boolean> {
    try {
        const res = await request.get(`${MAILHOG_URL}/api/v2/messages?limit=1`);
        return res.ok();
    } catch {
        return false;
    }
}

/**
 * Wipe MailHog's inbox. Call before a test that needs to count or read
 * specific messages so it doesn't see noise from prior tests.
 */
export async function clearMailhogInbox(request: APIRequestContext): Promise<void> {
    await request.delete(`${MAILHOG_URL}/api/v1/messages`).catch(() => undefined);
}

/**
 * Decode a quoted-printable transport body. MailHog returns the raw
 * on-the-wire body, and our HTML templates are sent with
 * `Content-Transfer-Encoding: quoted-printable` — so `=` becomes `=3D`
 * and long lines are soft-wrapped with a trailing `=\r\n`. That wrapping
 * splits links mid-token (`…?token=3D982a…=\r\n8bd5…`), so a regex like
 * `…?token=[a-f0-9]+` never matches the raw body. Strip soft breaks
 * first, then resolve `=XX` hex escapes. Byte-wise decode is fine here —
 * every token/link we fish out is ASCII.
 */
export function decodeQuotedPrintable(input: string): string {
    return input
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * List the most-recent N messages (default 50), newest first.
 *
 * Quoted-printable bodies are decoded in place so every downstream
 * consumer (`extractLinkFromBody`, per-spec token regexes, raw
 * `Content.Body` reads) sees the logical content rather than the
 * `=3D`/soft-wrapped transport encoding. Only QP-encoded messages are
 * touched — decoding a 7bit/plain body that legitimately contains
 * `=<hex>` (e.g. `?token=ab12…`) would corrupt it.
 */
export async function listMessages(
    request: APIRequestContext,
    limit = 50,
): Promise<MailhogMessage[]> {
    const res = await request.get(`${MAILHOG_URL}/api/v2/messages?limit=${limit}`);
    if (!res.ok()) return [];
    const body = (await res.json()) as MailhogListResponse;
    const items = body.items ?? [];
    for (const message of items) {
        const cte = headerOf(message, 'Content-Transfer-Encoding');
        if (cte && cte.toLowerCase() === 'quoted-printable' && message.Content?.Body) {
            message.Content.Body = decodeQuotedPrintable(message.Content.Body);
        }
    }
    return items;
}

/**
 * Poll for a message addressed to a specific recipient. Returns the
 * first match, or null if none arrives within the timeout. MailHog
 * delivers SMTP-side instantly but the API's "received" stamp lags by
 * a few hundred ms on a cold runner — poll loop covers that.
 */
export async function waitForMessageTo(
    request: APIRequestContext,
    recipient: string,
    options: { timeoutMs?: number; pollIntervalMs?: number; subject?: RegExp } = {},
): Promise<MailhogMessage | null> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollIntervalMs ?? 300;
    // Optional subject filter. On a cold CI runner an earlier email to the same
    // address (e.g. the registration confirmation sent before this test's inbox
    // clear) can land over SMTP AFTER the clear and sit in the box alongside the
    // mail we actually triggered. Matching on recipient alone then returns the
    // wrong message; callers that triggered a specific mail (password reset,
    // verification, …) pass a `subject` so we wait for THAT email — mirroring
    // magic-link.spec.ts's subject-filtered poll.
    const subjectRe = options.subject;
    const deadline = Date.now() + timeoutMs;
    const recipientLower = recipient.toLowerCase();
    while (Date.now() < deadline) {
        const messages = await listMessages(request);
        const match = messages.find((m) => {
            const toMatch = m.To?.some(
                (t) => `${t.Mailbox}@${t.Domain}`.toLowerCase() === recipientLower,
            );
            if (!toMatch) return false;
            if (subjectRe) {
                const subject = headerOf(m, 'Subject') ?? '';
                if (!subjectRe.test(subject)) return false;
            }
            return true;
        });
        if (match) return match;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
}

/**
 * Extract the first URL in a message body that matches `pattern`. Use
 * for fishing a verification / reset / magic-link token out of an
 * email body without coupling to the specific template HTML.
 */
export function extractLinkFromBody(message: MailhogMessage, pattern: RegExp): string | null {
    const m = pattern.exec(message.Content.Body);
    return m?.[0] ?? null;
}

/**
 * Get the value of a single header from a MailHog message (case-
 * insensitive). MailHog returns header values as arrays; we return
 * the first.
 */
export function headerOf(message: MailhogMessage, name: string): string | null {
    const wanted = name.toLowerCase();
    for (const [key, values] of Object.entries(message.Content.Headers)) {
        if (key.toLowerCase() === wanted) {
            return values[0] ?? null;
        }
    }
    return null;
}
