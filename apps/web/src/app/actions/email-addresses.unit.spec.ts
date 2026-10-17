import { beforeEach, describe, expect, it, vi } from 'vitest';

const { api, getAuthMock, redirectMock, revalidateMock } = vi.hoisted(() => ({
    api: {
        create: vi.fn(),
        triggerVerification: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        confirm: vi.fn(),
    },
    getAuthMock: vi.fn(),
    redirectMock: vi.fn(() => {
        throw new Error('NEXT_REDIRECT');
    }),
    revalidateMock: vi.fn(),
}));

vi.mock('@/lib/api/email-addresses', () => ({ emailAddressesAPI: api }));
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: getAuthMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidateMock }));

import {
    confirmEmailAddressAction,
    createEmailAddressAction,
    removeEmailAddressAction,
    sendEmailAddressVerificationAction,
    setEmailAddressDisabledAction,
} from './email-addresses';

/**
 * EW-P4-3 — the server actions behind Settings → Email addresses (the
 * add-address wizard and row actions) and the public confirmation page.
 */
describe('email address actions', () => {
    beforeEach(() => {
        Object.values(api).forEach((fn) => fn.mockReset());
        getAuthMock.mockReset().mockResolvedValue({ id: 'user-1' });
        redirectMock.mockClear();
        revalidateMock.mockClear();
    });

    it('creates an address and refreshes the settings page', async () => {
        api.create.mockResolvedValue({ id: 'addr-1', address: 'a@b.test' });
        const input = {
            address: 'a@b.test',
            direction: 'outbound' as const,
            pluginId: 'postmark',
            providerSettings: {},
        };
        await expect(createEmailAddressAction(input)).resolves.toEqual({
            success: true,
            data: { id: 'addr-1', address: 'a@b.test' },
            error: null,
        });
        expect(api.create).toHaveBeenCalledWith(input);
        expect(revalidateMock).toHaveBeenCalledWith('/settings/integrations/emails');
    });

    it("reports the API's own reason when something fails", async () => {
        api.triggerVerification.mockRejectedValue(
            new Error(
                'A confirmation email was just sent to this address. Wait a minute before sending another.',
            ),
        );
        await expect(sendEmailAddressVerificationAction('addr-1')).resolves.toEqual({
            success: false,
            data: null,
            error: 'A confirmation email was just sent to this address. Wait a minute before sending another.',
        });
    });

    it('reports a sent confirmation and an already-verified address apart', async () => {
        api.triggerVerification.mockResolvedValueOnce({ messageRef: 'r', sent: true });
        await expect(sendEmailAddressVerificationAction('addr-1')).resolves.toMatchObject({
            data: { sent: true, alreadyVerified: false },
        });
        api.triggerVerification.mockResolvedValueOnce({
            messageRef: 'r',
            sent: false,
            alreadyVerified: true,
        });
        await expect(sendEmailAddressVerificationAction('addr-1')).resolves.toMatchObject({
            data: { sent: false, alreadyVerified: true },
        });
    });

    it('disables / enables and removes', async () => {
        api.update.mockResolvedValue({ id: 'addr-1', disabledAt: '2026-10-16T00:00:00Z' });
        await setEmailAddressDisabledAction('addr-1', true);
        expect(api.update).toHaveBeenCalledWith('addr-1', { disabled: true });
        api.remove.mockResolvedValue(undefined);
        await expect(removeEmailAddressAction('addr-1')).resolves.toMatchObject({ success: true });
        expect(api.remove).toHaveBeenCalledWith('addr-1');
    });

    it('sends a signed-out visitor of the settings actions to login', async () => {
        getAuthMock.mockResolvedValue(null);
        await expect(removeEmailAddressAction('addr-1')).rejects.toThrow('NEXT_REDIRECT');
        expect(api.remove).not.toHaveBeenCalled();
    });

    it('confirms from the emailed link WITHOUT a session (the token is the proof)', async () => {
        getAuthMock.mockResolvedValue(null);
        api.confirm.mockResolvedValue({ verified: true });
        await expect(confirmEmailAddressAction('tok_123')).resolves.toEqual({
            success: true,
            data: { verified: true },
            error: null,
        });
        expect(api.confirm).toHaveBeenCalledWith('tok_123');
        expect(redirectMock).not.toHaveBeenCalled();
    });

    it('answers "not verified" for an expired or unknown link, and never calls the API for junk', async () => {
        api.confirm.mockResolvedValue({ verified: false });
        await expect(confirmEmailAddressAction('expired')).resolves.toMatchObject({
            data: { verified: false },
        });
        await expect(confirmEmailAddressAction('')).resolves.toMatchObject({
            data: { verified: false },
        });
        await expect(confirmEmailAddressAction('x'.repeat(201))).resolves.toMatchObject({
            data: { verified: false },
        });
        expect(api.confirm).toHaveBeenCalledTimes(1);
    });
});
