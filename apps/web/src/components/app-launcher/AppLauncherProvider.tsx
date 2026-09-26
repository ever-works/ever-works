'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * APW-11 T14 — the App Launcher's opener, shared by the header control and the
 * command palette (plan §6.4, §7).
 *
 * The element lives where the header renders it (`AppLauncherButton`), and the
 * palette's **Open App Launcher** command may only reach it through this
 * context: the palette is rendered by the dashboard shell, not by the header, so
 * without a registration the command would either be missing or call into an
 * element nobody mounted.
 *
 * **Two members, deliberately.** `openAppLauncher` is `undefined` until a
 * control registers one — that is exactly what `PaletteCommandContext` gates the
 * command on (`available: (ctx) => ctx.openAppLauncher !== undefined`), so a
 * dashboard without the launcher shows no command rather than a dead one.
 *
 * **Who decides `source`.** The command's context type is `() => void`
 * (`command-palette/registry/types.ts`, owned by T15), so the opener cannot take
 * an argument. The palette's only way in is therefore the function registered
 * here, which is what makes "registered opener ⇒ palette" true by construction:
 * the control tags its own registration as `source: 'palette'` and its element's
 * own trigger stays `'header'`. A third context key carrying the source would
 * have made that explicit, but the interface between T14 and T15 is frozen to
 * these two members, so the tag lives at the registration instead.
 */

export interface AppLauncherContextValue {
    /**
     * Open the App Launcher panel, or `undefined` when no control is mounted
     * (the launcher is off, or the header has not mounted yet).
     */
    openAppLauncher: (() => void) | undefined;
    /**
     * Publish the control's opener, or clear it with `null` on unmount. The
     * value is what the palette command will call.
     */
    registerOpenAppLauncher: (open: (() => void) | null) => void;
}

/**
 * Outside the dashboard shell the launcher is simply absent: `openAppLauncher`
 * is `undefined` and the registrar is a no-op, so a control rendered without a
 * provider cannot break its own mounting effect.
 */
const AppLauncherContext = createContext<AppLauncherContextValue>({
    openAppLauncher: undefined,
    registerOpenAppLauncher: () => undefined,
});

export function AppLauncherProvider({ children }: { children: ReactNode }) {
    const [registered, setRegistered] = useState<(() => void) | undefined>(undefined);

    const registerOpenAppLauncher = useCallback((open: (() => void) | null) => {
        // The updater form is required, not stylistic: `setRegistered(open)`
        // would be read by React as an updater and CALLED during the next
        // render instead of stored.
        setRegistered(() => (open === null ? undefined : open));
    }, []);

    const value = useMemo<AppLauncherContextValue>(
        () => ({ openAppLauncher: registered, registerOpenAppLauncher }),
        [registered, registerOpenAppLauncher],
    );

    return <AppLauncherContext.Provider value={value}>{children}</AppLauncherContext.Provider>;
}

/** The launcher's opener, for the palette; both members are always present. */
export function useAppLauncher(): AppLauncherContextValue {
    return useContext(AppLauncherContext);
}
