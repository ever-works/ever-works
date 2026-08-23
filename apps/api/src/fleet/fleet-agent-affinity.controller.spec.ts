import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';
import { FleetAgentAffinityController } from './fleet-agent-affinity.controller';
import { SetFleetAgentAffinityDto } from './dto/fleet-agent-affinity.dto';

const USER = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const NODE = '44444444-4444-4444-8444-444444444444';
const auth = { userId: USER } as AuthenticatedUser;

describe('FleetAgentAffinityController', () => {
    let affinities: { getAffinity: jest.Mock; setAffinity: jest.Mock; clearAffinity: jest.Mock };
    let scope: { getOrganizationId: jest.Mock };
    let controller: FleetAgentAffinityController;

    beforeEach(() => {
        affinities = {
            getAffinity: jest.fn(async () => null),
            clearAffinity: jest.fn(async () => ({ cleared: true })),
            setAffinity: jest.fn(async (input) => ({
                id: '55555555-5555-4555-8555-555555555555',
                ...input,
                createdAt: new Date('2026-08-22T00:00:00.000Z'),
                updatedAt: new Date('2026-08-22T00:00:00.000Z'),
            })),
        };
        scope = { getOrganizationId: jest.fn(() => ORGANIZATION) };
        controller = new FleetAgentAffinityController(affinities as never, scope as never);
    });

    it('reads an Agent binding through the authenticated owner and active Organization', async () => {
        await controller.get(auth, AGENT);

        expect(affinities.getAffinity).toHaveBeenCalledWith({
            userId: USER,
            organizationId: ORGANIZATION,
            agentId: AGENT,
        });
    });

    it('sets the target node without accepting owner or Organization ids from the body', async () => {
        const result = await controller.set(auth, AGENT, {
            nodeId: NODE,
        } as SetFleetAgentAffinityDto);

        expect(affinities.setAffinity).toHaveBeenCalledWith({
            userId: USER,
            organizationId: ORGANIZATION,
            agentId: AGENT,
            nodeId: NODE,
        });
        expect(result).toMatchObject({ agentId: AGENT, nodeId: NODE });
    });

    it('passes personal scope through to the fail-closed service boundary', async () => {
        scope.getOrganizationId.mockReturnValue(null);

        await controller.set(auth, AGENT, { nodeId: NODE } as SetFleetAgentAffinityDto);

        expect(affinities.setAffinity).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: null }),
        );
    });

    it('clears the binding through the same owner and Organization scope', async () => {
        await controller.clear(auth, AGENT);

        expect(affinities.clearAffinity).toHaveBeenCalledWith({
            userId: USER,
            organizationId: ORGANIZATION,
            agentId: AGENT,
        });
    });

    it('returns null — not a fabricated row — for an owned but unbound Agent', async () => {
        await expect(controller.get(auth, AGENT)).resolves.toBeNull();
    });

    describe('the trust boundary this controller sits on', () => {
        it('is NOT a public route — owner isolation rests entirely on the session', () => {
            // enroll/heartbeat on FleetController are @Public(); nothing
            // here may ever be. If someone marks this controller (or one
            // handler) public, every binding becomes writable unauthenticated.
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, FleetAgentAffinityController)).toBeFalsy();
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller.get)).toBeFalsy();
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller.set)).toBeFalsy();
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller.clear)).toBeFalsy();
        });

        it('is behind the FLEET_ENABLED gate, like the other two fleet controllers', () => {
            const guards = (Reflect.getMetadata('__guards__', FleetAgentAffinityController) ??
                []) as unknown[];
            expect(guards).toContain(FleetEnabledGuard);
        });

        it('rejects a nodeId that is not a UUID before it can reach a uuid column', async () => {
            const ok = await validate(plainToInstance(SetFleetAgentAffinityDto, { nodeId: NODE }));
            expect(ok).toHaveLength(0);

            // Without @IsUUID this string reaches FleetNodeRepository.findById
            // and Postgres answers 22P02 — a 500 where a 400 belongs.
            const bad = await validate(
                plainToInstance(SetFleetAgentAffinityDto, { nodeId: 'not-a-uuid' }),
            );
            expect(bad.map((error) => error.property)).toContain('nodeId');
        });
    });
});
