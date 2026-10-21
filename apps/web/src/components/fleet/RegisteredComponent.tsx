'use client';

import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';

/** One lazily-loaded component per registration id (React.lazy must be created once). */
const cache = new Map<string, ComponentType<object>>();

/** What renders in a failed component's place: a node, or one given a way to try again. */
type FailedFallback = ReactNode | ((retry: () => void) => ReactNode);

/** Keeps one failing registered component from taking the page down (spec §6 Reliability). */
class RegisteredBoundary extends Component<
    { fallback: FailedFallback; children: ReactNode },
    { failed: boolean }
> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    private retry = () => this.setState({ failed: false });

    render() {
        if (!this.state.failed) return this.props.children;
        const { fallback } = this.props;
        return typeof fallback === 'function' ? fallback(this.retry) : fallback;
    }
}

/**
 * React.lazy remembers a rejected import for good, so a chunk that failed to
 * load once (a deploy, a dropped connection) would stay failed until a full
 * reload. A failed load forgets its cache entry instead: the next render —
 * the boundary's retry, or the next visit — loads it again.
 */
function lazyOnce<P extends object>(
    id: string,
    load: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> {
    return lazy(() =>
        load().catch((error: unknown) => {
            cache.delete(id);
            throw error;
        }),
    ) as unknown as ComponentType<P>;
}

/**
 * Fleet hub (FL-01, README D9) — render a component another epic registered
 * (an Overview block, a computer action): code-split (its bundle loads only
 * when it renders), with `loading` shown while it loads and `failed` shown in
 * its place if it throws — never taking the surrounding page with it. `failed`
 * may be a function given `retry`, for a fallback that offers to try again.
 */
export function RegisteredComponent<P extends object>({
    id,
    load,
    props,
    loading,
    failed,
}: {
    id: string;
    load: () => Promise<{ default: ComponentType<P> }>;
    props: P;
    loading: ReactNode;
    failed: FailedFallback;
}) {
    let Loaded = cache.get(id) as ComponentType<P> | undefined;
    if (!Loaded) {
        Loaded = lazyOnce(id, load);
        cache.set(id, Loaded as ComponentType<object>);
    }
    return (
        <RegisteredBoundary fallback={failed}>
            <Suspense fallback={loading}>
                {/* Created once per registration id and cached at module level above,
                    never per render — so its state survives re-renders. */}
                {/* eslint-disable-next-line react-hooks/static-components */}
                <Loaded {...props} />
            </Suspense>
        </RegisteredBoundary>
    );
}
