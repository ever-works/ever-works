import { createHash } from 'crypto';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { FleetService } from '../fleet.service';

/**
 * Fleet node link (FL-02, spec FR-21, FR-22, CONTRACTS §1.1, §7) — the
 * consents a node reports on its heartbeat:
 *
 *   - stored on the row when they change, normalized (only a literal `true`
 *     grants), never blanked by a beat that carries none (an older daemon);
 *   - a CHANGE between two beats writes exactly one `node.consent.change`
 *     audit row with both sets; a daemon's first report and an unchanged
 *     beat write none;
 *   - the view carries them (null = never reported) and the preview-profile
 *     switch; the heartbeat result carries what this beat reported and the
 *     recommended daemon version.
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const USER = 'user-1';
const SECRET = 'a'.repeat(43);
const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const WORK_MANAGE = { work: true, attend: false, manage: true, usageScan: false };
const WORK_ONLY = { work: true, attend: false, manage: false, usageScan: false };

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE,
        userId: USER,
        organizationId: null,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        enrollmentTokenHash: sha256Hex(SECRET),
        lastHeartbeatAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: 'linux/x64',
        version: '0.3.0',
        previousCredentialHash: null,
        previousCredentialExpiresAt: null,
        rotationRequestedAt: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

const ORIGINAL_RECOMMENDED = process.env.FLEET_RECOMMENDED_NODE_VERSION;

afterEach(() => {
    if (ORIGINAL_RECOMMENDED === undefined) delete process.env.FLEET_RECOMMENDED_NODE_VERSION;
    else process.env.FLEET_RECOMMENDED_NODE_VERSION = ORIGINAL_RECOMMENDED;
});

describe('FleetService — consents on the heartbeat (FL-02)', () => {
    let repository: { findById: jest.Mock; update: jest.Mock };
    let audit: { recordNodeAction: jest.Mock };

    beforeEach(() => {
        repository = {
            findById: jest.fn(async () => node()),
            update: jest.fn(async () => undefined),
        };
        audit = { recordNodeAction: jest.fn(async () => true) };
    });

    const build = () =>
        new FleetService(repository as never, undefined, undefined, undefined, audit as never);
    const patchOf = () => repository.update.mock.calls[0][1] as Partial<FleetNode>;
    const consentAudits = () =>
        audit.recordNodeAction.mock.calls.filter(
            ([input]) => (input as { action: string }).action === 'node.consent.change',
        );

    it('stores a daemon’s first report without calling it a change', async () => {
        const result = await build().heartbeat(NODE, SECRET, { consents: WORK_MANAGE });
        expect(patchOf().consents).toEqual(WORK_MANAGE);
        expect(consentAudits()).toHaveLength(0);
        expect(result?.consents).toEqual(WORK_MANAGE);
        expect(result?.node.consents).toEqual(WORK_MANAGE);
    });

    it('writes nothing and audits nothing when the consents did not change', async () => {
        repository.findById.mockResolvedValue(node({ consents: WORK_MANAGE }));
        await build().heartbeat(NODE, SECRET, { consents: { ...WORK_MANAGE } });
        expect(patchOf()).not.toHaveProperty('consents');
        expect(consentAudits()).toHaveLength(0);
    });

    it('audits a withdrawn consent once, with both sets, and stores the new one (FR-22)', async () => {
        repository.findById.mockResolvedValue(node({ consents: WORK_MANAGE }));
        const result = await build().heartbeat(NODE, SECRET, { consents: WORK_ONLY });
        expect(patchOf().consents).toEqual(WORK_ONLY);
        expect(consentAudits()).toHaveLength(1);
        expect(consentAudits()[0][0]).toMatchObject({
            action: 'node.consent.change',
            actorUserId: null,
            ownerUserId: USER,
            nodeId: NODE,
            before: WORK_MANAGE,
            after: WORK_ONLY,
        });
        expect(result?.consents).toEqual(WORK_ONLY);
    });

    it('never blanks the stored set on a beat that carries none (an older daemon)', async () => {
        repository.findById.mockResolvedValue(node({ consents: WORK_MANAGE }));
        const result = await build().heartbeat(NODE, SECRET, { version: '0.2.5' });
        expect(patchOf()).not.toHaveProperty('consents');
        expect(result?.consents).toBeNull();
        expect(result?.node.consents).toEqual(WORK_MANAGE);
    });

    it('grants only literal true, whatever else arrives', async () => {
        await build().heartbeat(NODE, SECRET, {
            consents: { work: 'true', attend: 1, manage: true, usageScan: null, admin: true },
        });
        expect(patchOf().consents).toEqual({
            work: false,
            attend: false,
            manage: true,
            usageScan: false,
        });
        await build().heartbeat(NODE, SECRET, { consents: 'all' });
        expect(repository.update.mock.calls[1][1]).not.toHaveProperty('consents');
    });

    it('shows a never-reported node as null consents and the preview switch off', async () => {
        const result = await build().heartbeat(NODE, SECRET, {});
        expect(result?.node.consents).toBeNull();
        expect(result?.node.previewProfileEnabled).toBe(false);
    });

    it('carries the recommended daemon version when the operator names one', async () => {
        delete process.env.FLEET_RECOMMENDED_NODE_VERSION;
        expect((await build().heartbeat(NODE, SECRET, {}))?.recommendedNodeVersion).toBeNull();
        process.env.FLEET_RECOMMENDED_NODE_VERSION = '0.4.0';
        expect((await build().heartbeat(NODE, SECRET, {}))?.recommendedNodeVersion).toBe('0.4.0');
        process.env.FLEET_RECOMMENDED_NODE_VERSION = 'latest please';
        expect((await build().heartbeat(NODE, SECRET, {}))?.recommendedNodeVersion).toBeNull();
    });
});
