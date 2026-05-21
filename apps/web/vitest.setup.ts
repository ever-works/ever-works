import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

// Register jest-dom matchers (toBeInTheDocument, toBeDisabled, toHaveAttribute, …)
// against vitest's `expect`. The `@testing-library/jest-dom/vitest` side-effect
// import is the documented shortcut, but in this workspace its module-level
// `expect.extend(...)` call doesn't reliably attach the matchers — likely a
// dual-package / ESM resolution mismatch between the `vitest` instance the
// jest-dom entry sees and the one our tests pull in. Doing it explicitly is
// equivalent and works.
expect.extend(matchers);

// jsdom doesn't ship `matchMedia`, `IntersectionObserver`, or `ResizeObserver`,
// but several components (lucide icons, animations, tooltips) call them on mount.
// Stub them lazily so individual tests can override when needed.
if (typeof window !== 'undefined') {
    if (!('matchMedia' in window)) {
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: (query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: () => undefined,
                removeListener: () => undefined,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
                dispatchEvent: () => false,
            }),
        });
    }

    type MinimalObserver = {
        observe: () => void;
        unobserve: () => void;
        disconnect: () => void;
    };
    const mkObserver = (): MinimalObserver => ({
        observe: () => undefined,
        unobserve: () => undefined,
        disconnect: () => undefined,
    });

    if (!('IntersectionObserver' in window)) {
        // @ts-expect-error - minimal mock for jsdom
        window.IntersectionObserver = function () {
            return mkObserver();
        };
    }
    if (!('ResizeObserver' in window)) {
        // @ts-expect-error - minimal mock for jsdom
        window.ResizeObserver = function () {
            return mkObserver();
        };
    }
}
