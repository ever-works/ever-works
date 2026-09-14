import { describe, expect, it } from 'vitest';
import type { EmailCapMeterDto, EmailCapWindowDto } from '@ever-works/contracts';
import {
    RECOMMENDED_AGENT_INBOX_CAPS,
    describeEmailSendRefusal,
    formatCapInput,
    hasNoConfiguredAgentLimits,
    initialCapInputs,
    isDecidableDraft,
    minutesUntil,
    parseCapInput,
    unconfiguredAgentCapFields,
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

describe('unconfigured limits', () => {
    const meter = (
        sources: Partial<Record<string, EmailCapWindowDto['source']>>,
        enforced = true,
    ): EmailCapMeterDto => ({
        agentId: 'agent-1',
        enforced,
        mode: 'auto-send',
        modeSource: 'platform',
        pausedUntil: null,
        windows: Object.entries(sources).map(([kind, source]) => ({
            kind: kind as EmailCapWindowDto['kind'],
            scope: 'inbox',
            used: 0,
            cap: source === 'unconfigured' ? null : 5,
            windowSeconds: 60,
            source: source as EmailCapWindowDto['source'],
        })),
    });

    it('keeps the recommended per-Agent numbers in one place', () => {
        expect(RECOMMENDED_AGENT_INBOX_CAPS).toEqual({
            dailySendCap: 100,
            burstSendCap: 10,
            recipientBurstCap: 20,
            recipientsPerMessageCap: 50,
        });
    });

    it('reports "no limits" only when every per-Agent window is unconfigured', () => {
        const none = meter({
            recipientsPerMessage: 'unconfigured',
            inboxBurst: 'unconfigured',
            inboxRecipients: 'unconfigured',
            inboxDaily: 'unconfigured',
            workspaceDaily: 'platform',
        });
        expect(hasNoConfiguredAgentLimits(none)).toBe(true);
        expect(unconfiguredAgentCapFields(none)).toEqual([
            'dailySendCap',
            'burstSendCap',
            'recipientBurstCap',
            'recipientsPerMessageCap',
        ]);
        expect(
            hasNoConfiguredAgentLimits(
                meter({ inboxDaily: 'organization', inboxBurst: 'unconfigured' }),
            ),
        ).toBe(false);
        expect(hasNoConfiguredAgentLimits(meter({ inboxDaily: 'recommended' }))).toBe(false);
        expect(hasNoConfiguredAgentLimits(meter({ inboxDaily: 'unconfigured' }, false))).toBe(
            false,
        );
        expect(hasNoConfiguredAgentLimits(meter({}))).toBe(false);
    });

    it('pre-fills only limits nothing configures, and only before the Agent has settings', () => {
        const partly = meter({ inboxDaily: 'organization', inboxBurst: 'unconfigured' });
        expect(initialCapInputs({ inbox: null, meter: partly })).toEqual({
            dailySendCap: '',
            burstSendCap: '10',
            recipientBurstCap: '',
            recipientsPerMessageCap: '',
        });
        const withSettings = initialCapInputs({
            inbox: {
                id: 'inbox-1',
                agentId: 'agent-1',
                emailAddressId: null,
                mode: 'auto-send',
                state: 'active',
                caps: {
                    inboxDailySends: 7,
                    inboxBurstSends: null,
                    inboxBurstRecipients: null,
                    recipientsPerMessage: 0,
                },
                capPausedUntil: null,
                createdAt: '2026-09-14T00:00:00.000Z',
                updatedAt: '2026-09-14T00:00:00.000Z',
            },
            meter: partly,
        });
        expect(withSettings).toEqual({
            dailySendCap: '7',
            burstSendCap: '',
            recipientBurstCap: '',
            recipientsPerMessageCap: '0',
        });
        expect(initialCapInputs(null)).toEqual({
            dailySendCap: '',
            burstSendCap: '',
            recipientBurstCap: '',
            recipientsPerMessageCap: '',
        });
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
