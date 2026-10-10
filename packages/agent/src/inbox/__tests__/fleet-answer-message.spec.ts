import { composeFleetAnswerMessage, parseFleetAnswerMessage } from '../inbox.service';

/**
 * Self-build slice AU — the fleet answer message is a CONTRACT in both
 * directions now: `composeFleetAnswerMessage` writes it into a resumed
 * run's `pendingInput`, and the fleet planner reads it back with
 * `parseFleetAnswerMessage` to replay a Task's answered questions into a
 * run that starts a fresh CLI session. A drift between the two would
 * silently drop every earlier answer from the replay, so the pair is
 * pinned as a round trip.
 */
describe('fleet answer message (compose ⇄ parse)', () => {
    it('round-trips a question and its answer', () => {
        const message = composeFleetAnswerMessage('Which database?', 'Use Postgres.');
        expect(parseFleetAnswerMessage(message)).toEqual({
            question: 'Which database?',
            answer: 'Use Postgres.',
        });
    });

    it('keeps a multi-paragraph answer whole, separator lookalikes included', () => {
        const answer =
            "Use Postgres.\n\nOwner's answer: (quoting myself) and keep SQLite for tests.";
        expect(parseFleetAnswerMessage(composeFleetAnswerMessage('Which DB?', answer))).toEqual({
            question: 'Which DB?',
            answer,
        });
    });

    it.each([
        ['a plain steer', 'please also update the docs'],
        ['a reviewer rejection block', 'Reviewer rejected the previous attempt:\n\n- tests fail'],
        ['a question with no answer', 'Your question from the previous run: Which DB?'],
        ['an empty answer', composeFleetAnswerMessage('Which DB?', '   ')],
        ['an empty question', composeFleetAnswerMessage('  ', 'Use Postgres.')],
        ['not a string', 42],
        ['null', null],
    ])('returns null for %s', (_label, value) => {
        expect(parseFleetAnswerMessage(value)).toBeNull();
    });
});
