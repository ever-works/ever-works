import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

/**
 * Phase 3 e2e — Agents controller smoke tests.
 *
 * Scaffolded but NOT run during /loop ticks. Operator will execute
 * with `cd apps/api && pnpm test:e2e` (or equivalent) after the
 * full feature lands. The bootstrap helper isn't wired here yet
 * (Phase 3 ships read-only controller; the app-bootstrap helper
 * with auth fixture is reused from the existing missions e2e —
 * we'll mirror that when the suite is run end-to-end).
 *
 * Test list (intent only; bodies stubbed):
 *   - POST /api/agents — create tenant Agent succeeds (201)
 *   - POST /api/agents — duplicate slug returns 409
 *   - POST /api/agents — mission scope without missionId returns 400
 *   - GET  /api/agents — lists my Agents only (cross-user 404 on detail)
 *   - GET  /api/agents/:id — non-existent returns 404 (not 403)
 *   - PATCH /api/agents/:id — updates capabilities
 *   - POST /api/agents/:id/pause — DRAFT → PAUSED rejected (400)
 *   - POST /api/agents/:id/pause — ACTIVE → PAUSED OK
 *   - DELETE /api/agents/:id — archives (status=ARCHIVED) by default
 *   - DELETE /api/agents/:id?hard=true — hard-deletes the row
 */
describe('AgentsController (e2e — scaffold)', () => {
	let app: INestApplication | undefined;
	let httpServer: any;

	beforeAll(async () => {
		// TODO: wire NestJS test app bootstrap (mirror missions e2e).
		// Suite intentionally skipped at the file level until the
		// shared bootstrap helper covers Agents migrations.
	});

	afterAll(async () => {
		await app?.close();
	});

	it.skip('POST /api/agents creates a tenant Agent', async () => {
		const res = await request(httpServer)
			.post('/api/agents')
			.set('Authorization', 'Bearer <test-token>')
			.send({ scope: 'tenant', name: 'CEO' })
			.expect(201);
		expect(res.body.slug).toBe('ceo');
		expect(res.body.status).toBe('draft');
	});

	it.skip('POST /api/agents — duplicate slug returns 409', async () => {
		await request(httpServer)
			.post('/api/agents')
			.set('Authorization', 'Bearer <test-token>')
			.send({ scope: 'tenant', name: 'CEO' })
			.expect(409);
	});

	it.skip('POST /api/agents — mission scope without missionId returns 400', async () => {
		await request(httpServer)
			.post('/api/agents')
			.set('Authorization', 'Bearer <test-token>')
			.send({ scope: 'mission', name: 'Researcher' })
			.expect(400);
	});

	it.skip('GET /api/agents/:id — cross-user returns 404 (not 403)', async () => {
		await request(httpServer)
			.get('/api/agents/00000000-0000-0000-0000-000000000000')
			.set('Authorization', 'Bearer <other-user-token>')
			.expect(404);
	});

	it.skip('DELETE /api/agents/:id default archives (no hard-delete)', async () => {
		await request(httpServer)
			.delete('/api/agents/agent-id')
			.set('Authorization', 'Bearer <test-token>')
			.expect(200)
			.expect((r) => expect(r.body.archived).toBe(true));
	});
});
