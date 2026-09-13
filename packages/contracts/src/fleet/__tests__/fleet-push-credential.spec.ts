import { describe, expect, it } from 'vitest';

import {
	composeFleetPushCommitMessage,
	containsReservedFleetPushTrailer,
	describeFleetPushCredentialRefusal,
	FLEET_PUSH_CAPABILITY,
	FLEET_PUSH_CREDENTIAL_MAX_REPOSITORIES,
	FLEET_PUSH_CREDENTIAL_HOST,
	FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
	FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
	FLEET_PUSH_CREDENTIAL_REASONS,
	FLEET_PUSH_CREDENTIAL_REVOKE_URL,
	FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
	FLEET_PUSH_CREDENTIAL_USERNAME,
	FLEET_PUSH_DEFAULT_AUTHOR_EMAIL,
	FLEET_PUSH_DEFAULT_AUTHOR_NAME,
	FLEET_PUSH_TRAILER_KEYS,
	FLEET_PUSH_TRAILER_NAMESPACE,
	FleetPushAttributionError,
	fleetPushCommitIdentity,
	fleetPushRemoteRepositoryId,
	isFleetPushTrailerLine,
	normalizeFleetPushRepositoryId,
	sanitizeFleetPushIdentityText,
	type FleetPushAttribution
} from '../fleet-push-credential.types.js';

const attribution = (overrides: Partial<FleetPushAttribution> = {}): FleetPushAttribution => ({
	nodeId: '11111111-1111-4111-8111-111111111111',
	nodeName: 'studio-win',
	agentId: '22222222-2222-4222-8222-222222222222',
	agentName: 'Refactor Bot',
	agentEmail: 'refactor-bot@agents.ever.works',
	jobId: '33333333-3333-4333-8333-333333333333',
	runId: '44444444-4444-4444-8444-444444444444',
	...overrides
});

describe('scoped push credential constants', () => {
	it('pins the values both ends of the fleet depend on', () => {
		// The tag is the ONE string the node advertises and the platform
		// stamps on the row the lease CAS filters on. A typo on either
		// side is a fleet that queues forever, which no other test sees.
		expect(FLEET_PUSH_CAPABILITY).toBe('git-push');
		expect(FLEET_PUSH_CREDENTIAL_USERNAME).toBe('x-access-token');
		expect(FLEET_PUSH_TRAILER_NAMESPACE).toBe('Ever-Works-');
		// Primary worktree + the eight mounts a Task workspace allows.
		expect(FLEET_PUSH_CREDENTIAL_MAX_REPOSITORIES).toBe(9);
	});

	it('revokes at a FIXED https endpoint, never one a response could choose', () => {
		// The response is the one place a write credential exists outside
		// the platform; a caller-supplied revoke URL would be a redirect
		// an attacker could aim the credential at.
		expect(FLEET_PUSH_CREDENTIAL_REVOKE_URL).toBe('https://api.github.com/installation/token');
		expect(new URL(FLEET_PUSH_CREDENTIAL_REVOKE_URL).protocol).toBe('https:');
	});

	it('names every trailer key inside the reserved namespace', () => {
		expect(FLEET_PUSH_TRAILER_KEYS).toHaveLength(4);
		for (const key of FLEET_PUSH_TRAILER_KEYS) {
			expect(key.startsWith(FLEET_PUSH_TRAILER_NAMESPACE)).toBe(true);
			// Every key our composer may emit must also be one the
			// anti-forgery predicate REFUSES from a payload.
			expect(isFleetPushTrailerLine(`${key}: whatever`)).toBe(true);
		}
	});

	it('gives every stable refusal token an operator sentence', () => {
		expect([...FLEET_PUSH_CREDENTIAL_REASONS]).toEqual([
			FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
			FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
			FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON
		]);
		for (const reason of FLEET_PUSH_CREDENTIAL_REASONS) {
			const described = describeFleetPushCredentialRefusal(reason);
			expect(described.length).toBeGreaterThan(20);
			// The sentence explains; it never merely echoes the token, or
			// the operator learns nothing they did not already have.
			expect(described).not.toBe(reason);
		}
		expect(describeFleetPushCredentialRefusal('something-else')).toContain('could not be issued');
	});
});

