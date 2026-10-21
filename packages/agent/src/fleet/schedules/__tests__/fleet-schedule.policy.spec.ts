import {
    checkFleetScheduleCreate,
    checkFleetSchedulesPerNode,
    checkFleetScheduleUpdate,
    checkFleetScheduleWriteRate,
    fleetScheduleNeverRuns,
    fleetScheduleNodeRefusal,
    type FleetScheduleShape,
} from '../fleet-schedule.policy';

const NODE = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const OTHER = '00000000-0000-4000-8000-000000000001';

const blank = (): FleetScheduleShape => ({
    name: '',
    nodeId: '',
    command: '',
    cwd: null,
    cadence: { kind: 'daily', at: '00:00', timezone: 'node' },
});

const valid = {
    name: 'Nightly tests',
    nodeId: NODE,
    command: 'pnpm test',
    cwd: '~/code/api',
    cadence: { kind: 'weekdays', at: '02:00' },
};

describe('checkFleetScheduleCreate (FR-5, FR-6, FR-28)', () => {
    it('fills the shape from a valid request', () => {
        const out = blank();
        expect(checkFleetScheduleCreate(valid, out)).toBeNull();
        expect(out).toEqual({
            name: 'Nightly tests',
            nodeId: NODE,
            command: 'pnpm test',
            cwd: '~/code/api',
            cadence: { kind: 'weekdays', at: '02:00', timezone: 'node' },
        });
    });

    it('takes exactly one computer from nodeIds and reads ~ as home', () => {
        const out = blank();
        expect(checkFleetScheduleCreate({ ...valid, nodeId: undefined, nodeIds: [NODE], cwd: '~' }, out)).toBeNull();
        expect(out.nodeId).toBe(NODE);
        expect(out.cwd).toBeNull();
        expect(checkFleetScheduleCreate({ ...valid, nodeId: undefined, nodeIds: [NODE, OTHER] }, blank())?.code).toBe(
            'invalid',
        );
    });

    it.each([
        ['no name', { name: '  ' }, 'invalid'],
        ['a two-line name', { name: 'a\nb' }, 'invalid'],
        ['a 121-character name', { name: 'x'.repeat(121) }, 'limit_exceeded'],
        ['no command', { command: '' }, 'invalid'],
        ['a 9 KiB command', { command: 'x'.repeat(9 * 1024) }, 'limit_exceeded'],
        ['a bad computer id', { nodeId: 'build-01' }, 'invalid'],
        ['a folder with a line break', { cwd: 'a\nb' }, 'invalid'],
        ['no cadence', { cadence: undefined }, 'invalid'],
        ['a bad cadence', { cadence: { kind: 'interval', expr: 0 } }, 'invalid'],
    ])('refuses %s', (_label, patch, code) => {
        const refusal = checkFleetScheduleCreate({ ...valid, ...patch }, blank());
        expect(refusal?.code).toBe(code);
        expect(refusal?.hint).toEqual(expect.any(String));
    });
});

describe('checkFleetScheduleUpdate (FR-10)', () => {
    const stored = (): FleetScheduleShape => ({
        name: 'Nightly tests',
        nodeId: NODE,
        command: 'pnpm test',
        cwd: null,
        cadence: { kind: 'weekdays', at: '02:00', timezone: 'node' },
    });

    it('lists only the fields that change', () => {
        const out = stored();
        const changed: Array<keyof FleetScheduleShape> = [];
        expect(
            checkFleetScheduleUpdate(
                { name: 'Nightly tests', cadence: { kind: 'daily', at: '03:00' }, nodeId: OTHER },
                out,
                changed,
            ),
        ).toBeNull();
        expect(changed).toEqual(['nodeId', 'cadence']);
        expect(out.nodeId).toBe(OTHER);
    });

    it('never changes the kind', () => {
        expect(checkFleetScheduleUpdate({ prompt: 'triage' }, stored(), [])?.details).toEqual({ field: 'kind' });
    });
});

describe('limits and refusals', () => {
    it('refuses the 51st schedule on one computer (FR-5, ACC-FL13-17)', () => {
        expect(checkFleetSchedulesPerNode(49, 'build-01')).toBeNull();
        expect(checkFleetSchedulesPerNode(50, 'build-01')?.code).toBe('limit_exceeded');
    });

    it('refuses the 31st write in a minute (CONTRACTS §10.1)', () => {
        expect(checkFleetScheduleWriteRate(29)).toBeNull();
        expect(checkFleetScheduleWriteRate(30)?.code).toBe('limit_exceeded');
    });

    it('holds schedules only on command-line nodes', () => {
        expect(fleetScheduleNodeRefusal({ name: 'b', kind: 'node', status: 'offline' })).toBeNull();
        expect(fleetScheduleNodeRefusal({ name: 'b', kind: 'k8s', status: 'online' })?.code).toBe('unsupported_on_node');
        expect(fleetScheduleNodeRefusal({ name: 'b', kind: 'desktop-node', status: 'online' })?.code).toBe(
            'unsupported_on_node',
        );
    });
});

describe('fleetScheduleNeverRuns (FR-21)', () => {
    const consents = (manage: boolean) => ({ work: true, attend: false, manage, usageScan: false });

    it('names the first reason, with a hint', () => {
        expect(fleetScheduleNeverRuns({ nodeExists: false, nodeName: 'b', unsupported: false, consents: null })?.reason).toBe(
            'node-removed',
        );
        expect(
            fleetScheduleNeverRuns({ nodeExists: true, nodeName: 'build-01', unsupported: true, consents: consents(true) })
                ?.hint,
        ).toBe('NEVER RUNS · update the node on build-01');
        expect(
            fleetScheduleNeverRuns({ nodeExists: true, nodeName: 'build-01', unsupported: false, consents: consents(false) })
                ?.reason,
        ).toBe('consent-missing');
        expect(
            fleetScheduleNeverRuns({ nodeExists: true, nodeName: 'build-01', unsupported: false, consents: consents(true) }),
        ).toBeNull();
    });
});
