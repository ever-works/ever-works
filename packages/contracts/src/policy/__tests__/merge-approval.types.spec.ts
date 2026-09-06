import { describe, expect, it } from 'vitest';

import {
	MERGE_APPROVAL_MAX_AGE_MS,
	MERGE_APPROVAL_SUBJECT_KEY_MAX_LENGTH,
	mergeApprovalPullRequestKeyPrefix,
	mergeApprovalSubjectKey,
	normalizeCommitSha
} from '../merge-approval.types.js';

/**
 * The subject key is the entire "an approval cannot be replayed" property
 * of slice AE, so it is pinned as an exact string, not just "is defined".
 * If the format ever changes, every approval recorded under the old format
 * must stop matching — which is safe (refuse) but must be a DELIBERATE
 * change, and this file is where it gets noticed.
 */
describe('mergeApprovalSubjectKey', () => {
	const SUBJECT = {
		taskId: '9f1c0d1e-6c1a-4c3a-9f6c-2b6a0a5d1e77',
		prNumber: 42,
		headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
	};

	it('produces the canonical merge:<task>:<pr>:<sha> key', () => {
		expect(mergeApprovalSubjectKey(SUBJECT)).toBe(
			'merge:9f1c0d1e-6c1a-4c3a-9f6c-2b6a0a5d1e77:42:a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
		);
	});

	it('normalises SHA case so a provider that shouts cannot mint a second key', () => {
		expect(mergeApprovalSubjectKey({ ...SUBJECT, headSha: SUBJECT.headSha.toUpperCase() })).toBe(
			mergeApprovalSubjectKey(SUBJECT)
		);
	});

	it('changes when the head commit changes — this is the force-push guard', () => {
		const after = mergeApprovalSubjectKey({
			...SUBJECT,
			headSha: 'ffffffffffffffffffffffffffffffffffffffff'
		});
		expect(after).not.toBe(mergeApprovalSubjectKey(SUBJECT));
	});

	it('changes when the pull request changes, even at the same head', () => {
		expect(mergeApprovalSubjectKey({ ...SUBJECT, prNumber: 43 })).not.toBe(mergeApprovalSubjectKey(SUBJECT));
	});

	it('changes when the Task changes, so a recycled PR number cannot borrow an approval', () => {
		expect(mergeApprovalSubjectKey({ ...SUBJECT, taskId: 'other-task' })).not.toBe(
			mergeApprovalSubjectKey(SUBJECT)
		);
	});

	it.each([
		['an empty task id', { ...SUBJECT, taskId: '   ' }],
		['a zero pull-request number', { ...SUBJECT, prNumber: 0 }],
		['a negative pull-request number', { ...SUBJECT, prNumber: -1 }],
		['a fractional pull-request number', { ...SUBJECT, prNumber: 1.5 }],
		['a missing head sha', { ...SUBJECT, headSha: '' }],
		['a branch name in place of a head sha', { ...SUBJECT, headSha: 'refs/heads/main' }],
		['a 6-character abbreviation', { ...SUBJECT, headSha: 'a1b2c3' }]
	])('throws rather than minting a partial key for %s', (_label, subject) => {
		expect(() => mergeApprovalSubjectKey(subject)).toThrow();
	});

	it('refuses a key the column would truncate', () => {
		expect(() =>
			mergeApprovalSubjectKey({ ...SUBJECT, taskId: 'x'.repeat(MERGE_APPROVAL_SUBJECT_KEY_MAX_LENGTH) })
		).toThrow(/exceeds/);
	});

	it('fits a realistic uuid subject inside the column width', () => {
		expect(mergeApprovalSubjectKey(SUBJECT).length).toBeLessThanOrEqual(MERGE_APPROVAL_SUBJECT_KEY_MAX_LENGTH);
	});
});

describe('mergeApprovalPullRequestKeyPrefix', () => {
	it('is a strict prefix of every subject key for the same pull request', () => {
		const prefix = mergeApprovalPullRequestKeyPrefix({ taskId: 't-1', prNumber: 7 });
		const key = mergeApprovalSubjectKey({
			taskId: 't-1',
			prNumber: 7,
			headSha: 'abcdef1234567890abcdef1234567890abcdef12'
		});
		expect(key.startsWith(prefix)).toBe(true);
		expect(prefix).toBe('merge:t-1:7:');
	});

	it('does not prefix a DIFFERENT pull request whose number starts with the same digits', () => {
		const prefix = mergeApprovalPullRequestKeyPrefix({ taskId: 't-1', prNumber: 7 });
		const other = mergeApprovalSubjectKey({
			taskId: 't-1',
			prNumber: 70,
			headSha: 'abcdef1234567890abcdef1234567890abcdef12'
		});
		// The trailing ':' is what makes this true — without it `merge:t-1:7`
		// would LIKE-match PR #70, #71, #700 …
		expect(other.startsWith(prefix)).toBe(false);
	});
});

describe('normalizeCommitSha', () => {
	it.each([
		[
			'a full lower-case sha',
			'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
			'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
		],
		['an upper-case sha', 'ABCDEF1234567890ABCDEF1234567890ABCDEF12', 'abcdef1234567890abcdef1234567890abcdef12'],
		['a padded sha', '  abcdef1234567  ', 'abcdef1234567'],
		['a sha-256 object id', 'f'.repeat(64), 'f'.repeat(64)]
	])('accepts %s', (_label, input, expected) => {
		expect(normalizeCommitSha(input)).toBe(expected);
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['an empty string', ''],
		['a branch name', 'main'],
		['a ref', 'refs/heads/feature'],
		['a 6-char abbreviation', 'abcdef'],
		['a 65-char value', 'a'.repeat(65)],
		['non-hex characters', 'z1b2c3d4e5f60718293a4b5c6d7e8f9012345678']
	])('returns null (fail closed) for %s', (_label, input) => {
		expect(normalizeCommitSha(input as string | null | undefined)).toBeNull();
	});
});

describe('MERGE_APPROVAL_MAX_AGE_MS', () => {
	it('is 24 hours', () => {
		expect(MERGE_APPROVAL_MAX_AGE_MS).toBe(86_400_000);
	});
});
