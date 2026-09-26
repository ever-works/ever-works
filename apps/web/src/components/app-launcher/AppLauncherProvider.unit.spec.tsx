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

/**
 * Reads the context and exposes it to the spec — the palette's own call site.
 *
 * The capture lives on an **object** rather than in a module-level `let`, because the
 * React Compiler ESLint rule refuses a reassignment of an outer variable from inside a
 * component ("Cannot reassign variables declared outside of the component/hook" — the
 * error this file produced in CI). Writing a property is the same capture without a
 * binding write, so the spec still asserts on the exact value the component saw and no
 * assertion changes.
 */
const captured: { seen: ReturnType<typeof useAppLauncher> | null } = { seen: null };

function PaletteProbe() {
    // 🛑 Scoped suppression, and the reason is the rule's own domain: `react-hooks/immutability`
    // protects values the compiler may memoize inside COMPONENT code. This probe renders only in
    // this unit spec and exists to hand the context value to the assertions below — there is no
    // memoization to protect and no component behaviour to change. The alternative (asserting
    // through the DOM) cannot express these three claims: that the value is `null`-safe outside
    // the shell, that it is the ONE registered opener, and that its identity survives a rerender.
    // eslint-disable-next-line react-hooks/immutability -- unit-spec probe: captures the context for assertions
    captured.seen = useAppLauncher();
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
        expect(captured.seen).not.toBeNull();
        expect(captured.seen?.openAppLauncher).toBeUndefined();
        // A control rendered without the provider must not be able to break the
        // header from its own registration effect.
        expect(() => captured.seen?.registerOpenAppLauncher(() => undefined)).not.toThrow();
        expect(() => captured.seen?.registerOpenAppLauncher(null)).not.toThrow();
    });

    it('exposes the registered opener, and only that one', () => {
        const open = vi.fn();
        render(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={open} />
            </AppLauncherProvider>,
        );

        expect(captured.seen?.openAppLauncher).toBeTypeOf('function');
        act(() => captured.seen?.openAppLauncher?.());
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
        expect(captured.seen?.openAppLauncher).toBeTypeOf('function');

        // The control unmounting is what clears the registration, so the palette
        // can never call into an element that is gone.
        rerender(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={null} />
            </AppLauncherProvider>,
        );
        expect(captured.seen?.openAppLauncher).toBeUndefined();
    });

    it('keeps both members stable while the opener is unchanged', () => {
        const open = vi.fn();
        const { rerender } = render(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={open} />
            </AppLauncherProvider>,
        );
        const first = captured.seen;

        rerender(
            <AppLauncherProvider>
                <PaletteProbe />
                <RegisterProbe open={open} />
            </AppLauncherProvider>,
        );

        expect(captured.seen?.openAppLauncher).toBe(first?.openAppLauncher);
        expect(captured.seen?.registerOpenAppLauncher).toBe(first?.registerOpenAppLauncher);
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
