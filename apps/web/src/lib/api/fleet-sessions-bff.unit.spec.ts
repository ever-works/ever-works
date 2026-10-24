import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/constants', () => ({ API_URL: 'http://api.test/api' }));

import {
    fleetApiUrl,
    sanitizeAttachBody,
    sanitizeEndBody,
    sanitizeListQuery,
    sanitizeRenameBody,
    sanitizeStartBody,
} from './fleet-sessions-bff';

const UUID = '11111111-1111-4111-8111-111111111111';

/**
 * FL-04 P1b — the session BFF rebuilds every body from its allow-list: the
 * browser never smuggles a field upstream (a `startedBy`, an unknown role, a
 * node id inside a body).
 */
describe('fleet-sessions-bff', () => {
    it('builds platform URLs under /api/fleet', () => {
        expect(fleetApiUrl('/sessions/x')).toBe('http://api.test/api/fleet/sessions/x');
    });

    it('rebuilds the start body and drops what is not in it', () => {
        const body = sanitizeStartBody({
            kind: 'owner',
            provider: 'claude-code',
            cwd: '  ~/code/app ',
            title: 'fix',
            firstMessage: 'run the tests',
            startedBy: 'user:someone-else',
            nodeId: UUID,
            cols: 9999,
            rows: 1,
            checkoutId: 'not-a-uuid',
            restartOf: UUID,
        });
        expect(body).toEqual({
            kind: 'owner',
            provider: 'claude-code',
            cwd: '~/code/app',
            title: 'fix',
            firstMessage: 'run the tests',
            restartOf: UUID,
            cols: 500,
            rows: 5,
        });
        expect(sanitizeStartBody({ kind: 'root', provider: 'bash', cwd: 'a\0b' })).toEqual({});
    });

    it('keeps rename to a title, end to confirm: true, attach to a known role', () => {
        expect(sanitizeRenameBody({ title: '  x  ', state: 'ended' })).toEqual({ title: 'x' });
        expect(sanitizeRenameBody({ title: '' })).toEqual({});
        expect(sanitizeEndBody({ confirm: 'yes' })).toEqual({});
        expect(sanitizeEndBody({ confirm: true, reason: 'drain' })).toEqual({ confirm: true });
        expect(sanitizeAttachBody({ role: 'owner' })).toBeNull();
        expect(sanitizeAttachBody({ role: 'viewer' })).toEqual({ role: 'viewer' });
    });

    it('rebuilds the list query', () => {
        const params = new URLSearchParams({
            state: 'live',
            kind: 'agent',
            nodeId: UUID,
            limit: '500',
            cursor: '2026-10-21T10:00:00.000Z|abc',
            evil: '1',
        });
        expect(sanitizeListQuery(params)).toBe(
            `?state=live&kind=agent&nodeId=${UUID}&cursor=2026-10-21T10%3A00%3A00.000Z%7Cabc`,
        );
        expect(sanitizeListQuery(new URLSearchParams())).toBe('');
    });
});
