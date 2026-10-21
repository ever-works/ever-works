/**
 * Inbox → a session on a computer (FL-05, CONTRACTS R-12) — the router the
 * Inbox reply uses for a `fleet-session` Decision: the answer goes into the
 * session (typed by the node as the CLI expects it), never into a Run.
 *
 * A leaf file with no runtime imports, like `inbox-producer.port.ts`: the
 * API's `@Global()` sessions module binds the token to
 * `FleetSessionService.answer`, and `InboxService` injects it `@Optional()`
 * — unbound, a reply to such an item is recorded and not routed.
 *
 * The router THROWS the session's refusal (`invalid` "Already answered",
 * `unreachable`, `kill_switch`, `permission_denied`): the Inbox reply then
 * releases its claim, so the Decision stays answerable (FR-29).
 */
export const FLEET_SESSION_ANSWER_ROUTER = 'FLEET_SESSION_ANSWER_ROUTER' as const;

export interface FleetSessionAnswerRouterInput {
    userId: string;
    sessionId: string;
    key: string;
    optionId?: string | null;
    text?: string | null;
    source: 'inbox' | 'decisions';
}

export interface FleetSessionAnswerRouter {
    answer(input: FleetSessionAnswerRouterInput): Promise<void>;
}