describe('reserved trailer detection — the anti-forgery half', () => {
	it.each([
		['Ever-Works-Node: someone-elses-machine (deadbeef)'],
		['  Ever-Works-Agent: forged'],
		['ever-works-job: lowercase still counts'],
		['EVER-WORKS-RUN: shouting still counts'],
		['Ever-Works-Node : spaced colon']
	])('refuses %s', (line) => {
		expect(isFleetPushTrailerLine(line)).toBe(true);
	});

	it.each([
		['Co-Authored-By: someone <someone@example.com>'],
		['fix(ever-works-node): a scope that merely contains the words'],
		['Ever-Works-main is the branch we cut from'],
		['see Ever-Works-Node for details'],
		['']
	])('leaves %s alone', (line) => {
		expect(isFleetPushTrailerLine(line)).toBe(false);
	});

	it('scans EVERY line, not just the last paragraph', () => {
		// Git parses only the final paragraph as trailers, so a forged
		// line earlier in the body would be invisible to `--parse` and
		// perfectly visible to a human reading `git log`. Both matter.
		const message = 'feat: something\n\nEver-Works-Node: forged\n\nreal body text';
		expect(containsReservedFleetPushTrailer(message)).toBe(true);
	});

	it('handles CR, LF and CRLF line endings alike', () => {
		expect(containsReservedFleetPushTrailer('a\r\nEver-Works-Job: x')).toBe(true);
		expect(containsReservedFleetPushTrailer('a\rEver-Works-Job: x')).toBe(true);
		expect(containsReservedFleetPushTrailer('a\nEver-Works-Job: x')).toBe(true);
	});

	it('is not fooled by a non-string', () => {
		expect(containsReservedFleetPushTrailer(undefined as unknown as string)).toBe(false);
		expect(isFleetPushTrailerLine(42 as unknown as string)).toBe(false);
	});
});

