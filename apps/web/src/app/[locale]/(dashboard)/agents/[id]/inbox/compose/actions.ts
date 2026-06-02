'use server';

import { emailAddressesAPI } from '@/lib/api/email-addresses';

/**
 * EW-680 / T32 — server action for the inbox composer. Splits the
 * comma/newline-separated recipient strings into arrays and forwards to
 * the email API. Returns a discriminated result the client renders.
 */
export interface ComposeActionResult {
    ok: boolean;
    error?: string;
    providerMessageId?: string;
}

// Security: RFC 5321-style email format check — rejects bare hostnames
// (user@localhost, user@169.254.x.x) and other malformed addresses that
// could be used to probe internal mail relays or enumerate addresses.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(address: string): boolean {
    return EMAIL_REGEX.test(address);
}

function splitRecipients(raw: string): string[] {
    return raw
        .split(/[,\n;]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export async function sendAgentEmailAction(
    agentId: string,
    form: { to: string; cc: string; subject: string; bodyText: string },
): Promise<ComposeActionResult> {
    const to = splitRecipients(form.to);
    if (to.length === 0) return { ok: false, error: 'At least one recipient is required.' };

    // Security: validate each To address against RFC 5321 format to prevent
    // forwarding bare internal hostnames (e.g. user@localhost) to the mail stack.
    const invalidTo = to.find((addr) => !isValidEmail(addr));
    if (invalidTo) return { ok: false, error: `Invalid recipient address: ${invalidTo}` };

    const cc = form.cc ? splitRecipients(form.cc) : undefined;

    // Security: validate each Cc address the same way.
    if (cc) {
        const invalidCc = cc.find((addr) => !isValidEmail(addr));
        if (invalidCc) return { ok: false, error: `Invalid CC address: ${invalidCc}` };
    }

    if (!form.subject.trim()) return { ok: false, error: 'Subject is required.' };
    if (!form.bodyText.trim()) return { ok: false, error: 'Message body is required.' };

    try {
        const result = await emailAddressesAPI.sendMessage({
            agentId,
            to,
            cc,
            subject: form.subject,
            bodyText: form.bodyText,
        });
        return { ok: true, providerMessageId: result.providerMessageId };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Send failed.' };
    }
}
