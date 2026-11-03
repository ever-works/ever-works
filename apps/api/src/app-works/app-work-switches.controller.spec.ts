import { AppWorkSwitchesController } from './app-work-switches.controller';

/**
 * APW-08 T49 (FR-74, R-30, S34) — the switches the web reads to show the read-only banner. The
 * same `readAppWorkSwitches` the dispatchers read: unset is on, an unrecognised value is off.
 */
describe('AppWorkSwitchesController (APW-08 T49)', () => {
    const KEYS = ['EVER_WORKS_APP_CHANGES_ENABLED', 'EVER_WORKS_APP_AUTO_DEPLOY_ENABLED'] as const;
    const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
    const user = { userId: 'user-1' } as never;

    beforeEach(() => {
        for (const key of KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('both switches unset read as on', () => {
        expect(new AppWorkSwitchesController().getSwitches(user)).toEqual({
            changesEnabled: true,
            autoDeployEnabled: true,
        });
    });

    it('answers exactly what the dispatchers read: off, and an unrecognised value fails closed', () => {
        process.env.EVER_WORKS_APP_CHANGES_ENABLED = 'false';
        process.env.EVER_WORKS_APP_AUTO_DEPLOY_ENABLED = 'maybe';
        expect(new AppWorkSwitchesController().getSwitches(user)).toEqual({
            changesEnabled: false,
            autoDeployEnabled: false,
        });
    });

    it('answers the two booleans and nothing else', () => {
        expect(Object.keys(new AppWorkSwitchesController().getSwitches(user)).sort()).toEqual([
            'autoDeployEnabled',
            'changesEnabled',
        ]);
    });
});