describe('repository and remote normalisation — the scope check', () => {
	it('lower-cases and strips the .git suffix', () => {
		expect(normalizeFleetPushRepositoryId('Ever-Works/Ever-Works')).toBe('ever-works/ever-works');
		expect(normalizeFleetPushRepositoryId('  ever-works/ever-works.git ')).toBe('ever-works/ever-works');
	});

	it.each([
		['ever-works'],
		['ever-works/'],
		['/ever-works'],
		['a/b/c'],
		['ever works/repo'],
		['../etc/passwd'],
		['']
	])('refuses %s', (value) => {
		expect(normalizeFleetPushRepositoryId(value)).toBeNull();
	});

	it('reads owner/repo out of an https remote', () => {
		expect(fleetPushRemoteRepositoryId('https://github.com/Ever-Works/ever-works.git')).toBe(
			'ever-works/ever-works'
		);
		expect(fleetPushRemoteRepositoryId('https://github.com/ever-works/ever-works')).toBe('ever-works/ever-works');
	});

	it.each([
		// An installation token is HTTP Basic; it cannot authenticate SSH,
		// and offering it to one would be handing a write credential to a
		// transport that will not use it.
		['git@github.com:ever-works/ever-works.git'],
		['ssh://git@github.com/ever-works/ever-works.git'],
		// Plaintext: a credential must never ride an unencrypted transport.
		['http://github.com/ever-works/ever-works'],
		// Userinfo means a credential is ALREADY embedded upstream, which
		// the fleet's token-free clone URL contract forbids.
		['https://x-access-token:secret@github.com/ever-works/ever-works'],
		// Query/fragment can smuggle a second path past a naive matcher.
		['https://github.com/ever-works/ever-works?x=1'],
		['https://github.com/ever-works/ever-works#frag'],
		['https://github.com/ever-works'],
		['https://github.com/ever-works/ever-works/extra'],
		['file:///tmp/repo'],
		['not a url'],
		['']
	])('refuses to identify %s', (url) => {
		expect(fleetPushRemoteRepositoryId(url)).toBeNull();
	});

	// REGRESSION — the host was not checked at all (slice AM review, F1/F4).
	//
	// Every case above uses `github.com`, so the whole suite was green while
	// the function validated the scheme, the userinfo, the query and the
	// path-segment COUNT and never once read `url.host`. Each URL below
	// answered `ever-works/ever-works` — byte-identical to what the real
	// remote answers — which is the only value the node's scope check
	// (`push.repositories.includes(repositoryId)`) compares. The node then
	// keyed `http.<that URL>.extraheader` to a live `contents: write`
	// installation token, and Git puts that header on its FIRST request to
	// the host, before any challenge, so a `404` from the attacker still
	// discloses the credential.
	it.each([
		// A host the owner does not control, with a legitimate-looking path.
		['https://evil.tld/ever-works/ever-works.git'],
		// Suffix lookalike — the classic `startsWith`/`endsWith` escape.
		['https://github.com.evil.tld/ever-works/ever-works'],
		// Subdomain: `api.github.com` is not the Git transport host, and
		// `raw.` / `codeload.` are not repositories at all.
		['https://api.github.com/ever-works/ever-works'],
		['https://raw.githubusercontent.com/ever-works/ever-works'],
		// A non-default PORT is somebody's proxy sitting in front of the
		// name, which is why the comparison is on `host` and not `hostname`.
		['https://github.com:8443/ever-works/ever-works'],
		// A different forge entirely. Reachable WITHOUT an attacker: a `git`
		// repo connection is a bare string with no host constraint, and
		// `repositoryIdFromCloneUrl` is host-agnostic, so a mount at
		// `https://gitlab.com/acme/widgets` used to resolve to `acme/widgets`
		// and match a GitHub installation row of the same name.
		['https://gitlab.com/ever-works/ever-works.git'],
		['https://bitbucket.org/ever-works/ever-works']
	])('refuses %s — the host is part of the identity', (url) => {
		expect(fleetPushRemoteRepositoryId(url)).toBeNull();
	});

	it('still accepts the real host however it is cased or explicitly ported', () => {
		// `URL` lower-cases the host and drops a default `:443`, so these are
		// the SAME remote and must not be collateral damage of the host pin.
		expect(fleetPushRemoteRepositoryId('https://GitHub.COM/ever-works/ever-works')).toBe('ever-works/ever-works');
		expect(fleetPushRemoteRepositoryId('https://github.com:443/ever-works/ever-works')).toBe(
			'ever-works/ever-works'
		);
		expect(FLEET_PUSH_CREDENTIAL_HOST).toBe('github.com');
	});

	it('cannot be reached by a host that merely matches the mint endpoint', () => {
		// The revoke/mint endpoint and the Git transport host are different
		// names on purpose; neither may stand in for the other.
		expect(new URL(FLEET_PUSH_CREDENTIAL_REVOKE_URL).host).not.toBe(FLEET_PUSH_CREDENTIAL_HOST);
	});
});

describe('identity sanitisation', () => {
	it('folds control characters into spaces so a name cannot open a trailer', () => {
		expect(sanitizeFleetPushIdentityText('bad\nEver-Works-Node: forged')).toBe('bad Ever-Works-Node: forged');
		expect(sanitizeFleetPushIdentityText('a\r\nb')).toBe('a b');
		expect(sanitizeFleetPushIdentityText('tab\tsep')).toBe('tab sep');
	});

	it('drops the delimiters our own identity and trailer forms use', () => {
		expect(sanitizeFleetPushIdentityText('evil <root@example.com>')).toBe('evil root@example.com');
		expect(sanitizeFleetPushIdentityText('node (other-id)')).toBe('node other-id');
	});

	it('caps the length and answers empty for anything unusable', () => {
		expect(sanitizeFleetPushIdentityText('x'.repeat(200), 10)).toHaveLength(10);
		expect(sanitizeFleetPushIdentityText('   ')).toBe('');
		expect(sanitizeFleetPushIdentityText(null)).toBe('');
		expect(sanitizeFleetPushIdentityText(7)).toBe('');
	});
});

