import { describe, expect, it } from 'vitest';
import { composeLogSourceIds, openLogsForSource, openMergedLogs } from './logs-tab.registry';
import { logsDeepLinkSources, toggleMergedSource } from './logs.shared';

/**
 * Logs on computers (FL-08 P2, T-20) — the links FL-09's rows and Compose view
 * open the Logs tab with, and the Logs tab reading them back (FR-35 … FR-38).
 */

const NODE = '11111111-1111-4111-8111-111111111111';

function read(href: string) {
    const params = new URL(href, 'http://x').searchParams;
    return logsDeepLinkSources(
        (name) => params.getAll(name),
        (name) => params.get(name),
    );
}

describe('openLogsForSource / openMergedLogs', () => {
    it('opens one source', () => {
        const href = openLogsForSource(NODE, 'service:nginx.service');
        expect(href).toBe(`/fleet/computers/${NODE}?tab=logs&source=service%3Anginx.service`);
        expect(read(href)).toEqual(['service:nginx.service']);
    });

    it('carries a failure time for P3 and drops a malformed one', () => {
        expect(
            openLogsForSource(NODE, 'service:postgresql.service', { at: '2026-10-21T09:41:02Z' }),
        ).toContain('at=2026-10-21T09%3A41%3A02.000Z');
        expect(openLogsForSource(NODE, 'service:postgresql.service', { at: 'soon' })).not.toContain(
            'at=',
        );
    });

    it('opens a merged view of a Compose project, bounded at twelve, de-duplicated', () => {
        const ids = composeLogSourceIds(['acme-api', 'acme-db', 'acme-cache', 'acme-api', '-bad']);
        expect(ids).toEqual([
            'container:acme-api',
            'container:acme-db',
            'container:acme-cache',
            'container:acme-api',
        ]);
        const href = openMergedLogs(NODE, ids, { title: 'acme' });
        expect(read(href)).toEqual([
            'container:acme-api',
            'container:acme-db',
            'container:acme-cache',
        ]);
        expect(new URL(href, 'http://x').searchParams.get('title')).toBe('acme');
        const many = Array.from({ length: 20 }, (_, i) => `container:c${i}`);
        expect(read(openMergedLogs(NODE, many))).toHaveLength(12);
    });

    it('still reads FL-09’s kind-and-name links', () => {
        expect(read(`/fleet/computers/${NODE}?tab=logs&source=service&unit=nginx.service`)).toEqual(
            ['service:nginx.service'],
        );
        expect(
            read(`/fleet/computers/${NODE}?tab=logs&source=container&container=acme-api`),
        ).toEqual(['container:acme-api']);
        expect(read(`/fleet/computers/${NODE}?tab=logs&source=container&container=-x`)).toEqual([]);
    });
});

describe('toggleMergedSource (ctrl/cmd-click)', () => {
    it('adds and removes, never empties, never past twelve', () => {
        expect(toggleMergedSource(['a:1'], 'b:2')).toEqual(['a:1', 'b:2']);
        expect(toggleMergedSource(['a:1', 'b:2'], 'a:1')).toEqual(['b:2']);
        expect(toggleMergedSource(['a:1'], 'a:1')).toEqual(['a:1']);
        const full = Array.from({ length: 12 }, (_, i) => `container:c${i}`);
        expect(toggleMergedSource(full, 'container:extra')).toHaveLength(12);
    });
});
