import { describe, expect, it } from 'vitest';
import type { FleetLogLine, FleetLogSource } from '@ever-works/contracts';
import {
    appendHeld,
    EMPTY_WINDOW,
    filterHeld,
    firstHeldAtOrAfter,
    groupLogSources,
    isAtBottom,
    logFooterParts,
    logsCopyText,
    logsDownloadName,
    logsTabCard,
    prependHeld,
    shouldStopFollowing,
    typedPathSourceId,
} from './logs.shared';

/** Logs on computers (FL-08, T-12) — the pure half of the Logs tab (spec §5, FR-15 … FR-21). */

const line = (text: string, extra: Partial<FleetLogLine> = {}): FleetLogLine => ({
    ts: null,
    level: 'info',
    text,
    src: 0,
    redactions: 0,
    ...extra,
});

const node = { kind: 'node' as const, status: 'online' as const, lastHeartbeatAt: '2026-10-21T09:00:00.000Z' };

describe('logsTabCard', () => {
    it('names the one reason the tab cannot list', () => {
        expect(logsTabCard({ ...node, kind: 'desktop-node' }, null)).toEqual({ kind: 'desktop-node' });
        expect(logsTabCard({ ...node, status: 'offline' }, null)).toEqual({
            kind: 'offline',
            lastSeenAt: '2026-10-21T09:00:00.000Z',
        });
        const error = (code: string) => ({ code: code as never, hint: 'h', details: {}, status: 409 });
        expect(logsTabCard(node, error('consent_missing'))).toEqual({
            kind: 'consent-missing',
            command: 'ever-works-node start --manage',
        });
        expect(logsTabCard(node, error('permission_denied'))?.kind).toBe('permission-denied');
        expect(logsTabCard(node, error('kill_switch'))?.kind).toBe('kill-switch');
        expect(logsTabCard(node, error('unreachable'))?.kind).toBe('unreachable');
        expect(logsTabCard(node, null)).toBeNull();
    });
});

describe('groupLogSources', () => {
    it('groups by kind and files by root, counting files', () => {
        const source = (id: string, kind: FleetLogSource['kind'], group = ''): FleetLogSource => ({
            id,
            kind,
            label: id,
            group,
            readable: true,
            supportsEarlier: false,
        });
        const groups = groupLogSources([
            source('system:journal', 'system'),
            source('file:/var/log/a', 'file', '/var/log'),
            source('file:/srv/b.log', 'file', '/srv'),
            source('file:/var/log/c', 'file', '/var/log'),
            source('container:api', 'container'),
            source('service:nginx.service', 'service'),
        ]);
        expect(groups.fileCount).toBe(3);
        expect(groups.files.map((root) => [root.root, root.sources.length])).toEqual([
            ['/var/log', 2],
            ['/srv', 1],
        ]);
        expect(groups.system).toHaveLength(1);
        expect(groups.containers).toHaveLength(1);
        expect(groups.services).toHaveLength(1);
    });
});

describe('the held window (FR-21)', () => {
    it('keeps the newest lines and counts what it discarded', () => {
        let window = appendHeld(EMPTY_WINDOW, [line('a'), line('b'), line('c')], 2);
        expect(window.lines.map((held) => held.line.text)).toEqual(['b', 'c']);
        expect(window.discarded).toBe(1);
        window = appendHeld(window, [line('d')], 2);
        expect(window.lines.map((held) => held.line.text)).toEqual(['c', 'd']);
        expect(window.discarded).toBe(2);
    });

    it('prepends an older page only as far as room allows', () => {
        const window = appendHeld(EMPTY_WINDOW, [line('new')], 3);
        const merged = prependHeld(window, [line('o1'), line('o2'), line('o3')], 3);
        expect(merged.lines.map((held) => held.line.text)).toEqual(['o2', 'o3', 'new']);
    });

    it('filters held lines case-insensitively (FR-17)', () => {
        const window = appendHeld(EMPTY_WINDOW, [line('GET nginx'), line('postgres'), line('NGINX reload')]);
        expect(filterHeld(window.lines, 'nginx').map((held) => held.line.text)).toEqual(['GET nginx', 'NGINX reload']);
        expect(filterHeld(window.lines, '  ')).toHaveLength(3);
    });
});

