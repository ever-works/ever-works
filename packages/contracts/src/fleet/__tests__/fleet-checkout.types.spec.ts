import { describe, expect, it } from 'vitest';

import {
	FLEET_CHECKOUT_KINDS,
	FLEET_CHECKOUT_STATES,
	FLEET_CHECKOUTS_DISCOVERY_CAP,
	FLEET_CHECKOUT_GIT_LINE_REFRESH_MS,
	FLEET_CHECKOUT_MANUAL_REFRESH_MIN_MS,
	FLEET_CHECKOUT_RECONCILE_MS,
	fleetCheckoutName,
	fleetRemotesMatch,
	isFleetCheckoutKind,
	isFleetCheckoutPath,
	isFleetCheckoutState,
	parseFleetCheckoutsListReply,
	parseFleetGitLine,
	parseFleetNodeCheckoutRecord,
	parseFleetRemote,
	stripFleetRemoteCredential
} from '../fleet-checkout.types.js';

const GIT_LINE = {
	branch: 'main',
	isWorktree: false,
	baseRef: 'origin/main',
	ahead: 0,
	behind: 2,
	added: 0,
	removed: 0,
	filesChanged: 0,
	uncommitted: 0,
	pr: null,
	at: '2026-10-21T10:00:00.000Z'
};

const RECORD = {
	path: '/home/nina/code/api',
	checkoutId: null,
	kind: 'discovered',
	origin: 'discovery',
	parentPath: null,
	remoteUrl: 'https://github.com/acme/api.git',
	remoteHadCredential: false,
	branch: 'main',
	baseRef: null,
	headSha: 'a'.repeat(40),
	isolation: 'host',
	present: true,
	gitLine: GIT_LINE,
	sizeBytes: 1024,
	busy: null,
	reaperNote: null,
	lastUsedAt: null
};

describe('checkout vocabularies (CONTRACTS §4.3)', () => {
	it('names the three kinds and four states', () => {
		expect(FLEET_CHECKOUT_KINDS).toEqual(['clone', 'worktree', 'discovered']);
		expect(FLEET_CHECKOUT_STATES).toEqual(['creating', 'ready', 'missing', 'archived']);
		expect(isFleetCheckoutKind('discovered')).toBe(true);
		expect(isFleetCheckoutKind('bare')).toBe(false);
		expect(isFleetCheckoutState('archived')).toBe(true);
		expect(isFleetCheckoutState('deleted')).toBe(false);
	});

	it('pins the limits and cadences of the spec', () => {
		expect(FLEET_CHECKOUTS_DISCOVERY_CAP).toBe(300);
		expect(FLEET_CHECKOUT_GIT_LINE_REFRESH_MS).toBe(60_000);
		expect(FLEET_CHECKOUT_MANUAL_REFRESH_MIN_MS).toBe(10_000);
		expect(FLEET_CHECKOUT_RECONCILE_MS).toBe(600_000);
	});
});

describe('stripFleetRemoteCredential (spec FR-5, ACC-FL14-02)', () => {
	it('removes an embedded token from an https remote and flags it', () => {
		expect(stripFleetRemoteCredential('https://x:token@github.com/acme/api')).toEqual({
			url: 'https://github.com/acme/api',
			hadCredential: true
		});
	});

	it('removes a bare https username (an access token spelt as a user)', () => {
		expect(stripFleetRemoteCredential('https://ghp_secret@github.com/acme/api.git')).toEqual({
			url: 'https://github.com/acme/api.git',
			hadCredential: true
		});
	});

	it('keeps an ssh login name, which is not a secret, and drops an ssh password', () => {
		expect(stripFleetRemoteCredential('ssh://git@github.com/acme/api.git')).toEqual({
			url: 'ssh://git@github.com/acme/api.git',
			hadCredential: false
		});
		expect(stripFleetRemoteCredential('ssh://git:hunter2@github.com/acme/api.git')?.hadCredential).toBe(true);
	});

	it('leaves the scp-like form as it is', () => {
		expect(stripFleetRemoteCredential('git@github.com:acme/api.git')).toEqual({
			url: 'git@github.com:acme/api.git',
			hadCredential: false
		});
	});

	it('drops a query string (a token can ride there too)', () => {
		expect(stripFleetRemoteCredential('https://example.com/acme/api.git?access_token=abc')).toEqual({
			url: 'https://example.com/acme/api.git',
			hadCredential: true
		});
	});

	it('refuses things that are not remotes', () => {
		expect(stripFleetRemoteCredential('/home/nina/code/api')).toBeNull();
		expect(stripFleetRemoteCredential('file:///etc')).toBeNull();
		expect(stripFleetRemoteCredential('--upload-pack=calc')).toBeNull();
		expect(stripFleetRemoteCredential('')).toBeNull();
		expect(stripFleetRemoteCredential(42)).toBeNull();
	});
});

