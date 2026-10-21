import { FleetLinkException, fleetLinkError } from '../../fleet-link/fleet-link.errors';
import {
    FleetFilesService,
    parseFleetFilesLocation,
    parseFleetFilesNames,
} from './fleet-files.service';

/**
 * Files on computers (FL-11, T-08/T-10) — the browsing service: paths refused
 * before anything is contacted, delete's typed-name confirmation AFTER the
 * gate, the list audited once per visit, and the machine's refusal carried
 * back unchanged. Written, not run (fast-build rule).
 */

const NODE = { id: '11111111-1111-4111-8111-111111111111', userId: 'owner-1', name: 'build-01' };
const ROOT = 'abcdef0123456789';

function setup(reply: unknown = { result: { entries: [], truncated: false, total: 0 } }) {
    const channel = {
        isClosed: false,
        request: jest.fn(async () => ({ requestId: 'r-1', ...(reply as object) })),
        close: jest.fn(),
    };
    const link = {
        request: jest.fn(),
        openChannel: jest.fn(async () => channel),
        authorizeRequest: jest.fn(async () => NODE),
    };
    const audit = { tryRecord: jest.fn(async () => true) };
    const service = new FleetFilesService(
        { getVisibleForUser: jest.fn(async () => ({ view: {}, role: 'owner' })) } as never,
        { findById: jest.fn(async () => NODE) } as never,
        link as never,
        audit as never,
    );
    return { service, link, channel, audit };
}

describe('parse helpers', () => {
    it('refuses escapes and bad roots before anything is contacted (U4)', () => {
        expect(() => parseFleetFilesLocation('../x', '')).toThrow(FleetLinkException);
        expect(() => parseFleetFilesLocation(ROOT, '../../etc')).toThrow(
            'That path leaves its root',
        );
        expect(parseFleetFilesLocation(ROOT, 'src//server/')).toEqual({
            root: ROOT,
            path: 'src/server',
        });
        expect(() => parseFleetFilesNames(['a/b'], 'entries', 10)).toThrow(
            'That path leaves its root',
        );
        expect(() =>
            parseFleetFilesNames(
                Array.from({ length: 11 }, (_, i) => `f${i}`),
                'entries',
                10,
            ),
        ).toThrow(/fewer than 10/);
    });
});

describe('FleetFilesService', () => {
    it('lists through a short-lived files channel and audits once per visit (FR-19)', async () => {
        const { service, link, channel, audit } = setup();
        const caller = { kind: 'user' as const, userId: 'owner-1' };
        await service.listAs(caller, NODE.id, { root: ROOT, path: 'src' });
        await service.listAs(caller, NODE.id, { root: ROOT, path: 'src/server' });
        expect(link.openChannel).toHaveBeenCalledWith(
            expect.objectContaining({
                family: 'files',
                params: { root: ROOT, path: 'src' },
                requirement: expect.objectContaining({
                    actionFamily: 'files',
                    stateChanging: false,
                }),
            }),
        );
        expect(channel.close).toHaveBeenCalled();
        expect(audit.tryRecord).toHaveBeenCalledTimes(1);
        expect(audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.files.list',
                details: expect.objectContaining({ root: ROOT }),
            }),
        );
    });

    it('carries the machine refusal back unchanged (FR-21)', async () => {
        const { service } = setup({
            error: { code: 'invalid', hint: 'That path leaves its root' },
        });
        await expect(
            service.listAs({ kind: 'user', userId: 'owner-1' }, NODE.id, {
                root: ROOT,
                path: 'link-out',
            }),
        ).rejects.toMatchObject({
            linkError: { code: 'invalid', hint: 'That path leaves its root' },
        });
    });

    it('asks for the typed name after the gate, and deletes only on an exact match (FR-18)', async () => {
        const { service, link, channel } = setup({ result: { removed: 1 } });
        const caller = { kind: 'user' as const, userId: 'owner-1' };
        await expect(
            service.deleteAs(caller, NODE.id, {
                root: ROOT,
                path: 'build',
                entries: ['old-build'],
            }),
        ).rejects.toMatchObject({
            linkError: {
                code: 'confirmation_required',
                details: expect.objectContaining({
                    class: 'confirm-destructive',
                    confirmName: 'old-build',
                }),
            },
        });
        expect(link.authorizeRequest).toHaveBeenCalled();
        expect(link.openChannel).not.toHaveBeenCalled();
        await expect(
            service.deleteAs(caller, NODE.id, {
                root: ROOT,
                path: 'build',
                entries: ['old-build'],
                confirmName: 'Old-build',
            }),
        ).rejects.toMatchObject({ linkError: { code: 'confirmation_required' } });
        await expect(
            service.deleteAs(caller, NODE.id, {
                root: ROOT,
                path: 'build',
                entries: ['old-build'],
                confirmName: 'old-build',
            }),
        ).resolves.toMatchObject({ removed: 1 });
        expect(channel.request).toHaveBeenCalledWith(
            'files.delete',
            expect.objectContaining({ entries: ['old-build'] }),
            expect.anything(),
        );
    });

    it('names the folder for several entries (spec §5.3)', async () => {
        const { service } = setup({ result: { removed: 2 } });
        const refusal = await service
            .deleteAs({ kind: 'user', userId: 'owner-1' }, NODE.id, {
                root: ROOT,
                path: 'acme/src',
                entries: ['a', 'b'],
            })
            .catch((error: FleetLinkException) => error);
        expect((refusal as FleetLinkException).linkError.details).toMatchObject({
            confirmName: 'src',
            entries: 2,
        });
    });

    it('does not ask a caller who may not act (the gate refuses first)', async () => {
        const { service, link } = setup();
        link.authorizeRequest.mockRejectedValueOnce(
            fleetLinkError('permission_denied', 'ask the owner'),
        );
        await expect(
            service.deleteAs({ kind: 'user', userId: 'other' }, NODE.id, {
                root: ROOT,
                entries: ['a'],
            }),
        ).rejects.toMatchObject({ linkError: { code: 'permission_denied' } });
    });
});
