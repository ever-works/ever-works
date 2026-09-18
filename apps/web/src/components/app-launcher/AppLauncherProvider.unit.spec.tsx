import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';

import { AppLauncherProvider, useAppLauncher } from './AppLauncherProvider';

/**
 * APW-11 T14 — the launcher's opener, as the command palette sees it (plan §6.4,
 * §7).
 *
 * The context exists for exactly one handoff: the header control owns the
 * `<ever-app-launcher>` element, and the palette command may only call it
 * through this provider. So the claims below are about the **handoff** — an
 * opener is `undefined` until the control registers one, it is the one that was
 * registered, it is gone the moment the control unmounts, and its identity does
 * not churn under a parent re-render (the palette memoises its command list on
 * this value, so a new function on every render would rebuild it on every
 * keystroke).
 */

/** Reads the context and exposes it to the spec — the palette's own call site. */
let seen: ReturnType<typeof useAppLauncher> | null = null;

function PaletteProbe() {
    seen = useAppLauncher();
    return null;
}

/** Registers the way the control does: from an effect, cleared on unmount. */
function RegisterProbe({ open }: { open: (() => void) | null }) {
    const { registerOpenAppLauncher } = useAppLauncher();
    useEffect(() => {
        registerOpenAppLauncher(open);
        return () => registerOpenAppLauncher(null);
    }, [registerOpenAppLauncher, open]);
    return null;
}

describe('AppLauncherProvider', () => {
    it('answers with no opener and a callable registrar outside the dashboard shell, and never throws', () => {
        expect(() => render(<PaletteProbe />)).not.toThrow();
        expect(seen).not.toBeNull();
        expect(seen?.openAppLauncher).toBeUndefined();
        // A control rendered without the provider must not be able to break the
        // header from its own registration effect.
        expect(() => seen?.registerOpenAppLauncher(() => undefined)).not.toThrow();
        expect(() => seen?.registerOpenAppLauncher(null)).not.toThrow();
    });

    it('exposes the registered opener, and only that one', () => {
        const open = vi.fn();
        render(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={open} />
            </AppLauncherProvider>,
        );

        expect(seen?.openAppLauncher).toBeTypeOf('function');
        act(() => seen?.openAppLauncher?.());
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('takes the opener away again when the control unregisters it', () => {
        const open = vi.fn();
        const { rerender } = render(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={open} />
            </AppLauncherProvider>,
        );
        expect(seen?.openAppLauncher).toBeTypeOf('function');

        // The control unmounting is what clears the registration, so the palette
        // can never call into an element that is gone.
        rerender(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={null} />
            </AppLauncherProvider>,
        );
        expect(seen?.openAppLauncher).toBeUndefined();
    });

    it('keeps both members stable while the opener is unchanged', () => {
        const open = vi.fn();
        const { rerender } = render(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={open} />
            </AppLauncherProvider>,
        );
        const first = seen;

        rerender(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={open} />
            </AppLauncherProvider>,
        );

        expect(seen?.openAppLauncher).toBe(first?.openAppLauncher);
        expect(seen?.registerOpenAppLauncher).toBe(first?.registerOpenAppLauncher);
    });

    it('renders its children', () => {
        render(
            <AppLauncherProvider>
                <p>inside the launcher shell</p>
            </AppLauncherProvider>,
        );
        expect(screen.getByText('inside the launcher shell')).toBeInTheDocument();
    });
});
