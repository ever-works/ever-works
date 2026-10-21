import type { FleetSessionBoardResponse, FleetSessionView } from '@ever-works/contracts';
import type { PaletteSessions } from './sections';
import type { PaletteTranslator } from './types';

/**
 * FL-05 P3 (spec FR-46, §5.12) — the palette's session rows from one board
 * read: the sessions waiting on the person, newest wait first, then the
 * recent ones ordered done → idle. Pure.
 */
export function paletteSessionsFrom(
    board: FleetSessionBoardResponse | null,
    computers: ReadonlyArray<{ id: string; name: string }>,
    t: PaletteTranslator,
): PaletteSessions | null {
    if (!board) return null;
    const names = new Map(computers.map((computer) => [computer.id, computer.name]));
    const waitedAt = (session: FleetSessionView) =>
        Date.parse(session.attention?.raisedAt ?? session.stateChangedAt ?? session.updatedAt) || 0;
    const entry = (session: FleetSessionView, detail: string) => ({
        id: session.id,
        title: session.title,
        detail,
        computer: names.get(session.nodeId) ?? null,
    });
    const needsYou = [...board.columns.needs_you]
        .sort((a, b) => waitedAt(b) - waitedAt(a))
        .map((session) =>
            entry(
                session,
                session.attention?.prompt?.trim() || t('fleet.sessions.states.needsYou'),
            ),
        );
    const recent = [
        ...board.columns.done.map((session) => entry(session, t('fleet.sessions.states.done'))),
        ...board.columns.idle.map((session) => entry(session, t('fleet.sessions.states.idle'))),
    ];
    return { needsYou, recent };
}
