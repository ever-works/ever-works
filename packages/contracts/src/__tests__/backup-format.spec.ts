import { describe, expect, it } from 'vitest';

import {
	BACKUP_DEFAULT_LIMITS,
	BACKUP_DOMAIN_COUNT,
	BACKUP_DOMAIN_KEYS,
	BACKUP_DOMAINS,
	BACKUP_EXCLUSIONS,
	BACKUP_FORMAT_SENTINEL,
	BACKUP_FORMAT_VERSION,
	BACKUP_FULL_HISTORY_CEILING_DAYS,
	BACKUP_MANIFEST_SENTINEL_FIELDS,
	BACKUP_TRIM_POLICIES,
	buildBackupArchiveFilename,
	compareBackupFormatVersion,
	getBackupDomain
} from '../backup/index.js';

/**
 * The archive format is a contract we publish to people who may open the file
 * years from now, without our source tree. Everything asserted here is
 * something a reader of a produced archive can check for themselves.
 */
describe('workspace backup format', () => {
	describe('the fifteen domains', () => {
		it('enumerates exactly fifteen, which is the number the manifest promises', () => {
			expect(BACKUP_DOMAINS).toHaveLength(15);
			expect(BACKUP_DOMAIN_COUNT).toBe(15);
			expect(BACKUP_DOMAIN_KEYS).toHaveLength(15);
		});

		it('gives every domain a unique key, and the key list mirrors the descriptors in order', () => {
			const keys = BACKUP_DOMAINS.map((domain) => domain.key);
			expect(new Set(keys).size).toBe(keys.length);
			expect([...BACKUP_DOMAIN_KEYS]).toEqual(keys);
		});

		it('gives every domain a restorability class, a collector id and a data directory', () => {
			for (const domain of BACKUP_DOMAINS) {
				expect(['restorable', 'record-only', 'partly-restorable']).toContain(domain.restorability);
				expect(domain.collectorId).toBeTruthy();
				expect(domain.dataDir).toBeTruthy();
			}
		});

		it('gives every domain a unique collector id, so no domain is listed with nothing to produce it', () => {
			const ids = BACKUP_DOMAINS.map((domain) => domain.collectorId);
			expect(new Set(ids).size).toBe(ids.length);
		});

		it('keeps money, machines, runs, decisions and history out of what a restore may write', () => {
			// Balances are earned in one account and cannot be minted by
			// importing a file; a node is a physical machine that must enrol
			// itself; runs, decisions and activity describe a past that did
			// not happen in the target workspace.
			expect(getBackupDomain('billing')?.restorability).toBe('record-only');
			expect(getBackupDomain('runs')?.restorability).toBe('record-only');
			expect(getBackupDomain('decisions')?.restorability).toBe('record-only');
			expect(getBackupDomain('activity')?.restorability).toBe('record-only');
			expect(getBackupDomain('fleet')?.restorability).toBe('partly-restorable');
			expect(getBackupDomain('communication')?.restorability).toBe('partly-restorable');
		});

		it('returns nothing for a key that is not a domain', () => {
			expect(getBackupDomain('nope' as never)).toBeUndefined();
		});
	});

	describe('trim windows', () => {
		it('names a timestamp field on every policy', () => {
			for (const [name, policy] of Object.entries(BACKUP_TRIM_POLICIES)) {
				expect(policy.field, name).toBeTruthy();
			}
		});

		it('never makes the ordinary window wider than the full-history one', () => {
			for (const [name, policy] of Object.entries(BACKUP_TRIM_POLICIES)) {
				expect(policy.defaultDays, name).toBeLessThanOrEqual(policy.fullHistoryDays);
			}
		});

		it('never lets full history exceed the three-year ceiling', () => {
			for (const [name, policy] of Object.entries(BACKUP_TRIM_POLICIES)) {
				expect(policy.fullHistoryDays, name).toBeLessThanOrEqual(BACKUP_FULL_HISTORY_CEILING_DAYS);
			}
		});

		it('carries a trim field wherever a domain declares a domain-wide window', () => {
			for (const domain of BACKUP_DOMAINS) {
				if (!domain.trim) continue;
				expect(domain.trim.field, domain.key).toBeTruthy();
				expect(domain.trim.defaultDays, domain.key).toBeLessThanOrEqual(domain.trim.fullHistoryDays);
			}
		});

		it('trims the activity history at a year by default and three years with full history', () => {
			expect(getBackupDomain('activity')?.trim).toEqual({
				field: 'createdAt',
				defaultDays: 365,
				fullHistoryDays: 1095
			});
		});
	});

	describe('the exclusions list', () => {
		it('names all nine categories that never appear in an archive', () => {
			expect(BACKUP_EXCLUSIONS).toHaveLength(9);
			expect(BACKUP_EXCLUSIONS.map((entry) => entry.code)).toEqual([
				'auth_tokens',
				'sessions',
				'api_key_material',
				'stored_credentials',
				'node_enrolment_secrets',
				'payment_identifiers',
				'platform_admin_flag',
				'vector_embeddings',
				'internal_caches'
			]);
		});

		it('gives every category a plain-English summary the archive can state for itself', () => {
			for (const entry of BACKUP_EXCLUSIONS) {
				expect(entry.summary.length, entry.code).toBeGreaterThan(20);
			}
		});
	});

	describe('the version constant and its comparison', () => {
		it('parses as major.minor', () => {
			expect(BACKUP_FORMAT_VERSION).toMatch(/^\d+\.\d+$/);
		});

		it('reads older and equal archives, and only calls a higher one newer', () => {
			expect(compareBackupFormatVersion('1.0', '1.0')).toBe('same');
			expect(compareBackupFormatVersion('0.9', '1.0')).toBe('older');
			expect(compareBackupFormatVersion('1.0', '1.1')).toBe('older');
			expect(compareBackupFormatVersion('1.1', '1.0')).toBe('newer');
			expect(compareBackupFormatVersion('2.0', '1.9')).toBe('newer');
		});

		it('refuses to guess at a version it cannot parse', () => {
			for (const value of ['', 'one.zero', '1', '1.0.0', 'v1.0']) {
				expect(compareBackupFormatVersion(value), value).toBe('unparseable');
			}
		});

		it('names both sentinel fields, so a refusal can say what it looked for', () => {
			expect(BACKUP_MANIFEST_SENTINEL_FIELDS).toEqual(['everworksBackupFormat', 'producedAt']);
			expect(BACKUP_FORMAT_SENTINEL).toBe('everworks-workspace-backup');
		});
	});

	describe('the archive filename', () => {
		it('is dated, slugged and short-id suffixed', () => {
			expect(buildBackupArchiveFilename('acme', '2026-09-06T14:12:00.000Z', '7fa39c')).toBe(
				'everworks-backup-acme-2026-09-06-7fa39c.zip'
			);
		});

		it('never lets a slug put a path separator or a space into the name', () => {
			expect(buildBackupArchiveFilename('../ac me/x', '2026-09-06', 'abc123')).toBe(
				'everworks-backup-ac-me-x-2026-09-06-abc123.zip'
			);
		});

		it('falls back to a readable name when the slug survives as nothing', () => {
			expect(buildBackupArchiveFilename('///', '2026-09-06', 'abc123')).toBe(
				'everworks-backup-workspace-2026-09-06-abc123.zip'
			);
		});
	});

	describe('the shipped defaults', () => {
		it('keeps the record for longer than the bytes, so history outlives the archive', () => {
			expect(BACKUP_DEFAULT_LIMITS.recordRetentionDays).toBeGreaterThan(BACKUP_DEFAULT_LIMITS.retentionDays);
		});

		it('keeps the per-file budget under the whole-archive attachment budget', () => {
			expect(BACKUP_DEFAULT_LIMITS.maxFileBytes).toBeLessThan(BACKUP_DEFAULT_LIMITS.maxAttachmentBytes);
			expect(BACKUP_DEFAULT_LIMITS.maxAttachmentBytes).toBeLessThan(BACKUP_DEFAULT_LIMITS.maxArchiveBytes);
		});

		it('applies a smaller ceiling when the backend cannot take a stream', () => {
			expect(BACKUP_DEFAULT_LIMITS.maxBufferedArchiveBytes).toBeLessThan(BACKUP_DEFAULT_LIMITS.maxArchiveBytes);
		});

		it('never shows more history rows than one page may return', () => {
			expect(BACKUP_DEFAULT_LIMITS.historyPageSize).toBeLessThanOrEqual(BACKUP_DEFAULT_LIMITS.historyPageLimit);
		});
	});
});
