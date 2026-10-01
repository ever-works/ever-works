import { describe, expect, it } from 'vitest';
import { HIDDEN_WHEN_DISABLED_WORK_KINDS, isHiddenWhenDisabled } from './flag-gated-kinds';

/**
 * APW-01 T20 — the single list behind the fail-closed flag set and the chip
 * removal.
 *
 * The list is the kind of thing that silently grows a second copy: the flag
 * helper wants it server-side, the chip wants it client-side, and the moment
 * they disagree one surface hides a kind the other still offers. So the list is
 * asserted to be EXACTLY the kinds this epic intends, and the predicate is
 * asserted to be false for everything else — including values that do not exist
 * yet, because hiding an unfamiliar kind would make a future kind invisible by
 * omission.
 */

const OTHER_KINDS = [
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
    'repo',
    'company',
    'campaign',
    'default',
] as const;

describe('HIDDEN_WHEN_DISABLED_WORK_KINDS (APW-01 T20)', () => {
    it('is exactly app — a failure here means a kind joined or left the list', () => {
        expect([...HIDDEN_WHEN_DISABLED_WORK_KINDS]).toEqual(['app']);
    });

    it('hides app and nothing else', () => {
        expect(isHiddenWhenDisabled('app')).toBe(true);

        for (const kind of OTHER_KINDS) {
            expect(isHiddenWhenDisabled(kind), `${kind} must not be hidden`).toBe(false);
        }
    });

    it('does not hide a kind it has never heard of', () => {
        // The server ships a new kind without a coordinated web deploy
        // (`work.kind` is an open union), so an unknown value must fall through
        // to visible rather than invisible.
        for (const unknown of ['', 'application', 'apps', 'APP', 'workflow', 'nope']) {
            expect(isHiddenWhenDisabled(unknown), `${unknown} must not be hidden`).toBe(false);
        }
    });
});
