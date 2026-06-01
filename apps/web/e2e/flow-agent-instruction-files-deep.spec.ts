import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Agent instruction files — DEEP integration flows.
 *
 * The Agents/Skills/Tasks Phase-4/5/6a surface stores the FIVE canonical Agent
 * definition files DB-inline for tenant-scoped agents:
 *   SOUL.md · AGENTS.md · HEARTBEAT.md · TOOLS.md · agent.yml
 *
 * The two existing specs (flow-agent-instruction-files / agent-instruction-
 * files-ui) cover: all-5 independent bodies behind one shared hash, the basic
 * stale-hash conflict, the SOUL.md UI round-trip, the invalid-name 400, and the
 * empty-on-create defaults. This file deliberately exercises the UNCOVERED
 * edges — all verified live against the CI driver (sqlite in-memory, no LLM,
 * no Trigger.dev) so every assertion is deterministic:
 *
 *   PUT /api/agents/:id/files/:name { body, expectedHash? } → 200 { newHash:64hex }
 *     · 64 KB cap (AgentFileService.MAX_FILE_BYTES). `> 65536` UTF-8 bytes →
 *       400 "File body is N KB; max 64 KB."; EXACTLY 65536 bytes → 200 (the
 *       guard is `>`, so the boundary is inclusive). The KB figure in the
 *       message is Math.round(bytes/1024) — 65537 bytes still reads "64 KB".
 *     · Secret-scan (assertNoSecrets, HARD-REJECT). A ghp_/AKIA/sk- token in the
 *       body throws a plain Error → NestJS maps it to HTTP 500
 *       {"statusCode":500,"message":"Internal server error"} (NOT 400) and the
 *       write is a no-op. Clean prose with a "sk-" substring under the length
 *       floor is NOT a secret and saves fine.
 *     · Clearing a previously-written file to '' re-hashes the all-empty concat:
 *       GET then returns body '' but a NON-EMPTY 64-hex hash — distinct from the
 *       never-touched state (hash ''). Rewriting the identical body is
 *       idempotent (same newHash).
 *
 *   GET  /api/agents/:id/files/:name → 200 { name, body, hash, storage:'db' }
 *     · Cross-user read/write/export all 404 with "Agent <id> not found."
 *       (security: no existence leak via 403).
 *
 *   GET  /api/agents/:id/export → 200 AgentExportEnvelope { version:1, files:{
 *           soulMd, agentsMd, heartbeatMd, toolsMd, agentYml } } (untouched
 *         files serialize as null, not '').
 *   POST /api/agents/import[?onConflict=skip|overwrite|rename] → 201 {
 *           created, conflictResolution, originalSlug, finalSlug }
 *     · Default conflict mode = 'rename' → finalSlug '<slug>-2', created.name
 *       gets a " (imported)" suffix, created.status 'draft'. ALL FIVE file
 *       bodies round-trip byte-for-byte. NOTE: the create path does NOT seed
 *       contentHash, so the imported agent's GET hash is '' even with bodies
 *       present (only the overwrite path recomputes it).
 *     · onConflict=overwrite → conflictResolution 'overwritten', SAME slug,
 *       and contentHash IS recomputed so a follow-up expectedHash write using
 *       the live GET hash succeeds (200) instead of etag-mismatching.
 *
 *   UI: /agents/:id/instructions renders AgentInstructionsEditor — 5 pills +
 *       one controlled textarea (aria-label === active file). 800ms autosave;
 *       'saved' stamps ✓, 'conflict' stamps ! and shows a role="alert" banner
 *       ("Another edit happened in parallel."). The existing UI spec only edits
 *       SOUL.md; here we round-trip a NON-SOUL file (agent.yml) and drive the
 *       conflict banner by mutating the file underneath the editor's stale hash.
 *
 * Isolation: API-only mutation flows run on FRESH registerUserViaAPI() users so
 * the shared in-memory DB stays clean for sibling specs. The UI flows use the
 * SEEDED user (storageState) because the Instructions page is SSR'd against the
 * browser's logged-in session and can only read an agent that user owns.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const CONFLICT_MESSAGE =
	'Agent file was modified elsewhere — reload and try again (etag mismatch).';
