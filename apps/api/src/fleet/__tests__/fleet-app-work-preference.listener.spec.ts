import { WorkCreatedEvent } from '@ever-works/agent/events';
import type { FleetExecutionPreferenceService, FleetNodeRepository } from '@ever-works/agent/fleet';
import {
    APP_WORK_DEFAULT_EXECUTION_MODE,
    FleetAppWorkPreferenceListener,
} from '../fleet-app-work-preference.listener';

/**
 * App Works follow-up (b), 2026-10-21 — a new App Work defaults its execution preference to the
 * owner's fleet. Prod T-45: the Cal App Work had no preference row, resolved to `local-fallback`,
 * and its run was relocated to a cloud stand-in that could publish nothing.
 *
 * The properties: only App Works, only when the owner has a usable node, never over an explicit
 * Work row or an explicit account-wide `cloud`, written through the audited `setForUser`, and a
 * failure never escapes into the create.
 */

const WORK_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = 'owner-1';

function event(kind: string, over: Record<string, unknown> = {}): WorkCreatedEvent {
    return new WorkCreatedEvent({
        id: WORK_ID,
        userId: OWNER_ID,
        kind,
        organizationId: 'org-1',
        ...over,
    } as never);
}

function build(
    options: {
        rows?: Array<{ scopeType: string; scopeId: string | null; mode: string }>;
        nodes?: Array<{ status: string }>;
        setForUser?: jest.Mock;
    } = {},
) {
    const preferences = {
        listForUser: jest.fn(async () => options.rows ?? []),
        setForUser: options.setForUser ?? jest.fn(async () => ({})),
    };
    const nodes = { findByUser: jest.fn(async () => options.nodes ?? [{ status: 'online' }]) };
    const listener = new FleetAppWorkPreferenceListener(
        preferences as unknown as FleetExecutionPreferenceService,
        nodes as unknown as FleetNodeRepository,
    );
    return { listener, preferences, nodes };
}

describe('FleetAppWorkPreferenceListener — a new App Work defaults to the owner fleet', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.APP_WORKS_CLOUD_PUSH_ENABLED;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('writes a Work-scope local-wait row through the audited setForUser', async () => {
        const { listener, preferences } = build();

        const outcome = await listener.defaultFor(event('app'));

        expect(outcome).toBe('written');
        expect(preferences.setForUser).toHaveBeenCalledWith(OWNER_ID, {
            scopeType: 'work',
            scopeId: WORK_ID,
            mode: APP_WORK_DEFAULT_EXECUTION_MODE,
            organizationId: 'org-1',
        });
        expect(APP_WORK_DEFAULT_EXECUTION_MODE).toBe('local-wait');
    });

    it('leaves every other Work kind on the plain inheritance chain', async () => {
        const { listener, preferences, nodes } = build();

        expect(await listener.defaultFor(event('repo'))).toBe('not-app-work');
        expect(preferences.listForUser).not.toHaveBeenCalled();
        expect(nodes.findByUser).not.toHaveBeenCalled();
        expect(preferences.setForUser).not.toHaveBeenCalled();
    });

    it('never overwrites an explicit Work-scope row', async () => {
        const { listener, preferences } = build({
            rows: [{ scopeType: 'work', scopeId: WORK_ID, mode: 'local-fallback' }],
        });

        expect(await listener.defaultFor(event('app'))).toBe('work-row-exists');
        expect(preferences.setForUser).not.toHaveBeenCalled();
    });

    it("honours the owner's explicit account-wide cloud choice", async () => {
        const { listener, preferences } = build({
            rows: [{ scopeType: 'user', scopeId: null, mode: 'cloud' }],
        });

        expect(await listener.defaultFor(event('app'))).toBe('owner-chose-cloud');
        expect(preferences.setForUser).not.toHaveBeenCalled();
    });

    it('writes nothing when the owner has no usable node', async () => {
        const { listener, preferences } = build({
            nodes: [{ status: 'enrolling' }, { status: 'disabled' }],
        });

        expect(await listener.defaultFor(event('app'))).toBe('no-fleet');
        expect(preferences.setForUser).not.toHaveBeenCalled();
    });

    it('counts an offline or paused node as a fleet (it takes work once it is back)', async () => {
        const { listener } = build({ nodes: [{ status: 'offline' }, { status: 'paused' }] });

        expect(await listener.defaultFor(event('app'))).toBe('written');
    });

    it('swallows a failed write — a routing default must never fail the create', async () => {
        const { listener } = build({
            setForUser: jest.fn(async () => {
                throw new Error('db down');
            }),
        });

        await expect(listener.onWorkCreated(event('app'))).resolves.toBeUndefined();
        expect(await listener.defaultFor(event('app'))).toBe('failed');
    });
});
