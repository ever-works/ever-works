import { describe, expect, it } from 'vitest';
import { createEnTranslator } from '../__tests__/en-translator';
import { fleetActionsJobsScreens, fleetRunnersScreens } from './screens';

/** Actions runners on computers (FL-18, spec §5.7, T-17) — "Install Actions runners on <computer>" in the palette. */
describe('fleetRunnersScreens', () => {
    const computers = [
        { id: 'n1', name: 'build-01', capabilities: ['services', 'actions-runner'] },
        { id: 'n2', name: 'laptop', capabilities: ['services'] },
        { id: 'n3', name: 'new-box' },
    ];

    it('offers nothing while FLEET_ACTIONS_RUNNERS_ENABLED is off', () => {
        expect(fleetRunnersScreens(computers, false)).toEqual([]);
    });

    it('offers one row per computer that advertises actions-runner, opening its Install dialog', () => {
        const t = createEnTranslator();
        const screens = fleetRunnersScreens(computers, true);
        expect(screens.map((screen) => screen.id)).toEqual(['fleet.runners.n1.install']);
        expect(screens[0].href).toBe('/fleet/computers/n1?runners=install');
        expect(screens[0].title(t)).toBe('Install Actions runners on build-01');
        expect(screens[0].breadcrumb?.(t).length).toBeGreaterThan(0);
    });
});

/** Actions jobs (FL-18 P2, spec §5.7) — "Actions jobs" in the palette. */
describe('fleetActionsJobsScreens', () => {
    it('offers nothing while FLEET_ACTIONS_RUNNERS_ENABLED is off', () => {
        expect(fleetActionsJobsScreens(false)).toEqual([]);
    });

    it('opens the hub’s Overview at the Actions jobs panel', () => {
        const t = createEnTranslator();
        const [screen, ...rest] = fleetActionsJobsScreens(true);
        expect(rest).toEqual([]);
        expect(screen.id).toBe('fleet.runners.jobs');
        expect(screen.href).toBe('/fleet#fleet-actions-jobs');
        expect(screen.title(t)).toBe('Actions jobs');
    });
});