const MAX_FILE_BYTES = 64 * 1024; // 65536 — AgentFileService cap.

const ALL_FILES = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'] as const;
type CanonicalFile = (typeof ALL_FILES)[number];

interface AgentFile {
	name: string;
	body: string;
	hash: string;
	storage: 'git' | 'db';
}

interface ExportEnvelope {
	version: number;
	identity: { name: string; slug: string; scope: string };
	files: {
		soulMd: string | null;
		agentsMd: string | null;
		heartbeatMd: string | null;
		toolsMd: string | null;
		agentYml: string | null;
	};
}

async function seededToken(request: APIRequestContext): Promise<string> {
	const seeded = loadSeededTestUser();
	// LOGIN DTO is whitelisted — ONLY {email,password}; a stray `name` → 400.
	const res = await request.post(`${API_BASE}/api/auth/login`, {
		data: { email: seeded.email, password: seeded.password },
	});
	expect(res.status()).toBe(200);
	return (await res.json()).access_token;
}

async function readFile(
	request: APIRequestContext,
	token: string,
	agentId: string,
	name: CanonicalFile,
): Promise<AgentFile> {
	const res = await request.get(`${API_BASE}/api/agents/${agentId}/files/${name}`, {
		headers: authedHeaders(token),
	});
	expect(res.status(), `read ${name} body=${await res.text().catch(() => '')}`).toBe(200);
	return res.json();
}

function putFileRaw(
	request: APIRequestContext,
	token: string,
	agentId: string,
	name: string,
	body: string,
	expectedHash?: string,
) {
	return request.put(`${API_BASE}/api/agents/${agentId}/files/${name}`, {
		headers: authedHeaders(token),
		data: expectedHash === undefined ? { body } : { body, expectedHash },
	});
}

async function writeFile(
	request: APIRequestContext,
	token: string,
	agentId: string,
	name: CanonicalFile,
	body: string,
	expectedHash?: string,
): Promise<{ newHash: string }> {
	const res = await putFileRaw(request, token, agentId, name, body, expectedHash);
	expect(res.status(), `write ${name} body=${await res.text().catch(() => '')}`).toBe(200);
	return res.json();
}