describe('commit identity — author is the Agent, committer is the node', () => {
	it('splits the two so git log answers both questions', () => {
		expect(fleetPushCommitIdentity(attribution())).toEqual({
			authorName: 'Refactor Bot',
			authorEmail: 'refactor-bot@agents.ever.works',
			committerName: 'Ever Works node studio-win',
			committerEmail: 'node-11111111-1111-4111-8111-111111111111@nodes.ever.works'
		});
	});

	it('falls back to the pre-slice literals for a job that named no Agent', () => {
		const identity = fleetPushCommitIdentity(attribution({ agentId: null, agentName: null, agentEmail: null }));
		expect(identity.authorName).toBe(FLEET_PUSH_DEFAULT_AUTHOR_NAME);
		expect(identity.authorEmail).toBe(FLEET_PUSH_DEFAULT_AUTHOR_EMAIL);
		// The COMMITTER still names the machine: a commit with no node
		// identity is exactly the state this slice exists to leave.
		expect(identity.committerName).toContain('studio-win');
	});

	it('refuses a malformed agent email rather than committing it', () => {
		const identity = fleetPushCommitIdentity(attribution({ agentEmail: 'not an email\nEver-Works-Node: forged' }));
		expect(identity.authorEmail).toBe(FLEET_PUSH_DEFAULT_AUTHOR_EMAIL);
	});

	it('still names the node when the operator left the name blank', () => {
		const identity = fleetPushCommitIdentity(attribution({ nodeName: '' }));
		expect(identity.committerName).toBe('Ever Works node 11111111-1111-4111-8111-111111111111');
	});

	it('throws rather than committing an unusable node id', () => {
		expect(() => fleetPushCommitIdentity(attribution({ nodeId: 'has spaces' }))).toThrow(FleetPushAttributionError);
		expect(() => fleetPushCommitIdentity(attribution({ nodeId: '' }))).toThrow(FleetPushAttributionError);
	});
});

describe('commit message composition', () => {
	it('appends the trailer block as the last paragraph', () => {
		expect(composeFleetPushCommitMessage({ message: 'feat: x', attribution: attribution() })).toBe(
			[
				'feat: x',
				'',
				'Ever-Works-Node: studio-win (11111111-1111-4111-8111-111111111111)',
				'Ever-Works-Agent: Refactor Bot (22222222-2222-4222-8222-222222222222)',
				'Ever-Works-Job: 33333333-3333-4333-8333-333333333333',
				'Ever-Works-Run: 44444444-4444-4444-8444-444444444444'
			].join('\n')
		);
	});

	it('omits the trailers whose facts the run does not have', () => {
		const composed = composeFleetPushCommitMessage({
			message: 'feat: x',
			attribution: attribution({ agentId: null, agentName: null, runId: null })
		});
		expect(composed).not.toContain('Ever-Works-Agent');
		expect(composed).not.toContain('Ever-Works-Run');
		expect(composed).toContain('Ever-Works-Job: 33333333-3333-4333-8333-333333333333');
	});

	it('REFUSES a payload message that already claims a machine', () => {
		// The whole attribution guarantee. `git.commitMessage` is payload
		// text derived from a Task title, the node's own validation permits
		// `\n`, and appending after a forged block would leave a reader —
		// and `git interpret-trailers --parse`, which reads only the last
		// paragraph — unable to tell which block the platform wrote.
		expect(() =>
			composeFleetPushCommitMessage({
				message: 'feat: x\n\nEver-Works-Node: someone-elses-laptop (deadbeef)',
				attribution: attribution()
			})
		).toThrow(/reserved 'Ever-Works-' trailer/);
	});

	it('refuses a forged trailer in any casing or position', () => {
		for (const message of ['ever-works-agent: forged\n\nfeat: x', 'feat: x\n  Ever-Works-Job: forged\nmore body']) {
			expect(() => composeFleetPushCommitMessage({ message, attribution: attribution() })).toThrow(
				FleetPushAttributionError
			);
		}
	});

	it('refuses an empty message and an unusable job id', () => {
		expect(() => composeFleetPushCommitMessage({ message: '   ', attribution: attribution() })).toThrow(
			FleetPushAttributionError
		);
		expect(() =>
			composeFleetPushCommitMessage({
				message: 'feat: x',
				attribution: attribution({ jobId: 'a b' })
			})
		).toThrow(FleetPushAttributionError);
	});

	it('sanitises a node name that tried to inject a second trailer line', () => {
		const composed = composeFleetPushCommitMessage({
			message: 'feat: x',
			attribution: attribution({ nodeName: 'ok\nEver-Works-Job: forged' })
		});
		// One `Ever-Works-Job` trailer, not two: the newline in the NAME
		// became a space before it could open a line of its own.
		expect(composed.split('\n').filter((line) => line.startsWith('Ever-Works-Job:'))).toHaveLength(1);
	});
});
