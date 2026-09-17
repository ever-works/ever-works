/**
 * api-side SchedulesModule — module-shape pin.
 *
 * `SchedulesController` injects `ScheduleControlService` `@Optional()`, so
 * that a reduced graph answers 503 on the three control routes instead of
 * refusing to boot. The same posture makes a wiring break invisible: drop
 * `ScheduleControlsModule` from this module's imports and the API still
 * boots, every controller spec (which constructs the controller
 * positionally) still passes, `tsc` is clean — and run now / pause / resume
 * answer 503 for every user in production. This pin is what fails instead.
 *
 * The agent-side graph behind `ScheduleControlsModule` is compiled for real
 * in `packages/agent/src/schedules/__tests__/schedule-controls.module.spec.ts`;
 * here the barrel is stubbed (the posture of `agents/agents.module.spec.ts`)
 * so the decorator metadata can be asserted without dragging the entity
 * graph through Jest's CJS transformer.
 */

jest.mock('@ever-works/agent/schedules', () => ({
    SchedulesModule: class SchedulesModule {},
    ScheduleControlsModule: class ScheduleControlsModule {},
}));
jest.mock('./schedules.controller', () => ({
    SchedulesController: class SchedulesController {},
}));

import 'reflect-metadata';
import {
    ScheduleControlsModule,
    SchedulesModule as AgentSchedulesModule,
} from '@ever-works/agent/schedules';
import { SchedulesController } from './schedules.controller';
import { SchedulesModule } from './schedules.module';

const meta = (key: string): unknown[] => Reflect.getMetadata(key, SchedulesModule) ?? [];

describe('api-side SchedulesModule — wiring', () => {
    it('imports the read projection that GET /api/schedules and /page serve', () => {
        expect(meta('imports')).toContain(AgentSchedulesModule);
    });

    it('imports ScheduleControlsModule — without it every control route answers 503', () => {
        expect(meta('imports')).toContain(ScheduleControlsModule);
    });

    it('mounts SchedulesController', () => {
        expect(meta('controllers')).toEqual([SchedulesController]);
    });
});
