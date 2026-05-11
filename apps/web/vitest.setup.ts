import '@testing-library/jest-dom/vitest';

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
                dispatchEvent: () => false
            })
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
        disconnect: () => undefined
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
