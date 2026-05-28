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
    if (!form.subject.trim()) return { ok: false, error: 'Subject is required.' };
    if (!form.bodyText.trim()) return { ok: false, error: 'Message body is required.' };

    try {
        const result = await emailAddressesAPI.sendMessage({
            agentId,
            to,
            cc: form.cc ? splitRecipients(form.cc) : undefined,
            subject: form.subject,
            bodyText: form.bodyText,
        });
        return { ok: true, providerMessageId: result.providerMessageId };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Send failed.' };
    }
}
