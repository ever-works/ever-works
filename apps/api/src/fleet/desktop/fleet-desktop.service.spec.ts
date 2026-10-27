import { encodeComputerFrame, FLEET_LINK_FRAME_KINDS } from '@ever-works/contracts';
import { FleetLinkException } from '../../fleet-link/fleet-link.errors';
import { FleetDesktopService } from './fleet-desktop.service';

/**
 * Desktop view & control (FL-07, T-19, T-21, FR-27, FR-28, FR-32, FR-33, U7 …
 * U11) — the gates in order with the CONTRACTS code and hint, the caps across
 * both sources, the audit rows, the read-only grant, and the viewer observer.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-1';
const STRANGER = 'stranger-1';

process.env.FLEET_DESKTOP_ENABLED = 'true';
process.env.FLEET_NODE_LINK_ENABLED = 'true';

function node(overrides: Record<string, unknown> = {}) {
    return {
        id: NODE_ID,
        userId: OWNER,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
        organizationId: null,
        consents: { work: false, attend: true, manage: false, usageScan: false },
        capabilities: ['attended', 'screen', 'helper:screen', 'screen:desktop'],
        workerState: null,
        helperTrust: 'hash-pinned',
        desktopFacts: {
            helper: {
                trust: 'hash-pinned',
                present: true,
                admitted: true,
                fingerprintPrefix: 'abcdef12',
            },
            displays: [
                {
                    id: 'DP-1',
                    name: 'Display 1',
                    width: 1920,
                    height: 1080,
                    scale: 1,
                    primary: true,
                },
                { id: 'DP-2', name: 'Display 2', width: 1280, height: 1024, scale: 1 },
            ],
            reasons: [],
            reportedAt: new Date().toISOString(),
            seenEventIds: [],
        },
        ...overrides,
    };
}

function build(
    options: {
        row?: Record<string, unknown>;
        stopped?: boolean;
        openSessions?: number;
        connected?: boolean;
    } = {},
) {
    const row = node(options.row);
    const audits: Array<{ action: string; extra: Record<string, unknown> }> = [];
    const mints: Array<Record<string, unknown>> = [];
    const access = {
        resolveVisible: jest.fn(async (id: string, caller: { userId: string }) => {
            if (id !== NODE_ID || caller.userId === STRANGER) {
                throw new Error('Fleet node not found');
            }
            return { node: row, role: caller.userId === OWNER ? 'owner' : 'org-member' };
        }),
        canAct: jest.fn(
            async (_node: unknown, caller: { userId: string }) => caller.userId === OWNER,
        ),
    };
    const links = {
        isConnected: jest.fn(() => options.connected ?? true),
        liveConsents: jest.fn(() => null),
        openChannel: jest.fn(),
    };
    const attach = {
        mint: jest.fn(async (input: Record<string, unknown>) => {
            mints.push(input);
            return {
                token: 'viewer-token',
                wsPath: `/ws/fleet/desktop/${input.target}`,
                expiresInSec: 60,
                role: input.role,
            };
        }),
    };
    const sessions = {
        findOpenForNode: jest.fn(async () =>
            Array.from({ length: options.openSessions ?? 0 }, (_, i) => ({ id: `s${i}` })),
        ),
        findOpenForScope: jest.fn(async () =>
            Array.from({ length: options.openSessions ?? 0 }, (_, i) => ({ id: `s${i}` })),
        ),
    };
    const service = new FleetDesktopService(
        { findById: jest.fn(async () => row) } as never,
        access as never,
        { isStopped: jest.fn(async () => options.stopped === true) } as never,
        {
            recordNodeAction: jest.fn(
                async (input: { action: string; extra: Record<string, unknown> }) => {
                    audits.push({ action: input.action, extra: input.extra });
                    return true;
                },
            ),
        } as never,
        links as never,
        attach as never,
        sessions as never,
    );
    return { service, audits, mints, links, access };
}

async function refusal(
    promise: Promise<unknown>,
): Promise<{ code: string; hint: string; details?: Record<string, unknown> }> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof FleetLinkException) return error.linkError as never;
        throw error;
    }
    throw new Error('expected a refusal');
}

describe('FleetDesktopService.availability', () => {
    it('answers available with the helper and the displays', async () => {
        const { service } = build();
        const view = await service.availability(OWNER, NODE_ID);
        expect(view).toMatchObject({
            available: true,
            blocker: null,
            hint: null,
            browserSourceAvailable: true,
            maxViews: 2,
        });
        expect(view.displays.map((display) => display.id)).toEqual(['DP-1', 'DP-2']);
        expect(view.helper?.fingerprintPrefix).toBe('abcdef12');
    });

    it.each([
        [{ stopped: true }, 'kill-switch', 'Settings → Fleet'],
        [{ row: { kind: 'desktop-node' } }, 'kind-unsupported', 'kind of computer'],
        [{ row: { lastHeartbeatAt: new Date(Date.now() - 6 * 3_600_000) } }, 'offline', 'offline'],
        [
            { row: { consents: { work: true, attend: false, manage: false, usageScan: false } } },
            'consent-missing',
            '--attend',
        ],
        [
            {
                row: {
                    desktopFacts: {
                        helper: null,
                        displays: [],
                        reasons: ['helper-unadmitted'],
                        reportedAt: '',
                        seenEventIds: [],
                    },
                },
            },
            'helper-unadmitted',
            'helper admit',
        ],
        [
            {
                row: {
                    desktopFacts: {
                        helper: null,
                        displays: [],
                        reasons: ['wayland-unsupported'],
                        reportedAt: '',
                        seenEventIds: [],
                    },
                },
            },
            'wayland-unsupported',
            'X11',
        ],
        [{ row: { helperTrust: 'none', desktopFacts: null } }, 'helper-missing', 'helper install'],
        [{ connected: false }, 'link-unavailable', 'not connected'],
    ])('names the blocker %#', async (options, blocker, hint) => {
        const { service } = build(options as never);
        const view = await service.availability(OWNER, NODE_ID);
        expect(view.available).toBe(false);
        expect(view.blocker).toBe(blocker);
        expect(view.hint).toContain(hint);
    });

    it('tells a viewer outside the desktop audience why, without the picture', async () => {
        const { service, access } = build();
        access.resolveVisible.mockImplementationOnce(
            async () => ({ node: node(), role: 'org-member' }) as never,
        );
        const view = await service.availability('member-1', NODE_ID);
        expect(view).toMatchObject({ available: false, blocker: 'permission-denied' });
    });
});

describe('FleetDesktopService.openView', () => {
    it('opens a read-only view: viewer grant, desktop params, audited', async () => {
        const { service, mints, audits } = build();
        const result = await service.openView(OWNER, NODE_ID, {
            displayId: 'DP-2',
            quality: 'sharp',
        });
        expect(result.attach).toMatchObject({
            token: 'viewer-token',
            role: 'viewer',
            expiresInSec: 60,
        });
        expect(result.display?.id).toBe('DP-2');
        expect(result.fellBack).toBe(false);
        expect(mints[0]).toMatchObject({
            nodeId: NODE_ID,
            family: 'desktop',
            role: 'viewer',
            caller: { kind: 'user', userId: OWNER },
            params: {
                source: 'desktop',
                viewId: result.view.viewId,
                quality: 'sharp',
                display: 'DP-2',
            },
            requirement: { actionFamily: 'desktop', target: result.view.viewId },
        });
        expect(audits).toEqual([
            {
                action: 'node.desktop.view',
                extra: expect.objectContaining({
                    family: 'desktop',
                    target: result.view.viewId,
                    requestedBy: `user:${OWNER}`,
                    confirmationClass: 'plain',
                    outcome: 'opened',
                    displayId: 'DP-2',
                }),
            },
        ]);
    });

    it('falls back to the primary when the remembered display is gone (U14)', async () => {
        const { service } = build();
        const result = await service.openView(OWNER, NODE_ID, { displayId: 'HDMI-9' });
        expect(result).toMatchObject({ fellBack: true, display: { id: 'DP-1' } });
    });

    it('refuses with the CONTRACTS code and hint, and audits the refusal (U3, U8, U10)', async () => {
        const killed = build({ stopped: true });
        expect(await refusal(killed.service.openView(OWNER, NODE_ID, {}))).toMatchObject({
            code: 'kill_switch',
        });
        expect(killed.audits[0]).toMatchObject({
            action: 'node.desktop.view',
            extra: { outcome: 'refused', code: 'kill_switch' },
        });
        expect(killed.mints).toEqual([]);

        const changed = build({
            row: {
                desktopFacts: {
                    helper: null,
                    displays: [],
                    reasons: ['helper-untrusted'],
                    reportedAt: '',
                    seenEventIds: [],
                },
            },
        });
        expect(await refusal(changed.service.openView(OWNER, NODE_ID, {}))).toMatchObject({
            code: 'unsupported_on_node',
            details: { reason: 'helper-untrusted' },
        });

        const unattended = build({
            row: { consents: { work: true, attend: false, manage: false, usageScan: false } },
        });
        const consent = await refusal(unattended.service.openView(OWNER, NODE_ID, {}));
        expect(consent).toMatchObject({ code: 'consent_missing' });
        expect(consent.hint).toContain('--attend');
    });

    it('answers a stranger exactly like an unknown computer', async () => {
        const { service, audits } = build();
        await expect(service.openView(STRANGER, NODE_ID, {})).rejects.toThrow('not found');
        expect(audits).toEqual([]);
    });

    it('counts browser views and desktop views together against the per-computer cap (FR-33, U11)', async () => {
        const oneBrowser = build({ openSessions: 1 });
        await oneBrowser.service.openView(OWNER, NODE_ID, {});
        expect(await refusal(oneBrowser.service.openView(OWNER, NODE_ID, {}))).toMatchObject({
            code: 'limit_exceeded',
            details: { limit: 'views-per-computer', max: 2 },
        });
    });
});

describe('FleetDesktopService views', () => {
    it('audits a display change and answers a fresh grant', async () => {
        const { service, audits, mints } = build();
        const opened = await service.openView(OWNER, NODE_ID, {});
        const updated = await service.updateView(OWNER, NODE_ID, opened.view.viewId, {
            displayId: 'DP-2',
        });
        expect(updated.view.displayId).toBe('DP-2');
        expect(mints).toHaveLength(2);
        expect(audits.map((row) => row.action)).toEqual([
            'node.desktop.view',
            'node.desktop.display.set',
        ]);
        expect(audits[1].extra).toMatchObject({ displayId: 'DP-2', previousDisplayId: 'DP-1' });
        expect(
            await refusal(
                service.updateView(OWNER, NODE_ID, opened.view.viewId, { displayId: 'HDMI-9' }),
            ),
        ).toMatchObject({
            code: 'unsupported_on_node',
        });
    });

    it('keeps a view its owner’s alone', async () => {
        const { service } = build();
        const opened = await service.openView(OWNER, NODE_ID, {});
        expect(() => service.viewFor('someone-else', NODE_ID, opened.view.viewId)).toThrow(
            FleetLinkException,
        );
        expect(service.viewFor(OWNER, NODE_ID, opened.view.viewId).role).toBe('viewer');
        service.endView(OWNER, NODE_ID, opened.view.viewId);
        expect(() => service.viewFor(OWNER, NODE_ID, opened.view.viewId)).toThrow(
            FleetLinkException,
        );
    });
});

describe('FleetDesktopService as the viewer observer', () => {
    const handle = (target: string, userId: string, source: string) => ({
        id: 'h1',
        acceptedAt: Date.now(),
        claims: {
            userId,
            nodeId: NODE_ID,
            family: 'desktop' as const,
            target,
            role: 'viewer' as const,
            params: { source },
            requirement: {},
        },
    });

    it('lets the preview browser through untouched', async () => {
        const { service } = build();
        expect(() => service.admit(handle('anything', OWNER, 'browser'))).not.toThrow();
        expect(await service.stillAllowed(handle('anything', OWNER, 'browser'))).toBe(true);
    });

    it('admits only a view this person opened, and closes it when they leave the audience', async () => {
        const { service, access } = build();
        const opened = await service.openView(OWNER, NODE_ID, {});
        expect(() =>
            service.admit(handle('00000000-0000-4000-8000-000000000000', OWNER, 'desktop')),
        ).toThrow(FleetLinkException);
        expect(() => service.admit(handle(opened.view.viewId, 'someone-else', 'desktop'))).toThrow(
            FleetLinkException,
        );
        const viewer = handle(opened.view.viewId, OWNER, 'desktop');
        expect(() => service.admit(viewer)).not.toThrow();
        service.opened(viewer);
        expect(await service.stillAllowed(viewer)).toBe(true);
        access.canAct.mockImplementationOnce(async () => false);
        expect(await service.stillAllowed(viewer)).toBe(false);
        service.closed(viewer);
    });
});

describe('FleetDesktopService.screenshot', () => {
    it('takes one Steady picture on a short-lived channel and audits it', async () => {
        const { service, links, audits } = build();
        links.openChannel.mockImplementation(
            async (input: {
                params: Record<string, unknown>;
                events: { binary: (kind: number, payload: Uint8Array) => void };
            }) => {
                const frame = encodeComputerFrame({
                    kind: 'frame',
                    seq: 0,
                    keyframe: true,
                    width: 800,
                    height: 500,
                    mime: 'image/jpeg',
                    data: Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]).toString('base64'),
                })!;
                setTimeout(
                    () =>
                        input.events.binary(
                            FLEET_LINK_FRAME_KINDS.FRAME,
                            new TextEncoder().encode(frame),
                        ),
                    0,
                );
                expect(input.params).toMatchObject({ source: 'desktop', quality: 'steady' });
                return { close: jest.fn() };
            },
        );
        const picture = await service.screenshot(OWNER, NODE_ID, null);
        expect(picture).toMatchObject({ width: 800, height: 500, mime: 'image/jpeg', bytes: 6 });
        expect(audits[0]).toMatchObject({
            action: 'node.desktop.view',
            extra: { purpose: 'screenshot', outcome: 'done' },
        });
    });
});
