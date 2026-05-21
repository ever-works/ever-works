import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Backup health — pass 15. We don't have a black-box way to trigger
 * a backup, but the health surface should expose backup posture so
 * oncall can verify the cluster is taking snapshots. We probe:
 *  - /api/health responds < 500 and is JSON (covered in health-meta)
 *  - the body, if it includes a `backup` / `db.backup` / `lastBackup`
 *    field, has a recent ISO-8601 timestamp (within the last 7 days)
 *  - if no backup field exists, informational skip (the platform may
 *    rely on cloud-managed snapshots and not surface metadata)
 */

const BACKUP_KEYS = ['backup', 'lastBackup', 'last_backup', 'backupAt', 'backup_at'];

test.describe('Backup posture — /api/health surfaces backup metadata if managed', () => {
    test('/api/health body either lacks backup metadata or carries a recent ISO timestamp', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        if (!res.ok()) test.skip(true, `/api/health unavailable (${res.status()})`);
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) test.skip(true, '/api/health is not JSON');
        const body = await res.json();
        // Find a backup-like timestamp anywhere in the response.
        const backupTimestamp = findBackupTimestamp(body, BACKUP_KEYS);
        if (!backupTimestamp) {
            test.info().annotations.push({
                type: 'informational',
                description: '/api/health does not expose backup metadata — cloud-managed assumed',
            });
            test.skip(true, 'no backup field exposed');
        }
        const t = Date.parse(backupTimestamp!);
        expect(Number.isFinite(t), `backup timestamp not parseable: "${backupTimestamp}"`).toBe(
            true,
        );
        const ageMs = Date.now() - t;
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        expect(
            ageMs,
            `last backup is older than 7 days: ${(ageMs / 86_400_000).toFixed(1)}d (${backupTimestamp})`,
        ).toBeLessThanOrEqual(sevenDays);
    });
});

function findBackupTimestamp(node: unknown, keys: string[]): string | null {
    if (!node || typeof node !== 'object') return null;
    const obj = node as Record<string, unknown>;
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string') return v;
        if (v && typeof v === 'object') {
            const nested =
                (v as Record<string, unknown>).timestamp ?? (v as Record<string, unknown>).at;
            if (typeof nested === 'string') return nested;
        }
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
            const found = findBackupTimestamp(v, keys);
            if (found) return found;
        }
    }
    return null;
}