describe('parseFleetRemote / fleetRemotesMatch (spec FR-6, ACC-FL14-03)', () => {
	it('reads https, ssh and scp-like forms the same', () => {
		const expected = { host: 'github.com', owner: 'acme', repo: 'api', fullName: 'acme/api' };
		expect(parseFleetRemote('https://github.com/acme/api.git')).toEqual(expected);
		expect(parseFleetRemote('ssh://git@github.com/acme/api')).toEqual(expected);
		expect(parseFleetRemote('git@github.com:acme/api.git')).toEqual(expected);
	});

	it('is host-aware: a same-named repository on another host never matches', () => {
		expect(fleetRemotesMatch('https://github.com/acme/api', 'git@github.com:Acme/API.git')).toBe(true);
		expect(fleetRemotesMatch('https://github.com/acme/api', 'https://gitlab.com/acme/api')).toBe(false);
	});

	it('refuses deeper paths and remotes that still carry a credential', () => {
		expect(parseFleetRemote('https://gitlab.com/group/sub/api')).toBeNull();
		expect(parseFleetRemote('https://x:token@github.com/acme/api')).toBeNull();
	});
});

describe('parseFleetGitLine (CONTRACTS §4.7)', () => {
	it('keeps every §4.7 field', () => {
		expect(parseFleetGitLine(GIT_LINE)).toEqual(GIT_LINE);
	});

	it('answers null for a line without counts or a time', () => {
		expect(parseFleetGitLine({ ...GIT_LINE, at: 'yesterday' })).toBeNull();
		expect(parseFleetGitLine({ ...GIT_LINE, added: -1 })).toBeNull();
		expect(parseFleetGitLine(null)).toBeNull();
	});

	it('reads ahead/behind as null when the branch tracks nothing', () => {
		expect(parseFleetGitLine({ ...GIT_LINE, ahead: null, behind: null })?.ahead).toBeNull();
	});
});

describe('node records and the list reply', () => {
	it('accepts a well-formed record', () => {
		expect(parseFleetNodeCheckoutRecord(RECORD)).toEqual({ ...RECORD, gitLine: GIT_LINE });
	});

	it('strips a credential the node forgot to strip, and flags it', () => {
		const parsed = parseFleetNodeCheckoutRecord({ ...RECORD, remoteUrl: 'https://u:p@github.com/acme/api' });
		expect(parsed?.remoteUrl).toBe('https://github.com/acme/api');
		expect(parsed?.remoteHadCredential).toBe(true);
	});

	it('refuses a relative or empty path', () => {
		expect(parseFleetNodeCheckoutRecord({ ...RECORD, path: 'code/api' })).toBeNull();
		expect(parseFleetNodeCheckoutRecord({ ...RECORD, path: '' })).toBeNull();
		expect(isFleetCheckoutPath('C:\\Users\\nina\\code\\api')).toBe(true);
		expect(isFleetCheckoutPath('\\\\nas\\share\\api')).toBe(true);
	});

	it('drops unreadable records and duplicate paths, keeping the rest', () => {
		const reply = parseFleetCheckoutsListReply({
			checkouts: [RECORD, { ...RECORD }, { path: 'nope' }],
			complete: true,
			truncated: false,
			codeFolders: ['/home/nina/code', 'relative'],
			scannedAt: '2026-10-21T10:00:00.000Z',
			checkoutsRoot: null
		});
		expect(reply?.checkouts).toHaveLength(1);
		expect(reply?.codeFolders).toEqual(['/home/nina/code']);
		expect(reply?.complete).toBe(true);
		expect(reply?.remoteBranches).toBeUndefined();
	});

	it('names a checkout by its folder (what a typed confirmation asks for)', () => {
		expect(fleetCheckoutName('/home/nina/checkouts/api/fix-login/')).toBe('fix-login');
		expect(fleetCheckoutName('C:\\code\\web')).toBe('web');
	});
});
