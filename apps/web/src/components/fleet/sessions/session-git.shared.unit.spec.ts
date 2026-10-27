import { describe, expect, it } from 'vitest';
import type { FleetGitLine } from '@ever-works/contracts';
import {
    changedFileCounts,
    changedFileStatusKey,
    diffLineTone,
    formatBytes,
    gitLineAgeTone,
    minutesSince,
    prChecksGlyph,
    safeHttpsUrl,
    sessionGitErrorTitleKey,
    sessionGitState,
    withoutPullRequest,
} from './session-git.shared';
import { defaultWhereMode } from './SessionWhereStep';

const line: FleetGitLine = {
    branch: 'nina/fix-login',
    isWorktree: true,
    baseRef: 'main',
    ahead: 3,
    behind: 0,
    added: 214,
    removed: 38,
    filesChanged: 6,
    uncommitted: 2,
    pr: {
        number: 912,
        state: 'open',
        checks: 'passing',
        url: 'https://github.com/acme/api/pull/912',
    },
    at: '2026-10-21T10:00:00.000Z',
};

describe('FL-06 session git — shared rules', () => {
    it('reads the checks glyph and only links plain https URLs', () => {
        expect(prChecksGlyph('passing')).toBe('✓');
        expect(prChecksGlyph('failing')).toBe('✗');
        expect(prChecksGlyph('pending')).toBe('⏳');
        expect(prChecksGlyph(null)).toBe('');
        expect(safeHttpsUrl('https://github.com/acme/api/pull/912')).toBe(
            'https://github.com/acme/api/pull/912',
        );
        expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
        expect(safeHttpsUrl('https://user:pass@github.com/x')).toBeNull();
        expect(safeHttpsUrl('http://github.com/x')).toBeNull();
    });

    it('turns the age amber past five minutes and dims it offline', () => {
        const at = Date.parse(line.at);
        expect(gitLineAgeTone(line, at + 60_000, false)).toBe('normal');
        expect(gitLineAgeTone(line, at + 6 * 60_000, false)).toBe('stale');
        expect(gitLineAgeTone(line, at, true)).toBe('offline');
    });

    it('drops the pull request for the card (the pill has its own slot)', () => {
        expect(withoutPullRequest(line)?.pr).toBeNull();
        expect(withoutPullRequest(null)).toBeNull();
    });

    it('says when there is no checkout or its folder is gone', () => {
        expect(sessionGitState(null)).toBe('none');
        expect(
            sessionGitState({
                checkoutId: 'c',
                path: '/x',
                kind: 'worktree',
                state: 'missing',
                isolation: 'host',
                createdBy: 'agent',
                repository: 'acme/api',
                branch: 'nina/x',
                gitLine: null,
            }),
        ).toBe('missing');
    });

    it('formats the Changes footer and file rows as text', () => {
        expect(formatBytes(300)).toBe('300 B');
        expect(formatBytes(12 * 1024)).toBe('12 KiB');
        expect(formatBytes(1.4 * 1024 * 1024)).toBe('1.4 MiB');
        expect(changedFileCounts({ added: 12, removed: 3 })).toBe('+12 −3');
        expect(changedFileCounts({ added: null, removed: null })).toBeNull();
        expect(changedFileStatusKey('type-changed')).toBe('typeChanged');
        expect(diffLineTone('+added')).toContain('emerald');
        expect(diffLineTone('-removed')).toContain('red');
        expect(diffLineTone('+++ b/file')).toContain('muted');
    });

    it('maps every CONTRACTS §8 code to a title, unknown ones to internal', () => {
        expect(sessionGitErrorTitleKey('kill_switch')).toBe('killSwitch');
        expect(sessionGitErrorTitleKey('consent_missing')).toBe('consentMissing');
        expect(sessionGitErrorTitleKey('whatever')).toBe('internal');
        expect(sessionGitErrorTitleKey(null)).toBe('internal');
    });

    it('counts minutes since GitHub was last reachable, at least one', () => {
        expect(
            minutesSince('2026-10-21T10:00:00.000Z', Date.parse('2026-10-21T10:03:10.000Z')),
        ).toBe(3);
        expect(
            minutesSince('2026-10-21T10:00:00.000Z', Date.parse('2026-10-21T10:00:05.000Z')),
        ).toBe(1);
        expect(minutesSince(null, 0)).toBeNull();
    });

    it('preselects a new worktree for an Agent session in a checkout with a remote (spec FR-2)', () => {
        expect(
            defaultWhereMode('agent', {
                createdBy: 'user',
                remoteUrl: 'https://github.com/acme/api',
            }),
        ).toBe('worktree');
        expect(
            defaultWhereMode('owner', {
                createdBy: 'user',
                remoteUrl: 'https://github.com/acme/api',
            }),
        ).toBe('existing');
        expect(
            defaultWhereMode('agent', {
                createdBy: 'task',
                remoteUrl: 'https://github.com/acme/api',
            }),
        ).toBe('existing');
        expect(defaultWhereMode('agent', { createdBy: 'discovery', remoteUrl: null })).toBe(
            'existing',
        );
    });
});
