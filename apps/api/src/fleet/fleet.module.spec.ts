import { FleetApiModule } from './fleet.module';
import { FleetController } from './fleet.controller';
import { FleetJobsController } from './fleet-jobs.controller';
import { FleetAgentAffinityController } from './fleet-agent-affinity.controller';

/**
 * The API-side Fleet module's CONTROLLER list, pinned.
 *
 * The agent-side `FleetModule` spec covers providers/exports, but nothing
 * asserted that this module still mounts its controllers — and a route
 * that quietly stops being registered is invisible to every unit test
 * that calls the controller class directly. PR #2170 rebases this very
 * file, so the list is worth holding still.
 */
describe('api FleetApiModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, FleetApiModule) ?? [];

    it('mounts all three controllers — two trust boundaries, none of them optional', () => {
        expect(meta('controllers')).toEqual([
            FleetController,
            FleetJobsController,
            FleetAgentAffinityController,
        ]);
    });
});