describe('scrolling (FR-16)', () => {
    it('stops following beyond one viewport up and resumes at the bottom', () => {
        expect(shouldStopFollowing(0, 3000, 500)).toBe(true);
        expect(shouldStopFollowing(2200, 3000, 500)).toBe(false);
        expect(isAtBottom(2490, 3000, 500)).toBe(true);
    });
});

describe('footer (spec §5.1 … §5.4)', () => {
    const base = {
        phase: 'live' as const,
        following: true,
        paused: false,
        pausedCount: 0,
        held: 500,
        shown: 500,
        filter: '',
        bytes: 1.2 * 1024 * 1024,
        redactions: 0,
        dropped: 0,
        discarded: 0,
    };

    it('reads following, held, bytes, redactions', () => {
        expect(logFooterParts(base).map((part) => part.key)).toEqual([
            'footerFollowing',
            'footerHeld',
            'footerBytes',
            'footerRedactions',
        ]);
        expect(logFooterParts(base)[2]?.values).toEqual({ bytes: '1.2 MB' });
    });

    it('reads paused with its count, the filter, drops and discards', () => {
        const parts = logFooterParts({ ...base, paused: true, pausedCount: 12, filter: 'nginx', shown: 37, dropped: 1240, discarded: 3 });
        expect(parts.map((part) => part.key)).toEqual([
            'footerPaused',
            'footerFiltered',
            'footerBytes',
            'footerRedactions',
            'footerDropped',
            'footerDiscarded',
        ]);
        expect(parts[0]?.values).toEqual({ count: 12 });
        expect(parts[1]?.values).toEqual({ shown: 37, held: 500, filter: 'nginx' });
    });
});

describe('copy and download (FR-19, FR-40)', () => {
    it('copies plain text, one line per line', () => {
        const window = appendHeld(EMPTY_WINDOW, [line('a', { ts: '2026-10-21T09:41:02.000Z' }), line('b')]);
        expect(logsCopyText(window.lines)).toBe('2026-10-21T09:41:02.000Z a\nb');
    });

    it('names a download after the computer, the source and the time', () => {
        expect(logsDownloadName('build-01', 'service:nginx.service', new Date(2026, 9, 21, 9, 41, 2))).toBe(
            'build-01-nginx.service-20261021-094102.log',
        );
    });
});

describe('typedPathSourceId (S8)', () => {
    it('accepts absolute paths only', () => {
        expect(typedPathSourceId(' /var/log/nginx/error.log ')).toBe('file:/var/log/nginx/error.log');
        expect(typedPathSourceId('C:\\logs\\app.log')).toBe('file:C:\\logs\\app.log');
        expect(typedPathSourceId('var/log/x')).toBeNull();
        expect(typedPathSourceId('')).toBeNull();
    });
});

describe('firstHeldAtOrAfter (P3, FR-39)', () => {
    it('finds the first line at or after the failure time', () => {
        const window = appendHeld(EMPTY_WINDOW, [
            line('a', { ts: '2026-10-21T09:40:00.000Z' }),
            line('no stamp'),
            line('b', { ts: '2026-10-21T09:41:02.000Z' }),
            line('c', { ts: '2026-10-21T09:42:00.000Z' }),
        ]);
        expect(firstHeldAtOrAfter(window.lines, '2026-10-21T09:41:00.000Z')).toBe(2);
        expect(firstHeldAtOrAfter(window.lines, '2026-10-21T09:39:00.000Z')).toBe(0);
        expect(firstHeldAtOrAfter(window.lines, '2026-10-21T10:00:00.000Z')).toBe(-1);
        expect(firstHeldAtOrAfter(window.lines, 'later')).toBe(-1);
    });
});
