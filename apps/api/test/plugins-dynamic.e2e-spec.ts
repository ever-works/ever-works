import { HttpException, HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PluginsController } from '../src/plugins/plugins.controller';
import { PluginCatalogService } from '../src/plugins/plugin-catalog.service';
import { PluginValidationService } from '../src/plugins/plugin-validation.service';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { PluginOperationsService, PluginInstallerService } from '@ever-works/agent/plugins';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { AuthSessionGuard } from '../src/auth';

/**
 * EW-693 / T24 — Controller-level integration tests for the dynamic
 * plugin distribution endpoints.
 *
 * Mocks `PluginInstallerService` + `PluginCatalogService` so the
 * suite proves the HTTP wiring (status codes, body shape,
 * 409/424/502 propagation, idempotency) without standing up the
 * full app, real DB, or real registry. The end-to-end "install →
 * enable → use" path lives in the unit installer suite (Phase 5)
 * and the bundled-mode `enablePluginForUser` path; the wiring here
 * is what ties the two together.
 *
 * `AuthSessionGuard` is overridden to a permissive guard so we
 * don't have to mint JWTs for controller-shape verification.
 */
describe('PluginsController (EW-693 dynamic distribution)', () => {
    let app: INestApplication;
    let installer: jest.Mocked<PluginInstallerService>;
    let catalog: jest.Mocked<PluginCatalogService>;

    const baseInstallState = (overrides: Partial<{ pluginId: string; installState: string }>) =>
        ({
            pluginId: 'notion-extractor',
            installState: 'installed',
            source: 'registry',
            registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
            installedVersion: '1.2.0',
            integrity: 'sha512-x',
            updatedAt: new Date('2026-06-03').toISOString(),
            ...overrides,
        } as never);

    beforeEach(async () => {
        installer = {
            install: jest.fn(),
            uninstall: jest.fn(),
            ensurePluginAvailable: jest.fn(),
            warmupFromDb: jest.fn(),
            getDistributionMode: jest.fn(() => 'dynamic'),
            getInstallDir: jest.fn(() => '/tmp/ew693'),
        } as unknown as jest.Mocked<PluginInstallerService>;

        catalog = {
            listCatalog: jest.fn(),
            getInstallState: jest.fn(),
        } as unknown as jest.Mocked<PluginCatalogService>;

        const module: TestingModule = await Test.createTestingModule({
            controllers: [PluginsController],
            providers: [
                { provide: PluginOperationsService, useValue: {} },
                { provide: WorkOwnershipService, useValue: {} },
                { provide: PluginValidationService, useValue: {} },
                { provide: ActivityLogService, useValue: { log: jest.fn() } },
                { provide: PluginCatalogService, useValue: catalog },
                { provide: PluginInstallerService, useValue: installer },
            ],
        })
            .overrideGuard(AuthSessionGuard)
            .useValue({ canActivate: () => true })
            .compile();

        app = module.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
        await app.init();
    });

    afterEach(async () => {
        await app?.close();
    });

    describe('GET /api/plugins/catalog', () => {
        it('returns the catalog with install state merged', async () => {
            catalog.listCatalog.mockResolvedValueOnce({
                entries: [
                    {
                        pluginId: 'notion-extractor',
                        name: 'Notion Extractor',
                        description: 'Pull pages from Notion',
                        category: 'content-extractor',
                        capabilities: ['content-extractor'],
                        version: '1.2.0',
                        distribution: 'registry',
                        packageName: '@ever-works/notion-extractor-plugin',
                        install: baseInstallState({ installState: 'available' }),
                    },
                ],
                fetchedAt: '2026-06-03T00:00:00.000Z',
                degraded: false,
            });

            const res = await request(app.getHttpServer()).get('/api/plugins/catalog').expect(200);

            expect(res.body.entries).toHaveLength(1);
            expect(res.body.entries[0].pluginId).toBe('notion-extractor');
            expect(res.body.entries[0].install.installState).toBe('available');
        });
    });

    describe('POST /api/plugins/:id/install', () => {
        it('returns 200 with the post-install state on happy path', async () => {
            installer.install.mockResolvedValueOnce({
                pluginId: 'notion-extractor',
                packageName: '@ever-works/notion-extractor-plugin',
                version: '1.2.0',
                integrity: 'sha512-x',
                installPath: '/tmp/ew693/node_modules/@ever-works/notion-extractor-plugin',
                registrySpec: '@ever-works/notion-extractor-plugin@1.2.0',
            });
            catalog.getInstallState.mockResolvedValueOnce(
                baseInstallState({ installState: 'installed' }),
            );

            const res = await request(app.getHttpServer())
                .post('/api/plugins/notion-extractor/install')
                .send({ version: '1.2.0', integrity: 'sha512-x' })
                .expect(200);

            expect(res.body.pluginId).toBe('notion-extractor');
            expect(res.body.install.installState).toBe('installed');
            expect(installer.install).toHaveBeenCalledWith({
                pluginId: 'notion-extractor',
                version: '1.2.0',
                integrity: 'sha512-x',
                source: undefined,
            });
        });

        it('propagates 409 for non-allowlisted (FR-11)', async () => {
            installer.install.mockRejectedValueOnce(
                new HttpException(
                    { statusCode: 409, message: 'not permitted' },
                    HttpStatus.CONFLICT,
                ),
            );
            await request(app.getHttpServer())
                .post('/api/plugins/cool-plugin/install')
                .send({})
                .expect(409);
        });

        it('propagates 424 on integrity mismatch (FR-10)', async () => {
            installer.install.mockRejectedValueOnce(
                new HttpException(
                    { statusCode: 424, message: 'integrity mismatch' },
                    HttpStatus.FAILED_DEPENDENCY,
                ),
            );
            await request(app.getHttpServer())
                .post('/api/plugins/notion-extractor/install')
                .send({ integrity: 'sha512-wrong' })
                .expect(424);
        });

        it('propagates 502 when the registry fails', async () => {
            installer.install.mockRejectedValueOnce(
                new HttpException(
                    { statusCode: 502, message: 'registry down' },
                    HttpStatus.BAD_GATEWAY,
                ),
            );
            await request(app.getHttpServer())
                .post('/api/plugins/notion-extractor/install')
                .send({})
                .expect(502);
        });

        it('rejects payloads with unknown source values via class-validator', async () => {
            await request(app.getHttpServer())
                .post('/api/plugins/notion-extractor/install')
                .send({ source: 'jfrog' })
                .expect(400);
            expect(installer.install).not.toHaveBeenCalled();
        });
    });

    describe('GET /api/plugins/:id/install-status', () => {
        it('returns 404 when the plugin row is absent', async () => {
            catalog.getInstallState.mockResolvedValueOnce(null);
            await request(app.getHttpServer())
                .get('/api/plugins/notion-extractor/install-status')
                .expect(404);
        });

        it('returns the install-state row when present', async () => {
            catalog.getInstallState.mockResolvedValueOnce(
                baseInstallState({ installState: 'installing' }),
            );
            const res = await request(app.getHttpServer())
                .get('/api/plugins/notion-extractor/install-status')
                .expect(200);
            expect(res.body.installState).toBe('installing');
        });
    });

    describe('DELETE /api/plugins/:id/install', () => {
        it('refuses with 409 for systemPlugin / bundled plugins (T20)', async () => {
            installer.uninstall.mockRejectedValueOnce(
                new HttpException(
                    { statusCode: 409, message: 'core plugin' },
                    HttpStatus.CONFLICT,
                ),
            );
            await request(app.getHttpServer())
                .delete('/api/plugins/local-fs/install')
                .expect(409);
        });

        it('returns the post-uninstall available state for a non-core plugin', async () => {
            installer.uninstall.mockResolvedValueOnce(undefined);
            catalog.getInstallState.mockResolvedValueOnce(
                baseInstallState({ installState: 'available' }),
            );
            const res = await request(app.getHttpServer())
                .delete('/api/plugins/notion-extractor/install')
                .expect(200);
            expect(res.body.installState).toBe('available');
        });
    });
});
