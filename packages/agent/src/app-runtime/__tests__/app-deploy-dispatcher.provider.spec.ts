import {
    appClusterDispatchAttested,
    appDeployDispatcherGate,
} from '../app-deploy-dispatcher.provider';

/**
 * APW-06 §9.2 — the isolation gate in front of the `app-deploy` dispatcher.
 *
 * This is the one file on the deploy path where being wrong means cluster
 * access from a process that should not have it, so every branch of the two
 * exported functions is pinned here — without a Nest container, because both
 * are deliberately plain functions for exactly that reason.
 *
 * The rule being tested, in one sentence: **a request may only pass the gate
 * when a job runtime is registered AND (outside production, or the operator has
 * attested the worker).** Every other combination must read as "no isolated
 * worker", which the request service turns into `422 worker_not_isolated` with
 * no row created and nothing read.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_FLAG = process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED;

function setEnv(nodeEnv: string | undefined, isolated: string | undefined): void {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    if (isolated === undefined) delete process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED;
    else process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED = isolated;
}

afterEach(() => {
    setEnv(ORIGINAL_NODE_ENV, ORIGINAL_FLAG);
});

describe('appClusterDispatchAttested (plan §6.2:950-952)', () => {
    it('is true outside production — a developer’s worker is their own machine', () => {
        setEnv('test', undefined);
        expect(appClusterDispatchAttested()).toBe(true);

        setEnv('development', undefined);
        expect(appClusterDispatchAttested()).toBe(true);
    });

    it('is FALSE in production without the operator’s attestation', () => {
        // The default, and the one that matters: an operator who has done
        // nothing gets the safe answer, not the convenient one.
        setEnv('production', undefined);
        expect(appClusterDispatchAttested()).toBe(false);
    });

    it('is false in production for anything but a literal `true`', () => {
        setEnv('production', 'false');
        expect(appClusterDispatchAttested()).toBe(false);

        setEnv('production', '1');
        expect(appClusterDispatchAttested()).toBe(false);

        setEnv('production', 'yes');
        expect(appClusterDispatchAttested()).toBe(false);
    });

    it('is true in production once the worker is attested', () => {
        setEnv('production', 'true');
        expect(appClusterDispatchAttested()).toBe(true);
    });
});

describe('appDeployDispatcherGate', () => {
    const runtime = { dispatchers: { dispatchAppDeploy: async () => 'run_1' } };

    it('resolves the active runtime’s dispatchers view', () => {
        const gate = appDeployDispatcherGate({
            getActive: () => runtime as never,
        });

        expect(gate.resolve()).toBe(runtime.dispatchers);
    });

    it('resolves null when no runtime is registered — no in-process fallback (FR-5)', () => {
        // The request service reads this as "no isolated worker" and refuses.
        // Running App cluster work in the API is the thing FR-5 exists to stop.
        const gate = appDeployDispatcherGate({ getActive: () => null });

        expect(gate.resolve()).toBeNull();
    });

    it('resolves null when there is no registry at all', () => {
        expect(appDeployDispatcherGate(undefined).resolve()).toBeNull();
        expect(appDeployDispatcherGate(null).resolve()).toBeNull();
    });

    it('resolves null when the registry THROWS, rather than propagating', () => {
        // A registry that cannot tell us whether there is a worker is answering
        // the same thing as a registry with none — and a throw here would
        // surface as a 500 on a route whose whole contract is named refusals.
        const gate = appDeployDispatcherGate({
            getActive: () => {
                throw new Error('registry exploded');
            },
        });

        expect(gate.resolve()).toBeNull();
    });

    it('reports isEnabled from the attestation, not from the registry', () => {
        // The two halves are independent on purpose: a registered runtime in an
        // unattested production process must still be refused.
        setEnv('production', undefined);
        const gate = appDeployDispatcherGate({ getActive: () => runtime as never });

        expect(gate.resolve()).toBe(runtime.dispatchers);
        expect(gate.isEnabled()).toBe(false);
    });

    it('is enabled AND resolvable when both halves hold', () => {
        setEnv('production', 'true');
        const gate = appDeployDispatcherGate({ getActive: () => runtime as never });

        expect(gate.isEnabled()).toBe(true);
        expect(typeof (gate.resolve() as { dispatchAppDeploy?: unknown })?.dispatchAppDeploy).toBe(
            'function',
        );
    });

    it('answers the attestation at CALL time, not at construction', () => {
        // The gate is built once per process and both services share the one
        // instance; an attestation captured at construction would go stale and,
        // worse, could differ between the preconditions pass and the request.
        setEnv('production', undefined);
        const gate = appDeployDispatcherGate({ getActive: () => runtime as never });
        expect(gate.isEnabled()).toBe(false);

        setEnv('production', 'true');
        expect(gate.isEnabled()).toBe(true);
    });
});
