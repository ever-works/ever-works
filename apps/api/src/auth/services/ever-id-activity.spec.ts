import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { EverIdActivityService } from './ever-id-activity.service';

/**
 * APW-12 (Ever ID) — the Activity rows of spec FR-49 / plan §5.6: the eight
 * actions, each with IP address and user agent like other sign-in rows, the
 * identity's display name, and never a token, code, subject, issuer or state
 * (ACC-12-37).
 */
describe('EverIdActivityService', () => {
    const ctx = { ipAddress: '203.0.113.9', userAgent: 'Example Browser' };
    const planted = [
        'eyJ.token.value',
        'auth-code-123',
        'subject-xyz',
        'https://id.example.test',
        'state-abc',
    ];

    function capture() {
        const rows: Array<Record<string, unknown>> = [];
        const service = new EverIdActivityService({
            log: async (row: Record<string, unknown>) => {
                rows.push(row);
                return row;
            },
        } as never);
        return { rows, service };
    }

    it('writes the eight FR-49 actions with their action types and summaries', async () => {
        const { rows, service } = capture();

        service.signedIn('u', 'i', 'Ever ID', ctx);
        service.signedUp('u', 'i', 'Ever ID', ctx);
        service.signedInFromTerminal('u', 'i', 'cli', 'Ever ID', ctx);
        service.connected('u', 'i', true, 'Ever ID', ctx);
        service.disconnected('u', 'i', 2, 'Ever ID', ctx);
        service.signedOutElsewhere('u', 'i', 1, 'sid', ctx);
        service.delegatedRead('u', 'i', 'client-1', 'Ever apps', ctx);
        service.configChanged('u', ['enabled'], ctx);
        await new Promise((resolve) => setImmediate(resolve));

        expect(rows.map((row) => [row.actionType, row.action])).toEqual([
            [ActivityActionType.USER_LOGIN, 'user.login.ever-id'],
            [ActivityActionType.USER_SIGNUP, 'user.signup.ever-id'],
            [ActivityActionType.USER_LOGIN, 'user.login.ever-id.device'],
            [ActivityActionType.IDENTITY_LINKED, 'auth.ever_id.linked'],
            [ActivityActionType.IDENTITY_UNLINKED, 'auth.ever_id.unlinked'],
            [ActivityActionType.USER_LOGOUT, 'auth.ever_id.backchannel_logout'],
            [ActivityActionType.DELEGATED_ACCESS, 'auth.ever_id.delegated_read'],
            [ActivityActionType.IDENTITY_PROVIDER_CONFIG_CHANGED, 'auth.ever_id.config_changed'],
        ]);
        for (const row of rows) {
            expect(row).toMatchObject({
                userId: 'u',
                status: ActivityStatus.COMPLETED,
                ipAddress: '203.0.113.9',
                userAgent: 'Example Browser',
            });
            expect(typeof row.summary).toBe('string');
        }
        expect(rows[6].summary).toBe('Ever apps read your App Works');
    });

    it('never writes a token, code, subject, issuer or state — the metadata is ids and counts', async () => {
        const { rows, service } = capture();

        service.signedIn('u', 'identity-id', 'Ever ID', ctx);
        service.signedOutElsewhere('u', 'identity-id', 3, 'sub', ctx);
        service.signInRefused('accountDisabled', ctx, 'u');
        await new Promise((resolve) => setImmediate(resolve));

        const dump = JSON.stringify(rows);
        for (const value of planted) expect(dump).not.toContain(value);
        expect(rows[2]).toMatchObject({
            status: ActivityStatus.FAILED,
            metadata: { reason: 'accountDisabled' },
        });
    });

    it('never fails the caller when the write fails', () => {
        const service = new EverIdActivityService({
            log: () => Promise.reject(new Error('down')),
        } as never);
        expect(() => service.signedIn('u', 'i', 'Ever ID', ctx)).not.toThrow();
    });
});
