import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '@ever-works/agent/config';

/**
 * APW-11 (App Launcher) — the single gate for the WHOLE launcher surface
 * (`EVER_WORKS_APP_LAUNCHER_ENABLED`).
 *
 * Applied at class level to both controllers in
 * `../app-launcher.controller.ts`, so the registry read, the arrangement save
 * and the public platform list go dark together. The launcher is switched off
 * **by default per installation** (FR-54, spec.md:375-378), which is also why
 * this guard is the one thing every launcher route shares.
 *
 * **404, not 403.** A disabled installation must not confirm that the surface
 * exists at all: `/api/me/apps` and `/api/app-launcher/platforms` have to look
 * exactly like routes that were never mounted. 403 would answer "yes, the App
 * Launcher is here, you just can't have it" — a free reconnaissance answer, and
 * the opposite of FR-65's "turning it off hides every surface" (ACC-11-28).
 * The same posture as {@link FleetEnabledGuard}
 * (`apps/api/src/fleet/guards/fleet-enabled.guard.ts:23-30`), whose shape this
 * class mirrors; only the default is inverted, because Fleet already ships and
 * the launcher does not.
 *
 * **Exactly `'true'` is on.** T31's manifest spec pins the deploy manifests to
 * the values `'true'`/`'false'` for precisely this reason
 * (`apps/api/src/app-launcher/__tests__/launcher-deploy-switches.spec.ts:154-164`):
 * `1`, `yes`, `TRUE` and an empty value all read as OFF here, and an operator
 * editing a manifest is told so by that spec rather than by a panel that never
 * appears. An unset value is off — FR-54's default.
 *
 * **One switch, two readers.** T9 also adds `config.appLauncher.isEnabled()` so
 * the guard and `api.controller.ts`'s `features.appLauncherEnabled` can never
 * disagree (APW11-G12, plan §7). That accessor lives in
 * `packages/agent/src/config/index.ts` and is owned by the same task's other
 * half; that accessor now exists (`packages/agent/src/config/index.ts`), and the
 * seam below calls it — so the two readers agree by construction rather than by
 * convention: `apps/api/src/config/constants.ts` delegates its own
 * `appLauncher.isEnabled()` to the same function instead of re-reading the
 * variable.
 */

/** The variable behind FR-54's switch. Named once, so nothing re-states it. */
export const APP_LAUNCHER_ENABLED_ENV = 'EVER_WORKS_APP_LAUNCHER_ENABLED';

/**
 * T9's agent-config accessor, as this guard consumes it.
 *
 * Optional on purpose: the accessor is added by the config half of T9
 * (`packages/agent/src/config/index.ts`), which this file does not own. Reading
 * it through a structural seam keeps the guard correct both before and after it
 * lands — the same posture `AppLauncherService` takes for the four ports other
 * epics bind (`packages/agent/src/app-launcher/app-launcher.service.ts:102-122`).
 */
interface AppLauncherConfigSeam {
    appLauncher?: { isEnabled?: () => boolean };
}

/**
 * Whether this installation runs the App Launcher (FR-54, FR-65).
 *
 * Exported so a caller that must agree with the guard — the public feature list
 * of `api.controller.ts`, a spec — asks the same function instead of re-reading
 * the variable.
 */
export function isAppLauncherEnabled(): boolean {
    const accessor = (config as AppLauncherConfigSeam | undefined)?.appLauncher;
    if (typeof accessor?.isEnabled === 'function') {
        return accessor.isEnabled() === true;
    }
    return process.env[APP_LAUNCHER_ENABLED_ENV] === 'true';
}

@Injectable()
export class AppLauncherEnabledGuard implements CanActivate {
    canActivate(): boolean {
        if (!isAppLauncherEnabled()) {
            throw new NotFoundException('Cannot find route');
        }
        return true;
    }
}
