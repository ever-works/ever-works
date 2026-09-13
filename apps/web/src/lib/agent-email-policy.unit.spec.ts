import { describe, expect, it } from 'vitest';
import {
    describeEmailSendRefusal,
    formatCapInput,
    isDecidableDraft,
    minutesUntil,
    parseCapInput,
} from './agent-email-policy';

describe('parseCapInput', () => {
    it('keeps "inherit" (blank) and "no limit" (0) distinct', () => {
        expect(parseCapInput('')).toBeNull();
        expect(parseCapInput('   ')).toBeNull();
        expect(parseCapInput('0')).toBe(0);
        expect(parseCapInput(' 25 ')).toBe(25);
    });

    it.each(['-1', '2.5', 'ten', '1e3', '1000001'])('refuses %j', (raw) => {
        expect(parseCapInput(raw)).toBeUndefined();
    });

    it('round-trips through the field text', () => {
        expect(formatCapInput(null)).toBe('');
        expect(formatCapInput(undefined)).toBe('');
        expect(formatCapInput(0)).toBe('0');
        expect(parseCapInput(formatCapInput(40))).toBe(40);
    });
});

describe('describeEmailSendRefusal', () => {
    it('reads a send-limit refusal from the structured body, not the message', () => {
        const error = {
            statusCode: 429,
            message: 'anything at all',
            details: {
                statusCode: 429,
                error: 'EmailSendCapExceeded',
                details: { limitKind: 'inboxDaily', used: 100, cap: 100, retryAfterSeconds: 3_600 },
            },
        };
        expect(describeEmailSendRefusal(error)).toEqual({
            kind: 'sendLimit',
            limitKind: 'inboxDaily',
            used: 100,
            cap: 100,
            retryAfterSeconds: 3_600,
        });
    });

    it('recognises the approval and already-decided refusals', () => {
        expect(describeEmailSendRefusal({ details: { error: 'EmailApprovalRequired' } })).toEqual({
            kind: 'approvalRequired',
        });
        expect(
            describeEmailSendRefusal({ details: { error: 'EmailDraftAlreadyDecided' } }),
        ).toEqual({ kind: 'alreadyDecided' });
    });

    it('returns null for anything else, including a malformed limit body', () => {
        expect(describeEmailSendRefusal(new Error('boom'))).toBeNull();
        expect(describeEmailSendRefusal(null)).toBeNull();
        expect(
            describeEmailSendRefusal({ details: { error: 'EmailSendCapExceeded', details: {} } }),
        ).toBeNull();
    });
});

describe('small helpers', () => {
    it('rounds the wait up to whole minutes, at least one', () => {
        expect(minutesUntil(0)).toBe(1);
        expect(minutesUntil(61)).toBe(2);
        expect(minutesUntil(3_600)).toBe(60);
    });

    it('only a draft is decidable', () => {
        expect(isDecidableDraft('draft')).toBe(true);
        for (const status of ['sent', 'sending', 'discarded', 'received', null, undefined]) {
            expect(isDecidableDraft(status)).toBe(false);
        }
    });
});
