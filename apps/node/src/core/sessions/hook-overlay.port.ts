import type { FleetSessionKind, FleetSessionStartableProvider } from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04) — the per-session hook overlay seam that
 * FL-05 fills (README D4, CONTRACTS R-6).
 *
 * The status pipeline injects its hooks PER SESSION — a Claude Code
 * `--settings <overlay.json>`, a Codex `-c notify=[…]` override or a private
 * `CODEX_HOME` overlay for Agent sessions — and never into a person's own
 * global CLI configuration. FL-04's launchers ask this port for the overlay
 * of every agent session they compose and add exactly what it returns (spec
 * FR-12: "nothing but the per-session hook overlay and the terminal
 * environment variables"). FL-04 ships the no-op: no hooks, the CLI runs
 * exactly as the person configured it.
 */

export interface HookOverlay {
	/** Arguments placed before the first message (e.g. `--settings <path>`). */
	args: string[];
	/** Variables added to the session's environment. */
	env: Record<string, string>;
}

export interface HookOverlayPort {
	hookOverlayFor(
		kind: FleetSessionKind,
		provider: FleetSessionStartableProvider,
		sessionId: string
	): Promise<HookOverlay | null> | HookOverlay | null;
}

/** FL-04's default: no overlay. FL-05 replaces it with the real one. */
export const NO_HOOK_OVERLAY: HookOverlayPort = {
	hookOverlayFor: () => null
};
