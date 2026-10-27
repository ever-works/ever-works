import { ComputerControlChangedEvent } from '@ever-works/agent/computer';
import { FleetLinkException } from '../../fleet-link/fleet-link.errors';
import { FleetDesktopService } from './fleet-desktop.service';

/**
 * Desktop view & control (FL-07 P2, T-32, FR-33, FR-36 … FR-42) — a view is a
 * `computer_sessions` row; control goes through AW-11's arbiter: refused
 * before it when the machine says control is impossible, a take needs
 * `confirm`, a won take answers a `driver` grant, a driver socket is admitted
 * only while its view holds control, and every refusal carries its code.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-1';

process.env.FLEET_DESKTOP_ENABLED = 'true';
process.env.FLEET_NODE_LINK_ENABLED = 'true';

function node(helper: Record<string, unknown> = { control: 'allowed', inputReasons: [] }) {
    return {
        id: NODE_ID,
        userId: OWNER,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
        organizationId: null,
        consents: { work: false, attend: true, manage: false, usageScan: false },
        capabilities: ['attended', 'helper:screen', 'screen:desktop', 'input'],
        workerState: null,
        helperTrust: 'hash-pinned',
        desktopFacts: {
            helper: {
                trust: 'hash-pinned',
                present: true,
                admitted: true,
                fingerprintPrefix: 'abcdef12',
                ...helper,
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
            ],
            reasons: [],
            reportedAt: new Date().toISOString(),
            seenEventIds: [],
        },
    };
}

type Row = Record<string, unknown> & { id: string; status: string };

function build(
    options: {
        helper?: Record<string, unknown>;
        held?: boolean;
        refused?: string;
        /** P2.C: a recording service double, and the owner's opt-in for watching views. */
        recording?: Record<string, jest.Mock>;
        recordWatchSessions?: boolean;
    } = {},
) {
    const row = node(options.helper);
    const rows = new Map<string, Row>();
    const audits: Array<{ action: string; extra: Record<string, unknown> }> = [];
    const mints: Array<Record<string, unknown>> = [];
    let held = options.held ?? false;
    const closed: Array<(viewer: never) => boolean> = [];
    const state = (sessionId: string) => ({
        nodeId: NODE_ID,
        sessionId,
        policy: 'owner',
        canControl: true,
        mode: held ? 'controlling' : 'watching',
        holder: held
            ? {
                  userId: OWNER,
                  sessionId,
                  since: new Date().toISOString(),
                  expiresAt: null,
                  idleAt: null,
                  extended: false,
                  you: true,
                  thisView: true,
              }
            : null,
        request: null,
        lastRelease: null,
        serverTime: new Date().toISOString(),
    });
    const outcome = (sessionId: string) =>
        options.refused
            ? { refused: options.refused, state: state(sessionId) }
            : { state: state(sessionId) };
    const control = {
        getState: jest.fn(async (actor: { sessionId: string }) => state(actor.sessionId)),
        take: jest.fn(async (actor: { sessionId: string; source?: string }) => {
            if (!options.refused) held = true;
            return outcome(actor.sessionId);
        }),
        request: jest.fn(async (actor: { sessionId: string }) => outcome(actor.sessionId)),
        giveBack: jest.fn(async (actor: { sessionId: string }) => {
            held = false;
            return { state: state(actor.sessionId) };
        }),
        answer: jest.fn(async (actor: { sessionId: string }) => {
            held = false;
            return { state: state(actor.sessionId) };
        }),
        keep: jest.fn(async (actor: { sessionId: string }) => ({ state: state(actor.sessionId) })),
        extend: jest.fn(async (actor: { sessionId: string }) => ({
            state: state(actor.sessionId),
        })),
        holdOf: jest.fn(async () => ({ held, untilMs: null })),
        acknowledge: jest.fn(async () => undefined),
        recordInput: jest.fn(async () => ({ held, untilMs: null })),
        releaseForSession: jest.fn(async () => true),
    };
    const sessions = {
        create: jest.fn(async (data: Record<string, unknown>) => {
            const created = {
                ...data,
                id: `00000000-0000-4000-8000-00000000000${rows.size + 1}`,
                createdAt: new Date(),
            } as unknown as Row;
            rows.set(created.id, created);
            return created;
        }),
        findById: jest.fn(async (id: string) => rows.get(id) ?? null),
        findDesktopViewFor: jest.fn(async (id: string, userId: string) => {
            const found = rows.get(id);
            return found && found.openedByUserId === userId && found.source === 'desktop'
                ? found
                : null;
        }),
        findOpenForNode: jest.fn(async () =>
            [...rows.values()].filter((entry) => entry.status !== 'ended'),
        ),
        findOpenForScope: jest.fn(async () =>
            [...rows.values()].filter((entry) => entry.status !== 'ended'),
        ),
        updateOpen: jest.fn(async (id: string, patch: Record<string, unknown>) => {
            const found = rows.get(id);
            if (found) Object.assign(found, patch);
            return Boolean(found);
        }),
        close: jest.fn(async (id: string) => {
            const found = rows.get(id);
            if (!found || found.status === 'ended') return false;
            found.status = 'ended';
            return true;
        }),
        recordFrames: jest.fn(async () => ({ becameLive: false })),
        markDesktopDriver: jest.fn(async (id: string, at: Date) => {
            const found = rows.get(id);
            if (found) found.controlDriverAt = at;
        }),
    };
    const gateway = {
        registerObserver: jest.fn(),
        closeViewers: jest.fn((match: (viewer: never) => boolean) => {
            closed.push(match);
            return 1;
        }),
    };
    const service = new FleetDesktopService(
        { findById: jest.fn(async () => row) } as never,
        {
            resolveVisible: jest.fn(async () => ({ node: row, role: 'owner' })),
            canAct: jest.fn(async () => true),
        } as never,
        { isStopped: jest.fn(async () => false) } as never,
        {
            recordNodeAction: jest.fn(
                async (input: { action: string; extra: Record<string, unknown> }) => {
                    audits.push({ action: input.action, extra: input.extra });
                    return true;
                },
            ),
        } as never,
        {
            isConnected: jest.fn(() => true),
            liveConsents: jest.fn(() => null),
            openChannel: jest.fn(),
        } as never,
        {
            mint: jest.fn(async (input: Record<string, unknown>) => {
                mints.push(input);
                return {
                    token: `${input.role}-token`,
                    wsPath: `/ws/fleet/desktop/${input.target}`,
                    expiresInSec: 60,
                    role: input.role,
                };
            }),
        } as never,
        sessions as never,
        gateway as never,
        control as never,
        options.recording as never,
    );
    return {
        service,
        rows,
        audits,
        mints,
        control,
        sessions,
        gateway,
        closed,
        setHeld: (next: boolean) => (held = next),
    };
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

const handle = (
    target: string,
    role: 'viewer' | 'driver',
    params: Record<string, unknown> = { source: 'desktop' },
) => ({
    id: `h-${role}`,
    acceptedAt: Date.now(),
    claims: {
        userId: OWNER,
        nodeId: NODE_ID,
        family: 'desktop' as const,
        target,
        role,
        params,
        requirement: {},
    },
});

describe('desktop views as computer_sessions rows (FR-33)', () => {
    it('writes a live Desktop row with no Agent, opened by the viewer, owned by the computer’s owner', async () => {
        const { service, rows } = build();
        const opened = await service.openView(OWNER, NODE_ID, { quality: 'sharp' }, 'Ada');
        const row = rows.get(opened.view.viewId)!;
        expect(row).toMatchObject({
            source: 'desktop',
            agentId: null,
            userId: OWNER,
            openedByUserId: OWNER,
            nodeId: NODE_ID,
            status: 'live',
            quality: 'sharp',
            displayId: 'DP-1',
        });
        expect(opened.attach.role).toBe('viewer');
    });

    it('counts the rows of every replica against the per-computer cap', async () => {
        const { service } = build();
        await service.openView(OWNER, NODE_ID, {});
        await service.openView(OWNER, NODE_ID, {});
        expect(await refusal(service.openView(OWNER, NODE_ID, {}))).toMatchObject({
            code: 'limit_exceeded',
            details: { limit: 'views-per-computer' },
        });
    });

    it('finds a view another replica opened, and ends its row, its control and its sockets', async () => {
        const first = build();
        const opened = await first.service.openView(OWNER, NODE_ID, {});
        // A second replica: same rows, nothing in memory.
        const second = build();
        for (const [id, value] of first.rows) second.rows.set(id, value);
        expect((await second.service.view(OWNER, NODE_ID, opened.view.viewId)).viewId).toBe(
            opened.view.viewId,
        );
        expect(
            await refusal(second.service.view('someone-else', NODE_ID, opened.view.viewId)),
        ).toMatchObject({ code: 'not_found' });
        await second.service.endView(OWNER, NODE_ID, opened.view.viewId);
        expect(second.rows.get(opened.view.viewId)?.status).toBe('ended');
        expect(second.control.releaseForSession).toHaveBeenCalledWith(
            opened.view.viewId,
            'session-ended',
        );
        expect(second.gateway.closeViewers).toHaveBeenCalled();
    });

    it('stamps the row from the node’s stats so the view never reads as stalled', async () => {
        const { service, sessions } = build();
        const opened = await service.openView(OWNER, NODE_ID, {});
        const viewer = handle(opened.view.viewId, 'viewer');
        await service.admit(viewer);
        service.opened(viewer);
        (service as unknown as { now: () => number }).now = () => Date.now() + 20_000;
        service.nodeMessage(viewer, { type: 'desktop.stats', fps: 4, bytesOut: 4096 });
        expect(sessions.recordFrames).toHaveBeenCalledWith(
            opened.view.viewId,
            4,
            4096,
            expect.any(Date),
        );
    });
});

describe('taking control of a desktop view', () => {
    it('is refused before the arbiter when the owner has not allowed control on the machine', async () => {
        const { service, control, audits } = build({ helper: { control: 'not-allowed' } });
        const opened = await service.openView(OWNER, NODE_ID, {});
        const answer = await refusal(
            service.takeControl(OWNER, NODE_ID, opened.view.viewId, { confirm: true }),
        );
        expect(answer).toMatchObject({
            code: 'unsupported_on_node',
            details: { reason: 'control-not-allowed' },
        });
        expect(answer.hint).toContain('ever-works-node helper control allow');
        expect(control.take).not.toHaveBeenCalled();
        expect(audits[audits.length - 1]).toMatchObject({
            action: 'node.desktop.control.take',
            extra: {
                outcome: 'refused',
                reason: 'control-not-allowed',
                confirmationClass: 'confirm',
            },
        });
    });

    it('never offers control on a node that says nothing about it (an older node)', async () => {
        const { service } = build({ helper: {} });
        const opened = await service.openView(OWNER, NODE_ID, {});
        expect(
            await refusal(
                service.takeControl(OWNER, NODE_ID, opened.view.viewId, { confirm: true }),
            ),
        ).toMatchObject({
            details: { reason: 'control-not-allowed' },
        });
    });

    it('needs confirm (CONTRACTS §2.2), then answers a driver grant naming the controller', async () => {
        const { service, control, mints } = build();
        const opened = await service.openView(OWNER, NODE_ID, {});
        expect(
            await refusal(service.takeControl(OWNER, NODE_ID, opened.view.viewId, {})),
        ).toMatchObject({
            code: 'confirmation_required',
            details: { class: 'confirm' },
        });
        expect(control.take).not.toHaveBeenCalled();
        const taken = await service.takeControl(
            OWNER,
            NODE_ID,
            opened.view.viewId,
            { confirm: true },
            'Ada Lovelace',
        );
        expect(control.take).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: opened.view.viewId,
                userId: OWNER,
                source: 'desktop',
            }),
        );
        expect(taken.state.mode).toBe('controlling');
        expect(taken.attach?.role).toBe('driver');
        expect(mints[mints.length - 1]).toMatchObject({
            role: 'driver',
            params: { source: 'desktop', mode: 'controlling', controlledBy: 'Ada Lovelace' },
        });
    });

    it('maps the arbiter’s refusals to CONTRACTS codes, the state in details', async () => {
        const held = build({ refused: 'held' });
        const opened = await held.service.openView(OWNER, NODE_ID, {});
        expect(
            await refusal(
                held.service.takeControl(OWNER, NODE_ID, opened.view.viewId, { confirm: true }),
            ),
        ).toMatchObject({
            code: 'busy',
            details: { reason: 'held' },
        });
        const policy = build({ refused: 'policy' });
        const second = await policy.service.openView(OWNER, NODE_ID, {});
        expect(
            await refusal(
                policy.service.takeControl(OWNER, NODE_ID, second.view.viewId, { confirm: true }),
            ),
        ).toMatchObject({
            code: 'permission_denied',
        });
    });

    it('asks for control only after a confirmation too (a hand-over gives it)', async () => {
        const { service, control } = build();
        const opened = await service.openView(OWNER, NODE_ID, {});
        expect(
            await refusal(
                service.takeControl(OWNER, NODE_ID, opened.view.viewId, { request: true }),
            ),
        ).toMatchObject({ code: 'confirmation_required' });
        expect(control.request).not.toHaveBeenCalled();
        const asked = await service.takeControl(OWNER, NODE_ID, opened.view.viewId, {
            request: true,
            confirm: true,
        });
        expect(control.request).toHaveBeenCalled();
        expect(asked.attach).toBeNull();
    });

    it('gives control back: closes the driver sockets here and answers a viewer grant', async () => {
        const { service, gateway, mints } = build({ held: true });
        const opened = await service.openView(OWNER, NODE_ID, {});
        const back = await service.giveBackControl(OWNER, NODE_ID, opened.view.viewId);
        expect(back.attach?.role).toBe('viewer');
        expect(mints[mints.length - 1]).toMatchObject({ role: 'viewer' });
        expect(mints[mints.length - 1].params).not.toHaveProperty('mode');
        expect(gateway.closeViewers).toHaveBeenCalled();
    });

    it('re-attaches a view that holds control as a driver, and one that does not as a viewer', async () => {
        const { service, setHeld } = build();
        const opened = await service.openView(OWNER, NODE_ID, {});
        expect((await service.attachToken(OWNER, NODE_ID, opened.view.viewId)).role).toBe('viewer');
        setHeld(true);
        expect((await service.attachToken(OWNER, NODE_ID, opened.view.viewId)).role).toBe('driver');
    });
});

