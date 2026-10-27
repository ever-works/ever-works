import {
    FLEET_COMMAND_DEFAULT_TIMEOUT_SEC,
    FLEET_COMMAND_MAX_CONCURRENT_PER_OWNER,
    FLEET_COMMAND_MAX_LENGTH,
    FLEET_COMMAND_MAX_NODES,
    FLEET_COMMAND_MAX_TIMEOUT_SEC,
    FLEET_COMMAND_RUNS_PER_MINUTE,
} from '@ever-works/contracts';
import {
    checkFleetCommandAdmission,
    checkFleetCommandRequest,
    fleetCommandOsLabel,
    fleetCommandShellLabel,
    fleetCommandTargetRefusal,
    fleetCommandTargetSummary,
    type FleetCommandRequestShape,
    type FleetCommandTargetFacts,
} from '../fleet-command.policy';

/**
 * The FL-12 request, admission and target truth tables (spec FR-1, FR-3,
 * FR-8, FR-9, FR-14, U5, U8; CONTRACTS §8, §10). Each refusal is checked for
 * its code AND its hint — the hint is what the person reads.
 */

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';

const shape = (): FleetCommandRequestShape => ({
    command: '',
    nodeIds: [],
    cwd: null,
    timeoutSec: 0,
});

describe('checkFleetCommandRequest', () => {
    it('accepts a command on two computers with the defaults', () => {
        const out = shape();
        expect(
            checkFleetCommandRequest({ command: 'df -h', nodeIds: [NODE_A, NODE_B] }, out),
        ).toBeNull();
        expect(out).toEqual({
            command: 'df -h',
            nodeIds: [NODE_A, NODE_B],
            cwd: null,
            timeoutSec: FLEET_COMMAND_DEFAULT_TIMEOUT_SEC,
        });
    });

    it('drops duplicate computers and treats ~ as the home folder', () => {
        const out = shape();
        expect(
            checkFleetCommandRequest(
                { command: 'uptime', nodeIds: [NODE_A, NODE_A.toUpperCase()], cwd: '~' },
                out,
            ),
        ).toBeNull();
        expect(out.nodeIds).toEqual([NODE_A]);
        expect(out.cwd).toBeNull();
    });

    it('refuses a cadence (Schedules are FL-13)', () => {
        expect(
            checkFleetCommandRequest(
                { command: 'uptime', nodeIds: [NODE_A], cadence: { kind: 'daily' } },
                shape(),
            )?.details,
        ).toEqual({ field: 'cadence' });
    });

    it('refuses an empty command, an empty target list and a bad id as invalid', () => {
        expect(checkFleetCommandRequest({ command: '  ', nodeIds: [NODE_A] }, shape())?.code).toBe(
            'invalid',
        );
        expect(checkFleetCommandRequest({ command: 'ls', nodeIds: [] }, shape())?.code).toBe(
            'invalid',
        );
        expect(checkFleetCommandRequest({ command: 'ls', nodeIds: ['nope'] }, shape())?.code).toBe(
            'invalid',
        );
    });

    it('answers limit_exceeded naming the limit (U5)', () => {
        const long = 'x'.repeat(FLEET_COMMAND_MAX_LENGTH + 1);
        expect(
            checkFleetCommandRequest({ command: long, nodeIds: [NODE_A] }, shape()),
        ).toMatchObject({
            code: 'limit_exceeded',
            details: { limit: FLEET_COMMAND_MAX_LENGTH },
        });
        const many = Array.from(
            { length: FLEET_COMMAND_MAX_NODES + 1 },
            (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        );
        expect(checkFleetCommandRequest({ command: 'ls', nodeIds: many }, shape())).toMatchObject({
            code: 'limit_exceeded',
            details: { limit: FLEET_COMMAND_MAX_NODES },
        });
        expect(
            checkFleetCommandRequest(
                { command: 'ls', nodeIds: [NODE_A], timeoutSec: FLEET_COMMAND_MAX_TIMEOUT_SEC + 1 },
                shape(),
            ),
        ).toMatchObject({
            code: 'limit_exceeded',
            details: { limit: FLEET_COMMAND_MAX_TIMEOUT_SEC },
        });
    });

    it('takes the exact 8 KiB and 3 600 s bounds', () => {
        const out = shape();
        expect(
            checkFleetCommandRequest(
                {
                    command: 'x'.repeat(FLEET_COMMAND_MAX_LENGTH),
                    nodeIds: [NODE_A],
                    timeoutSec: FLEET_COMMAND_MAX_TIMEOUT_SEC,
                },
                out,
            ),
        ).toBeNull();
        expect(out.timeoutSec).toBe(FLEET_COMMAND_MAX_TIMEOUT_SEC);
    });
});

describe('checkFleetCommandAdmission', () => {
    it('refuses under the kill switch first', () => {
        expect(
            checkFleetCommandAdmission({ killSwitchOn: true, running: 99, lastMinute: 99 }),
        ).toMatchObject({
            code: 'kill_switch',
            hint: 'clear it under Settings → Fleet',
        });
    });

    it('refuses the ninth running Command and the eleventh in a minute', () => {
        expect(
            checkFleetCommandAdmission({
                killSwitchOn: false,
                running: FLEET_COMMAND_MAX_CONCURRENT_PER_OWNER,
                lastMinute: 0,
            })?.code,
        ).toBe('limit_exceeded');
        expect(
            checkFleetCommandAdmission({
                killSwitchOn: false,
                running: 0,
                lastMinute: FLEET_COMMAND_RUNS_PER_MINUTE,
            })?.code,
        ).toBe('limit_exceeded');
        expect(
            checkFleetCommandAdmission({ killSwitchOn: false, running: 7, lastMinute: 9 }),
        ).toBeNull();
    });
});

describe('fleetCommandTargetRefusal', () => {
    const facts = (overrides: Partial<FleetCommandTargetFacts> = {}): FleetCommandTargetFacts => ({
        node: { name: 'build-01', status: 'online', kind: 'node', platform: 'linux/x64' },
        consents: { work: true, attend: false, manage: true, usageScan: false },
        linkConnected: true,
        lastSeenAgo: '12 s',
        ...overrides,
    });

    it('allows an online managed computer with a link', () => {
        expect(fleetCommandTargetRefusal(facts())).toBeNull();
    });

    it('refuses without --manage with the exact hint (FR-9)', () => {
        expect(
            fleetCommandTargetRefusal(
                facts({ consents: { work: true, attend: true, manage: false, usageScan: false } }),
            ),
        ).toMatchObject({
            code: 'consent_missing',
            hint: 'start the node with --manage on build-01',
        });
    });

    it('refuses an offline computer with when it was last seen (FR-3)', () => {
        expect(
            fleetCommandTargetRefusal(facts({ linkConnected: false, lastSeenAgo: '2 h' })),
        ).toEqual({
            code: 'unreachable',
            hint: 'build-01 is offline — last seen 2 h ago',
        });
    });

    it('names a paused computer and refuses a cluster node', () => {
        expect(
            fleetCommandTargetRefusal(
                facts({
                    node: { name: 'build-01', status: 'paused', kind: 'node', platform: null },
                }),
            )?.code,
        ).toBe('busy');
        expect(
            fleetCommandTargetRefusal(
                facts({ node: { name: 'k', status: 'online', kind: 'k8s', platform: null } }),
            )?.code,
        ).toBe('unsupported_on_node');
    });

    it('checks consent before the link (a machine without --manage says so even offline)', () => {
        expect(
            fleetCommandTargetRefusal(
                facts({
                    linkConnected: false,
                    consents: { work: false, attend: false, manage: false, usageScan: false },
                }),
            )?.code,
        ).toBe('consent_missing');
    });
});

describe('summary lines', () => {
    it('names PowerShell on Windows and the login shell elsewhere, always as the machine owner', () => {
        expect(fleetCommandShellLabel('win32/x64')).toBe('PowerShell');
        expect(fleetCommandShellLabel('linux/arm64')).toBe('the login shell');
        expect(fleetCommandOsLabel('darwin/arm64')).toBe('macOS');
        expect(fleetCommandOsLabel(null)).toBeNull();
        expect(
            fleetCommandTargetSummary({
                nodeId: NODE_A,
                nodeName: 'build-01',
                platform: 'linux/x64',
                cwd: null,
                refusal: null,
            }),
        ).toEqual({
            nodeId: NODE_A,
            nodeName: 'build-01',
            os: 'Linux',
            shell: 'the login shell',
            user: 'machine-owner',
            folder: '~',
            runnable: true,
            error: null,
        });
    });
});
