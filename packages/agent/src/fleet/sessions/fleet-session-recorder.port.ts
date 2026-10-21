import type { FleetSessionKind } from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04 P3, CONTRACTS R-9, AW-11 P3) — how the session
 * service asks for a session to be recorded.
 *
 * A port, because the recorder is the API's: it opens a watch-only `session`
 * channel to the machine through the node link (FL-02) and stores what the
 * terminal prints through the transcript service (redacted, 14 days). The
 * agent package must not import the API, so it names the act here and the API
 * binds it (`FleetSessionRecorderService`). Unbound (the worker, a test), no
 * session is ever recorded — the honest answer when there is no link.
 *
 * Both calls are idempotent, fire-and-forget and never throw: recording is a
 * bonus, the session is the product.
 */
export interface FleetSessionRecordingTarget {
    id: string;
    nodeId: string;
    daemonSessionId: string;
    kind: FleetSessionKind;
}

export interface FleetSessionRecorderPort {
    /** Make sure this live session is being recorded (on the replica that holds its link). */
    ensure(session: FleetSessionRecordingTarget): void;
    /** Stop recording it (the session ended, or recording was switched off). */
    stop(sessionId: string): void;
}

export const FLEET_SESSION_RECORDER = 'FLEET_SESSION_RECORDER' as const;