describe('driver sockets', () => {
    it('are admitted only with a controlling grant while the view holds control', async () => {
        const { service, setHeld } = build();
        const opened = await service.openView(OWNER, NODE_ID, {});
        const driver = handle(opened.view.viewId, 'driver', {
            source: 'desktop',
            mode: 'controlling',
        });
        await expect(service.admit(driver)).rejects.toBeInstanceOf(FleetLinkException);
        setHeld(true);
        await expect(service.admit(driver)).resolves.toBeUndefined();
        await expect(service.admit(handle(opened.view.viewId, 'driver'))).rejects.toBeInstanceOf(
            FleetLinkException,
        );
    });

    it('acknowledge the hold on every ping, and lose it when control ends', async () => {
        const { service, control, setHeld } = build({ held: true });
        const opened = await service.openView(OWNER, NODE_ID, {});
        const driver = handle(opened.view.viewId, 'driver', {
            source: 'desktop',
            mode: 'controlling',
        });
        await service.admit(driver);
        service.opened(driver);
        expect(await service.stillAllowed(driver)).toBe(true);
        expect(control.acknowledge).toHaveBeenCalledWith(opened.view.viewId);
        setHeld(false);
        expect(await service.stillAllowed(driver)).toBe(false);
    });

    it('push the idle deadline with input, at most every few seconds', async () => {
        const { service, control } = build({ held: true });
        const opened = await service.openView(OWNER, NODE_ID, {});
        const driver = handle(opened.view.viewId, 'driver', {
            source: 'desktop',
            mode: 'controlling',
        });
        await service.admit(driver);
        service.opened(driver);
        // A view control (refresh, quality: JSON 10) never counts as input.
        service.inbound(driver, 40, 10);
        expect(control.recordInput).not.toHaveBeenCalled();
        service.inbound(driver, 40, 21);
        service.inbound(driver, 40, 21);
        expect(control.recordInput).toHaveBeenCalledTimes(1);
    });

    it('close at once when input shows the hold ended on another replica', async () => {
        const { service, gateway, setHeld } = build({ held: true });
        const opened = await service.openView(OWNER, NODE_ID, {});
        const driver = handle(opened.view.viewId, 'driver', {
            source: 'desktop',
            mode: 'controlling',
        });
        await service.admit(driver);
        service.opened(driver);
        await Promise.resolve();
        gateway.closeViewers.mockClear();
        setHeld(false);
        service.inbound(driver, 40, 21);
        await new Promise((resolve) => setImmediate(resolve));
        expect(gateway.closeViewers).toHaveBeenCalled();
    });

    it('fail closed when the hold cannot be read, and give the hold back when access is lost', async () => {
        const { service, control } = build({ held: true });
        const opened = await service.openView(OWNER, NODE_ID, {});
        const driver = handle(opened.view.viewId, 'driver', {
            source: 'desktop',
            mode: 'controlling',
        });
        await service.admit(driver);
        service.opened(driver);
        control.holdOf.mockImplementationOnce(async () => {
            throw new Error('database away');
        });
        expect(await service.stillAllowed(driver)).toBe(false);
        const access = (service as unknown as { access: { canAct: jest.Mock } }).access;
        access.canAct.mockImplementationOnce(async () => false);
        expect(await service.stillAllowed(driver)).toBe(false);
        expect(control.releaseForSession).toHaveBeenCalledWith(opened.view.viewId, 'revoked');
    });

    it('close at once on this replica when the hold ends', async () => {
        const { service, gateway } = build({ held: true });
        const opened = await service.openView(OWNER, NODE_ID, {});
        service.onControlChanged(
            new ComputerControlChangedEvent({
                nodeId: NODE_ID,
                sessionId: opened.view.viewId,
                ownerUserId: OWNER,
                agentId: '',
                actorUserId: null,
                held: false,
                untilMs: null,
                reason: 'idle',
                heldMs: 1_000,
            }),
        );
        expect(gateway.closeViewers).toHaveBeenCalledTimes(1);
    });

    it('give control back after the grace when the controller’s socket does not come back', async () => {
        jest.useFakeTimers();
        try {
            const { service, control } = build({ held: true });
            const opened = await service.openView(OWNER, NODE_ID, {});
            const driver = handle(opened.view.viewId, 'driver', {
                source: 'desktop',
                mode: 'controlling',
            });
            await service.admit(driver);
            service.opened(driver);
            service.closed(driver);
            await jest.advanceTimersByTimeAsync(30_000);
            expect(control.releaseForSession).toHaveBeenCalledWith(
                opened.view.viewId,
                'disconnected',
            );
        } finally {
            jest.useRealTimers();
        }
    });

    it('keep control when a driver came back on another replica within the grace', async () => {
        jest.useFakeTimers();
        try {
            const { service, control, rows } = build({ held: true });
            const opened = await service.openView(OWNER, NODE_ID, {});
            const driver = handle(opened.view.viewId, 'driver', {
                source: 'desktop',
                mode: 'controlling',
            });
            await service.admit(driver);
            service.opened(driver);
            service.closed(driver);
            // Another replica's driver attached a moment later.
            rows.get(opened.view.viewId)!.controlDriverAt = new Date(Date.now() + 1_000);
            await jest.advanceTimersByTimeAsync(30_000);
            expect(control.releaseForSession).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it('give back the hold of a person who lost the right, before refusing their keep', async () => {
        const { service, control } = build({ held: true });
        const opened = await service.openView(OWNER, NODE_ID, {});
        const killSwitch = (service as unknown as { killSwitch: { isStopped: jest.Mock } })
            .killSwitch;
        killSwitch.isStopped.mockImplementation(async () => true);
        expect(
            await refusal(service.keepControl(OWNER, NODE_ID, opened.view.viewId)),
        ).toMatchObject({
            code: 'kill_switch',
        });
        expect(control.releaseForSession).toHaveBeenCalledWith(opened.view.viewId, 'revoked');
        expect(control.keep).not.toHaveBeenCalled();
    });
});

describe('availability', () => {
    it('says whether control is possible, and names the blocked shortcuts', async () => {
        const { service } = build({
            helper: { control: 'allowed', inputReasons: ['permission-accessibility'] },
        });
        const view = await service.availability(OWNER, NODE_ID);
        expect(view.control).toMatchObject({
            available: false,
            reasons: ['permission-accessibility'],
        });
        expect(view.control?.blockedShortcuts).toContain('Alt+F4');
    });
});

describe('recordings (P2.C, FR-48 … FR-55)', () => {
    function recordingDouble() {
        const live = new Set<string>();
        return {
            live,
            start: jest.fn(async (input: { viewId: string }) => {
                live.add(input.viewId);
                return true;
            }),
            stop: jest.fn(async (viewId: string) => {
                live.delete(viewId);
            }),
            push: jest.fn(),
            isRecording: jest.fn((viewId: string) => live.has(viewId)),
            failureOf: jest.fn(() => null),
            list: jest.fn(async () => []),
            read: jest.fn(async (viewId: string) => ({
                viewId,
                startedAt: '2026-10-27T09:00:00.000Z',
            })),
            chunk: jest.fn(async () => new Uint8Array([0x45, 0x57, 0x52, 0x31])),
            remove: jest.fn(async () => true),
        };
    }

    it('records a view from the moment it takes control (FR-48), and taps only its pictures', async () => {
        const recording = recordingDouble();
        const { service } = build({ recording: recording as never });
        const opened = await service.openView(OWNER, NODE_ID, {});
        await service.takeControl(OWNER, NODE_ID, opened.view.viewId, { confirm: true });
        expect(recording.start).toHaveBeenCalledWith(
            expect.objectContaining({ viewId: opened.view.viewId, trigger: 'control' }),
        );
        const driver = handle(opened.view.viewId, 'driver', {
            source: 'desktop',
            mode: 'controlling',
        });
        service.nodeBinary(driver, 20, new Uint8Array([1]));
        service.nodeBinary(driver, 10, new Uint8Array([1]));
        expect(recording.push).toHaveBeenCalledTimes(1);
        expect(service.viewFor(OWNER, NODE_ID, opened.view.viewId).recording).toEqual({
            state: 'recording',
            reason: null,
        });
    });

    it('never records a watching view unless the owner opted in', async () => {
        const recording = recordingDouble();
        const { service } = build({ recording: recording as never });
        const opened = await service.openView(OWNER, NODE_ID, {});
        const viewer = handle(opened.view.viewId, 'viewer');
        await service.admit(viewer);
        service.opened(viewer);
        await new Promise((resolve) => setImmediate(resolve));
        expect(recording.start).not.toHaveBeenCalled();
        expect(service.viewFor(OWNER, NODE_ID, opened.view.viewId).recording?.state).toBe('off');
    });

    it('stops a control recording when control ends, and every recording with its view', async () => {
        const recording = recordingDouble();
        const { service } = build({ recording: recording as never, held: true });
        const opened = await service.openView(OWNER, NODE_ID, {});
        await service.takeControl(OWNER, NODE_ID, opened.view.viewId, { confirm: true });
        service.onControlChanged(
            new ComputerControlChangedEvent({
                nodeId: NODE_ID,
                sessionId: opened.view.viewId,
                ownerUserId: OWNER,
                agentId: '',
                actorUserId: OWNER,
                held: false,
                untilMs: null,
                reason: 'given-back',
                heldMs: 1_000,
            }),
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(recording.stop).toHaveBeenCalledWith(opened.view.viewId, 'control-ended');
        await service.takeControl(OWNER, NODE_ID, opened.view.viewId, { confirm: true });
        await service.endView(OWNER, NODE_ID, opened.view.viewId);
        expect(recording.stop).toHaveBeenLastCalledWith(opened.view.viewId, 'view-ended');
    });

    it('deletes a recording only with confirm, for people in the desktop audience', async () => {
        const recording = recordingDouble();
        const { service } = build({ recording: recording as never });
        const viewId = '00000000-0000-4000-8000-0000000000aa';
        expect(await refusal(service.deleteRecording(OWNER, NODE_ID, viewId, false))).toMatchObject(
            {
                code: 'confirmation_required',
                details: { class: 'confirm' },
            },
        );
        expect(recording.remove).not.toHaveBeenCalled();
        await service.deleteRecording(OWNER, NODE_ID, viewId, true);
        expect(recording.remove).toHaveBeenCalledWith(viewId, OWNER);
        const access = (service as unknown as { access: { canAct: jest.Mock } }).access;
        access.canAct.mockImplementationOnce(async () => false);
        expect(await refusal(service.recordings(OWNER, NODE_ID))).toMatchObject({
            code: 'permission_denied',
        });
    });
});