test.describe('Agent instruction files (deep) — caps, secret-scan, export/import, UI conflict', () => {
	test('64 KB size cap: 70 KB rejected with the exact message, 65536 bytes accepted, 65537 rejected — and a rejection is a no-op', async ({
		request,
	}) => {
		const { access_token: token } = await registerUserViaAPI(request);
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Size Cap Agent ${stamp}`,
			scope: 'tenant',
		});

		// Seed a known small body first so we can prove a rejected oversized
		// write does NOT clobber the persisted state.
		const seedBody = `# Within budget ${stamp}`;
		const { newHash: seedHash } = await writeFile(request, token, agent.id, 'HEARTBEAT.md', seedBody);
		expect(seedHash).toMatch(HEX64);

		// 70 KB → 400 with the Math.round(bytes/1024) KB figure in the message.
		const over = await putFileRaw(
			request,
			token,
			agent.id,
			'HEARTBEAT.md',
			'x'.repeat(70 * 1024),
		);
		expect(over.status(), `70KB body=${await over.text().catch(() => '')}`).toBe(400);
		const overJson = await over.json();
		expect(overJson.message).toBe('File body is 70 KB; max 64 KB.');
		expect(overJson.error).toBe('Bad Request');
		expect(overJson.statusCode).toBe(400);

		// The oversized write was a NO-OP — HEARTBEAT.md still holds the seed.
		const afterOver = await readFile(request, token, agent.id, 'HEARTBEAT.md');
		expect(afterOver.body).toBe(seedBody);
		expect(afterOver.hash).toBe(seedHash);

		// EXACTLY 65536 ASCII bytes → accepted (guard is `>`, so the boundary
		// is inclusive). Use a single-byte char so chars === bytes.
		const atCapBody = 'y'.repeat(MAX_FILE_BYTES);
		expect(Buffer.byteLength(atCapBody, 'utf8')).toBe(MAX_FILE_BYTES);
		const { newHash: atCapHash } = await writeFile(
			request,
			token,
			agent.id,
			'HEARTBEAT.md',
			atCapBody,
		);
		expect(atCapHash).toMatch(HEX64);
		expect(atCapHash).not.toBe(seedHash);
		const atCapRead = await readFile(request, token, agent.id, 'HEARTBEAT.md');
		expect(atCapRead.body.length).toBe(MAX_FILE_BYTES);

		// ONE byte over the cap → rejected; the message still rounds to "64 KB".
		const justOver = await putFileRaw(
			request,
			token,
			agent.id,
			'HEARTBEAT.md',
			'z'.repeat(MAX_FILE_BYTES + 1),
		);
		expect(justOver.status()).toBe(400);
		expect((await justOver.json()).message).toBe('File body is 64 KB; max 64 KB.');

		// The at-cap body is still the persisted state — the +1 attempt no-op'd.
		const finalRead = await readFile(request, token, agent.id, 'HEARTBEAT.md');
		expect(finalRead.body.length).toBe(MAX_FILE_BYTES);
		expect(finalRead.hash).toBe(atCapHash);
	});

	test('secret-scan HARD-REJECT: a real token 500s and is a no-op; near-miss prose saves cleanly', async ({
		request,
	}) => {
		const { access_token: token } = await registerUserViaAPI(request);
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Secret Scan Agent ${stamp}`,
			scope: 'tenant',
		});

		// Establish a clean baseline body + hash.
		const cleanBody = `# Tools doc ${stamp}\nUse read-only tools first.`;
		const { newHash: cleanHash } = await writeFile(request, token, agent.id, 'TOOLS.md', cleanBody);
		expect(cleanHash).toMatch(HEX64);

		// A GitHub classic PAT (ghp_ + 36+ chars) trips the hard-reject scanner.
		// assertNoSecrets throws a PLAIN Error, which NestJS surfaces as a 500
		// (Internal server error) — NOT a 400. The write must NOT persist.
		const secretBodies = [
			`# leaking ${stamp}\nghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD`,
			`aws creds AKIA${'A'.repeat(16)} here`,
			`bearer Bearer sk-${'a'.repeat(24)} oops`,
		];
		for (const bad of secretBodies) {
			const res = await putFileRaw(request, token, agent.id, 'TOOLS.md', bad);
			expect(
				res.status(),
				`secret body should be rejected, got ${res.status()}: ${await res
					.text()
					.catch(() => '')}`,
			).toBeGreaterThanOrEqual(400);
			// Live contract is 500 (plain Error). Tolerate a hardened 400 too, but
			// assert it never silently 200s.
			expect([400, 422, 500]).toContain(res.status());
		}

		// Every rejected write was a no-op — TOOLS.md still holds the clean body.
		const afterSecret = await readFile(request, token, agent.id, 'TOOLS.md');
		expect(afterSecret.body).toBe(cleanBody);
		expect(afterSecret.hash).toBe(cleanHash);

		// Near-miss: prose containing "sk-" but BELOW the 10-char floor (and not a
		// real key) is NOT a secret and saves fine. Proves the scanner is precise,
		// not a blunt "sk-" substring ban.
		const nearMiss = `# Tools ${stamp}\nThe sk-1 ticket and token-x note are fine prose.`;
		const { newHash: okHash } = await writeFile(request, token, agent.id, 'TOOLS.md', nearMiss);
		expect(okHash).toMatch(HEX64);
		expect(okHash).not.toBe(cleanHash);
		const okRead = await readFile(request, token, agent.id, 'TOOLS.md');
		expect(okRead.body).toBe(nearMiss);
	});

	test('clear-to-empty re-hashes the empty concat (≠ never-touched ""), and identical rewrites are idempotent', async ({
		request,
	}) => {
		const { access_token: token } = await registerUserViaAPI(request);
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Empty Hash Agent ${stamp}`,
			scope: 'tenant',
		});

		// Never-touched SOUL.md reports the empty-string sentinel hash.
		const pristine = await readFile(request, token, agent.id, 'SOUL.md');
		expect(pristine.body).toBe('');
		expect(pristine.hash).toBe('');

		// Write a body → real 64-hex hash.
		const body = `# real soul ${stamp}`;
		const { newHash: bodyHash } = await writeFile(request, token, agent.id, 'SOUL.md', body);
		expect(bodyHash).toMatch(HEX64);

		// Clear it back to '' — this is a legitimate edit (the editor explicitly
		// allows empty bodies). The shared content hash is recomputed over the
		// now-all-empty concatenation, so it is a NON-EMPTY 64-hex value that is
		// DISTINCT from both the body hash AND the never-touched '' sentinel.
		const { newHash: clearedHash } = await writeFile(request, token, agent.id, 'SOUL.md', '');
		expect(clearedHash).toMatch(HEX64);
		expect(clearedHash).not.toBe('');
		expect(clearedHash).not.toBe(bodyHash);

		const afterClear = await readFile(request, token, agent.id, 'SOUL.md');
		expect(afterClear.body).toBe('');
		// The body is empty BUT the hash is the populated empty-concat sha256 —
		// the agent has now been "touched", unlike the pristine read above.
		expect(afterClear.hash).toBe(clearedHash);
		expect(afterClear.hash).not.toBe('');

		// Idempotency: writing the SAME body twice yields the SAME hash (the hash
		// is a pure function of the 5-file concat, so re-writing identical bytes
		// is deterministic). Both PUTs return 200.
		const reBody = `# soul again ${stamp}`;
		const { newHash: h1 } = await writeFile(request, token, agent.id, 'SOUL.md', reBody);
		const { newHash: h2 } = await writeFile(request, token, agent.id, 'SOUL.md', reBody);
		expect(h1).toMatch(HEX64);
		expect(h2).toBe(h1);

		// And the optimistic-concurrency guard accepts the idempotent hash: a
		// third identical write carrying the (still-current) hash succeeds.
		const { newHash: h3 } = await writeFile(request, token, agent.id, 'SOUL.md', reBody, h2);
		expect(h3).toBe(h1);
	});

	test('export → import (rename) round-trips all 5 file bodies into a fresh DRAFT agent (created path leaves hash unseeded)', async ({
		request,
	}) => {
		const { access_token: token } = await registerUserViaAPI(request);
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Export Source ${stamp}`,
			scope: 'tenant',
		});

		// Author a distinct body in EVERY canonical file so we can prove each
		// column round-trips independently through the envelope.
		const bodies: Record<CanonicalFile, string> = {
			'SOUL.md': `# Soul ${stamp}\nbe meticulous [soul:${stamp}]`,
			'AGENTS.md': `# Manual ${stamp}\nfollow the playbook [agents:${stamp}]`,
			'HEARTBEAT.md': `# Heartbeat ${stamp}\ncheck the queue [hb:${stamp}]`,
			'TOOLS.md': `# Tools ${stamp}\nread-only first [tools:${stamp}]`,
			'agent.yml': `name: export-src-${stamp}\nmodel: gpt-omni # [yml:${stamp}]`,
		};
		let prev = '';
		for (const name of ALL_FILES) {
			const { newHash } = await writeFile(request, token, agent.id, name, bodies[name], prev);
			prev = newHash;
		}

		// Export → JSON envelope. Untouched-on-source files would be null; here
		// all five are populated.
		const exportRes = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
			headers: authedHeaders(token),
		});
		expect(exportRes.status()).toBe(200);
		const envelope = (await exportRes.json()) as ExportEnvelope;
		expect(envelope.version).toBe(1);
		expect(envelope.files.soulMd).toBe(bodies['SOUL.md']);
		expect(envelope.files.agentsMd).toBe(bodies['AGENTS.md']);
		expect(envelope.files.heartbeatMd).toBe(bodies['HEARTBEAT.md']);
		expect(envelope.files.toolsMd).toBe(bodies['TOOLS.md']);
		expect(envelope.files.agentYml).toBe(bodies['agent.yml']);

		// Import with the DEFAULT conflict mode (rename) — the source slug already
		// exists for this user, so the importer derives "<slug>-2", tags the name
		// with " (imported)", and lands the clone in DRAFT.
		const importRes = await request.post(`${API_BASE}/api/agents/import`, {
			headers: authedHeaders(token),
			data: envelope,
		});
		expect(importRes.status(), `import body=${await importRes.text().catch(() => '')}`).toBe(201);
		const result = await importRes.json();
		expect(result.conflictResolution).toBe('renamed');
		expect(result.originalSlug).toBe(envelope.identity.slug);
		expect(result.finalSlug).not.toBe(envelope.identity.slug);
		expect(result.finalSlug).toMatch(/-\d+$/); // -2, -3, …
		expect(result.created.status).toBe('draft');
		expect(String(result.created.name)).toContain('(imported)');

		const clonedId = result.created.id;
		expect(clonedId).not.toBe(agent.id);

		// All five bodies survived the export → import round-trip byte-for-byte.
		for (const name of ALL_FILES) {
			const f = await readFile(request, token, clonedId, name);
			expect(f.body, `${name} round-tripped through the envelope`).toBe(bodies[name]);
			expect(f.storage).toBe('db');
			// SUBTLE: the import CREATE path persists file bodies but does NOT seed
			// agents.contentHash, so the clone's GET hash is the empty sentinel even
			// though bodies are present. (The overwrite path is the only one that
			// recomputes it — see the next test.)
			expect(f.hash).toBe('');
		}

		// The source agent is untouched by the import.
		const sourceSoul = await readFile(request, token, agent.id, 'SOUL.md');
		expect(sourceSoul.body).toBe(bodies['SOUL.md']);
	});

	test('import (overwrite) refreshes contentHash so a follow-up expectedHash write reconciles instead of etag-mismatching', async ({
		request,
	}) => {
		const { access_token: token } = await registerUserViaAPI(request);
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `Overwrite Target ${stamp}`,
			scope: 'tenant',
		});

		// v1 state: write SOUL via the live editor path so the agent carries a
		// real contentHash H1.
		const v1 = `# original soul ${stamp}`;
		const { newHash: h1 } = await writeFile(request, token, agent.id, 'SOUL.md', v1);
		expect(h1).toMatch(HEX64);

		// Build an envelope FROM this agent, then mutate SOUL.md off-platform.
		const exportRes = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
			headers: authedHeaders(token),
		});
		expect(exportRes.status()).toBe(200);
		const envelope = (await exportRes.json()) as ExportEnvelope;
		const overwrittenSoul = `# overwritten soul ${stamp}`;
		envelope.files.soulMd = overwrittenSoul;

		// Import with onConflict=overwrite — same slug, applies the envelope onto
		// the EXISTING agent, and CRUCIALLY recomputes contentHash to match the
		// new file bodies (so the Instructions editor's optimistic-concurrency
		// doesn't permanently wedge on a stale hash after an import).
		const importRes = await request.post(
			`${API_BASE}/api/agents/import?onConflict=overwrite`,
			{ headers: authedHeaders(token), data: envelope },
		);
		expect(importRes.status(), `overwrite body=${await importRes.text().catch(() => '')}`).toBe(
			201,
		);
		const result = await importRes.json();
		expect(result.conflictResolution).toBe('overwritten');
		expect(result.finalSlug).toBe(envelope.identity.slug);

		// The overwrite landed on the SAME agent and bumped its hash off H1.
		const afterOverwrite = await readFile(request, token, agent.id, 'SOUL.md');
		expect(afterOverwrite.body).toBe(overwrittenSoul);
		expect(afterOverwrite.hash).toMatch(HEX64);
		expect(afterOverwrite.hash).not.toBe(h1);

		// Replaying the now-STALE H1 as expectedHash is rejected (proves the hash
		// really did move, not just the body).
		const stale = await putFileRaw(request, token, agent.id, 'SOUL.md', 'nope', h1);
		expect(stale.status()).toBe(400);
		expect((await stale.json()).message).toBe(CONFLICT_MESSAGE);

		// Reconciliation: carrying the LIVE post-overwrite hash succeeds — the
		// import correctly synced the ETag so editing resumes cleanly.
		const v2 = `# post-overwrite edit ${stamp}`;
		const { newHash: h2 } = await writeFile(
			request,
			token,
			agent.id,
			'SOUL.md',
			v2,
			afterOverwrite.hash,
		);
		expect(h2).toMatch(HEX64);
		expect(h2).not.toBe(afterOverwrite.hash);
		const final = await readFile(request, token, agent.id, 'SOUL.md');
		expect(final.body).toBe(v2);
		expect(final.hash).toBe(h2);
	});

	test('cross-user isolation: reading / writing / exporting another user\'s agent files all 404 with no existence leak', async ({
		request,
	}) => {
		// Owner authors a private agent with file content.
		const { access_token: ownerToken } = await registerUserViaAPI(request);
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, ownerToken, {
			name: `Private Agent ${stamp}`,
			scope: 'tenant',
		});
		const secretBody = `# private soul ${stamp}\nfor my eyes only`;
		await writeFile(request, ownerToken, agent.id, 'SOUL.md', secretBody);

		// A second, unrelated user.
		const { access_token: otherToken } = await registerUserViaAPI(request);

		const notFound = `Agent ${agent.id} not found.`;

		// READ → 404 (architecture/security §9: never 403, to avoid leaking that
		// the agent exists).
		const read = await request.get(`${API_BASE}/api/agents/${agent.id}/files/SOUL.md`, {
			headers: authedHeaders(otherToken),
		});
		expect(read.status()).toBe(404);
		const readJson = await read.json();
		expect(readJson.message).toBe(notFound);
		expect(readJson.statusCode).toBe(404);

		// WRITE → 404 (same shape; the body is well-formed so this is access,
		// not validation).
		const write = await putFileRaw(
			request,
			otherToken,
			agent.id,
			'SOUL.md',
			'hijack attempt',
		);
		expect(write.status()).toBe(404);
		expect((await write.json()).message).toBe(notFound);

		// EXPORT → 404 (the export service runs the same findByIdAndUser check).
		const exp = await request.get(`${API_BASE}/api/agents/${agent.id}/export`, {
			headers: authedHeaders(otherToken),
		});
		expect(exp.status()).toBe(404);
		expect((await exp.json()).message).toBe(notFound);

		// The owner can still read the untouched body — the attacker changed
		// nothing.
		const ownerRead = await readFile(request, ownerToken, agent.id, 'SOUL.md');
		expect(ownerRead.body).toBe(secretBody);
	});

	test('UI editor: round-trip a NON-SOUL file (agent.yml) and surface the parallel-edit CONFLICT banner', async ({
		page,
		request,
	}) => {
		// The Instructions page SSRs against the browser session (seeded user),
		// so the agent must be owned by the seeded user.
		const token = await seededToken(request);
		const stamp = Date.now().toString(36);
		const agent = await createAgentViaAPI(request, token, {
			name: `UI Deep Agent ${stamp}`,
			scope: 'tenant',
		});

		// Seed agent.yml so the non-default pill has persisted content to render.
		const seededYml = `name: ui-deep-${stamp}\nmodel: seed-model`;
		await writeFile(request, token, agent.id, 'agent.yml', seededYml);

		// Routes are unprefixed (next-intl localePrefix:'never').
		await page.goto(`/agents/${agent.id}/instructions`, { waitUntil: 'domcontentloaded' });

		// The editor defaults to the SOUL.md pill; wait for hydration via its
		// textarea, then switch to the agent.yml pill (retry the click — the
		// first pre-hydration click can be swallowed in dev).
		await expect(page.getByRole('textbox', { name: 'SOUL.md' })).toBeVisible({ timeout: 30_000 });
		const ymlPill = page.getByRole('button', { name: /agent\.yml/ });
		await expect(ymlPill).toBeVisible({ timeout: 30_000 });
		const ymlTextarea = page.getByRole('textbox', { name: 'agent.yml' });
		await expect(async () => {
			await ymlPill.click();
			await expect(ymlTextarea).toBeVisible({ timeout: 5_000 });
		}).toPass({ timeout: 30_000 });

		// The seeded agent.yml body renders into the editor.
		await expect
			.poll(async () => (await ymlTextarea.inputValue()) ?? '', { timeout: 30_000 })
			.toContain(`ui-deep-${stamp}`);

		// Edit through the controlled textarea via the native setter + dispatched
		// 'input' event (React's onChange listener) so the buffer becomes ONLY the
		// edit and the 800ms autosave fires cleanly.
		const editedYml = `name: ui-deep-${stamp}\nmodel: edited-in-browser\nrevision: 2`;
		await ymlTextarea.click();
		await ymlTextarea.evaluate((el, val) => {
			const node = el as HTMLTextAreaElement;
			const setter = Object.getOwnPropertyDescriptor(
				window.HTMLTextAreaElement.prototype,
				'value',
			)?.set;
			setter?.call(node, val);
			node.dispatchEvent(new Event('input', { bubbles: true }));
		}, editedYml);
		await expect
			.poll(async () => (await ymlTextarea.inputValue()) ?? '', { timeout: 10_000 })
			.toBe(editedYml);

		// Autosave success stamps a ✓ on the agent.yml pill.
		await expect(ymlPill).toContainText('✓', { timeout: 30_000 });

		// Authoritative cross-check: the API now holds the UI-entered agent.yml.
		await expect
			.poll(async () => (await readFile(request, token, agent.id, 'agent.yml')).body, {
				timeout: 30_000,
			})
			.toBe(editedYml);

		// ── Drive the CONFLICT banner ────────────────────────────────────────
		// The editor still holds the hash it knew at the last save. Mutate the
		// agent's content hash OUT-OF-BAND via the API (edit a DIFFERENT file —
		// the shared content hash advances, invalidating the editor's stored
		// agent.yml hash). The editor only re-sends on a fresh keystroke, so its
		// expectedHash is now stale → the next autosave conflicts.
		const apiSoul = await readFile(request, token, agent.id, 'SOUL.md');
		await writeFile(request, token, agent.id, 'SOUL.md', `# out of band ${stamp}`, apiSoul.hash);

		// Make another in-browser edit to agent.yml → autosave fires with the
		// now-stale expectedHash → 400 etag-mismatch → status 'conflict'.
		const conflictingYml = `${editedYml}\n# triggers a conflict`;
		await ymlTextarea.click();
		await ymlTextarea.evaluate((el, val) => {
			const node = el as HTMLTextAreaElement;
			const setter = Object.getOwnPropertyDescriptor(
				window.HTMLTextAreaElement.prototype,
				'value',
			)?.set;
			setter?.call(node, val);
			node.dispatchEvent(new Event('input', { bubbles: true }));
		}, conflictingYml);

		// The conflict surfaces two ways: the role="alert" banner AND a '!' marker
		// on the pill. Assert either (resilient to copy tweaks) — and confirm the
		// editor never falsely claims a save by stamping ✓ for this attempt.
		const banner = page.getByRole('alert').filter({ hasText: /parallel|refresh/i });
		await expect(banner.or(ymlPill.filter({ hasText: '!' })).first()).toBeVisible({
			timeout: 30_000,
		});

		// The conflicting body was rejected by the API — agent.yml still holds the
		// last SUCCESSFULLY-saved version, not the conflicting one.
		const ymlAfterConflict = await readFile(request, token, agent.id, 'agent.yml');
		expect(ymlAfterConflict.body).toBe(editedYml);
		expect(ymlAfterConflict.body).not.toBe(conflictingYml);
	});
});
