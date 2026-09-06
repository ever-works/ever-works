/**
 * Panic controls (EW-778) — the GLOBAL STOP FLAG port for the run
 * dispatch gate.
 *
 * Token + contract only (leaf file, zero imports — same circular-dep
 * dodge as `run-credits-precheck.ts`, see
 * `docs/architecture/agent-injection-tokens.md`).
 * `RunDispatchGateService` consumes it via `@Optional() @Inject(...)`;
 * the implementation (`FleetKillSwitchService`, agent-side FleetModule)
 * is bound to the token by the api-side `@Global()` AgentsModule.
 *
 * Unbound (unit tests, installs without the fleet stack) the gate's
 * kill-switch middleware simply passes every run through.
 *
 * Unlike the credits precheck this port is FAIL-CLOSED at the consumer:
 * the middleware parks the run when `shouldHaltDispatch()` resolves true
 * AND when it throws. Implementations should still never throw — the
 * fleet service folds every read failure into `true` itself — but the
 * gate does not depend on that.
 */
export interface RunKillSwitch {
    /**
     * True ⇒ the global stop flag is set (or cannot be read) ⇒ the gate
     * parks the run (`queuedReason='kill-switch'`) instead of
     * dispatching it.
     */
    shouldHaltDispatch(): Promise<boolean>;
}

export const RUN_KILL_SWITCH = 'RUN_KILL_SWITCH' as const;

/**
 * `Error.name` carried by the api-side `FleetKillSwitchActiveError` (the
 * class lives in `apps/api`, which this package cannot import). The gate
 * recognises a dispatcher that refused on the stop flag by this name and
 * RE-PARKS the run instead of failing it — a stop parks work, never fails
 * it. Pinned on both sides by spec.
 */
export const KILL_SWITCH_ACTIVE_ERROR_NAME = 'FleetKillSwitchActiveError' as const;
