import { buildVerdict, type SafetyRailMiddleware } from '../safety-rails';

/**
 * Rail 2 — the OWNER's own stop.
 *
 * Independent of the platform flag above it in both directions (FR-51): the
 * operator's flag does not pause a workspace, and resuming a workspace does
 * not clear the operator's flag.
 *
 * The state has already been read (and already folded fail-closed) by the
 * time a rail runs — `WorkspacePauseService.state()` never throws and answers
 * `{ paused: true, unverified: true }` for every read it could not complete.
 * This rail therefore reads a value rather than performing IO, which is what
 * keeps the whole gate inside its p95 budget.
 *
 * A pause refuses a START. It never cancels work already running: an
 * executing run stops cleanly at its next tool boundary, and killing it is a
 * second, separately confirmed action (FR-43, FR-45). P3 wires the remaining
 * start points; this rail is the one that covers the tool loop.
 */
export const workspacePauseRail: SafetyRailMiddleware = async (context, next) => {
    const { pause } = context;
    if (!pause.paused) return next();

    const reason = pause.reason ? ` — ${pause.reason}` : '';
    const summary = pause.unverified
        ? 'Everything is paused: the workspace pause could not be read, so nothing new starts.'
        : `Everything is paused${reason}.`;

    return buildVerdict({
        decision: 'refused',
        railId: 'workspace-pause',
        reasonCode: pause.unverified ? 'safe-mode' : 'workspace-paused',
        context,
        summary,
    });
};
