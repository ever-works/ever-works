import {
    FLEET_BROWSER_CAPABILITY,
    FLEET_CONSENT_FLAGS,
    FLEET_PORTS_DESKTOP_OPEN_CAPABILITY,
    type FleetConsents,
    type FleetPortOpenTarget,
    type FleetPortOpenTargetState,
} from '@ever-works/contracts';

/**
 * Servers and ports (FL-10) — the pure decision behind the Open menu
 * (spec §5.1, U2, U4, U8, U10; CONTRACTS R-3).
 *
 *  - **Open on the desktop** needs the `ports` audience, the `--attend`
 *    consent, the `desktop` audience (it drives the desktop — U4) and a
 *    machine that can open a browser on its desktop (`ports-desktop` tag).
 *  - **Open in the preview browser** needs the `ports` audience, the
 *    owner's switch (`previewProfileEnabled`), a browser on the machine
 *    (`browser` tag) and `--attend`: its picture rides the link's `desktop`
 *    family, whose CONTRACTS §3.3 consent is `attend` (lane-log decision 7).
 *  - The default target is the desktop when it is available, else the
 *    preview browser (R-3).
 *
 * Both the list response (what the tab shows disabled, and why) and the open
 * route (what it refuses, and with which code) read this one function.
 */

export interface FleetPortOpenFacts {
    consents: FleetConsents;
    capabilities: readonly string[];
    previewProfileEnabled: boolean;
    canPorts: boolean;
    canDesktop: boolean;
}

export interface FleetPortOpenDecision {
    targets: Record<FleetPortOpenTarget, FleetPortOpenTargetState>;
    defaultTarget: FleetPortOpenTarget | null;
}

const ATTEND_COMMAND = `ever-works-node start ${FLEET_CONSENT_FLAGS.attend}`;

export function resolveFleetPortOpenTargets(facts: FleetPortOpenFacts): FleetPortOpenDecision {
    const desktop: FleetPortOpenTargetState = !facts.canPorts
        ? { available: false, reason: 'ports-family' }
        : !facts.consents.attend
          ? { available: false, reason: 'attend-missing', command: ATTEND_COMMAND }
          : !facts.canDesktop
            ? { available: false, reason: 'desktop-family' }
            : !facts.capabilities.includes(FLEET_PORTS_DESKTOP_OPEN_CAPABILITY)
              ? { available: false, reason: 'no-desktop' }
              : { available: true };
    const preview: FleetPortOpenTargetState = !facts.canPorts
        ? { available: false, reason: 'ports-family' }
        : !facts.previewProfileEnabled
          ? { available: false, reason: 'preview-off' }
          : !facts.capabilities.includes(FLEET_BROWSER_CAPABILITY)
            ? { available: false, reason: 'no-browser' }
            : !facts.consents.attend
              ? { available: false, reason: 'attend-missing', command: ATTEND_COMMAND }
              : { available: true };
    const defaultTarget: FleetPortOpenTarget | null = desktop.available
        ? 'desktop'
        : preview.available
          ? 'preview-profile'
          : null;
    return { targets: { desktop, 'preview-profile': preview }, defaultTarget };
}

/** The CONTRACTS §8 refusal for an unavailable target, as the open route answers it. */
export function fleetPortTargetRefusal(
    target: FleetPortOpenTarget,
    state: FleetPortOpenTargetState,
    nodeName: string,
): {
    code: 'consent_missing' | 'permission_denied' | 'unsupported_on_node';
    hint: string;
    details: Record<string, unknown>;
} {
    const details = { target, reason: state.reason ?? null };
    switch (state.reason) {
        case 'attend-missing':
            return {
                code: 'consent_missing',
                hint: `start the node with ${FLEET_CONSENT_FLAGS.attend} on ${nodeName}`,
                details: { ...details, consent: 'attend' },
            };
        case 'desktop-family':
            return {
                code: 'permission_denied',
                hint: `Only the owner of ${nodeName} can open its servers on the desktop`,
                details: { ...details, actionFamily: 'desktop' },
            };
        case 'ports-family':
            return {
                code: 'permission_denied',
                hint: `Only the owner of ${nodeName} can open its servers`,
                details: { ...details, actionFamily: 'ports' },
            };
        case 'preview-off':
            return {
                code: 'permission_denied',
                hint: `The preview browser is switched off for ${nodeName} — turn it on under Settings`,
                details: { ...details, setting: 'previewProfileEnabled' },
            };
        case 'no-browser':
            return {
                code: 'unsupported_on_node',
                hint: `No browser found on ${nodeName} — install Chrome, Edge or Chromium there, or point the node at one`,
                details,
            };
        case 'no-desktop':
        default:
            return {
                code: 'unsupported_on_node',
                hint: `${nodeName} has no desktop to open a browser on — open it in the preview browser instead`,
                details,
            };
    }
}
