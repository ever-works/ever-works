import { FLEET_NO_CONSENTS } from '@ever-works/contracts';
import { fleetPortTargetRefusal, resolveFleetPortOpenTargets } from '../fleet-ports.policy';

/**
 * Servers and ports (FL-10) — the Open menu's decision (spec U2, U4, U8, U10;
 * R-3): the desktop when it is available, else the preview browser, and the
 * exact reason when neither is.
 */
describe('resolveFleetPortOpenTargets', () => {
    const all = {
        consents: { ...FLEET_NO_CONSENTS, manage: true, attend: true },
        capabilities: ['managed', 'ports', 'ports-desktop', 'browser'],
        previewProfileEnabled: true,
        canPorts: true,
        canDesktop: true,
    };

    it('defaults to the desktop when the machine can open one (R-3)', () => {
        const decision = resolveFleetPortOpenTargets(all);
        expect(decision.defaultTarget).toBe('desktop');
        expect(decision.targets['preview-profile'].available).toBe(true);
    });

    it('falls back to the preview browser without a desktop', () => {
        const decision = resolveFleetPortOpenTargets({
            ...all,
            capabilities: ['ports', 'browser'],
        });
        expect(decision.targets.desktop).toEqual({ available: false, reason: 'no-desktop' });
        expect(decision.defaultTarget).toBe('preview-profile');
    });

    it('names --attend when live viewing is off (U2)', () => {
        const decision = resolveFleetPortOpenTargets({
            ...all,
            consents: { ...all.consents, attend: false },
        });
        expect(decision.targets.desktop).toMatchObject({
            reason: 'attend-missing',
            command: 'ever-works-node start --attend',
        });
        expect(decision.defaultTarget).toBeNull();
    });

    it('says the preview browser is switched off (U8)', () => {
        const decision = resolveFleetPortOpenTargets({
            ...all,
            previewProfileEnabled: false,
            capabilities: ['ports', 'browser'],
        });
        expect(decision.targets['preview-profile']).toEqual({
            available: false,
            reason: 'preview-off',
        });
    });

    it('offers nothing outside the ports audience; the desktop needs the desktop audience (U4)', () => {
        expect(resolveFleetPortOpenTargets({ ...all, canPorts: false }).defaultTarget).toBeNull();
        expect(
            resolveFleetPortOpenTargets({ ...all, canDesktop: false }).targets.desktop.reason,
        ).toBe('desktop-family');
    });

    it('maps each reason to its CONTRACTS §8 code', () => {
        expect(
            fleetPortTargetRefusal(
                'desktop',
                { available: false, reason: 'attend-missing' },
                'build-01',
            ).code,
        ).toBe('consent_missing');
        expect(
            fleetPortTargetRefusal(
                'preview-profile',
                { available: false, reason: 'no-browser' },
                'build-01',
            ),
        ).toMatchObject({
            code: 'unsupported_on_node',
            hint: 'No browser found on build-01 — install Chrome, Edge or Chromium there, or point the node at one',
        });
        expect(
            fleetPortTargetRefusal(
                'preview-profile',
                { available: false, reason: 'preview-off' },
                'build-01',
            ).hint,
        ).toBe('The preview browser is switched off for build-01 — turn it on under Settings');
    });
});
