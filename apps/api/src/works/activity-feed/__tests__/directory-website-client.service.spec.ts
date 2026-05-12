// Mock agent-package barrels so the test doesn't pull TypeORM entity trees.
jest.mock('@ever-works/agent/services', () => ({
    PlatformSyncSecretService: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    Work: class {},
}));

import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import type { AxiosError, AxiosResponse } from 'axios';
import type { PlatformSyncSecretService } from '@ever-works/agent/services';
import { DirectoryWebsiteClient } from '../directory-website-client.service';

type HttpMock = { get: jest.Mock };

interface WorkLike {
    id: string;
    website: string | null;
    platformSyncEnabled: boolean;
    platformSyncSecretEncrypted: string | null;
    platformSyncLastSuccessAt?: Date | null;
}

function makeWork(overrides: Partial<WorkLike> = {}): WorkLike {
    return {
        id: 'work-1',
        website: 'https://demo.example.com',
        platformSyncEnabled: true,
        platformSyncSecretEncrypted: 'envelope-base64',
        ...overrides,
    };
}

function makeAxiosError(overrides: Partial<AxiosError>): AxiosError {
    return Object.assign(new Error('axios') as AxiosError, overrides);
}

function makeResponse(data: unknown): AxiosResponse {
    return { data, status: 200, statusText: 'OK', headers: {}, config: {} as never };
}

describe('DirectoryWebsiteClient', () => {
    let httpService: HttpMock;
    let secretService: jest.Mocked<Pick<PlatformSyncSecretService, 'decryptForWork'>>;
    let client: DirectoryWebsiteClient;

    beforeEach(() => {
        httpService = { get: jest.fn() };
        secretService = { decryptForWork: jest.fn() } as never;
        client = new DirectoryWebsiteClient(
            httpService as unknown as HttpService,
            secretService as unknown as PlatformSyncSecretService,
        );
    });

    describe('preconditions', () => {
        it('returns degraded:disabled when platformSyncEnabled is false', async () => {
            const work = makeWork({ platformSyncEnabled: false });
            const result = await client.fetchActivityFeed(work as never, {
                limit: 50,
                types: ['all'],
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(
                    (result as { ok: false; degraded: { reason: string } }).degraded.reason,
                ).toBe('disabled');
            expect(httpService.get).not.toHaveBeenCalled();
        });

        it('returns degraded:not_provisioned when work has no website URL', async () => {
            const work = makeWork({ website: null });
            const result = await client.fetchActivityFeed(work as never, {
                limit: 50,
                types: ['all'],
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(
                    (result as { ok: false; degraded: { reason: string } }).degraded.reason,
                ).toBe('not_provisioned');
        });

        it('returns degraded:not_provisioned when secret is null', async () => {
            secretService.decryptForWork.mockReturnValue(null);
            const result = await client.fetchActivityFeed(makeWork() as never, {
                limit: 50,
                types: ['all'],
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(
                    (result as { ok: false; degraded: { reason: string } }).degraded.reason,
                ).toBe('not_provisioned');
        });

        it('returns degraded:parse_error when secret decryption throws', async () => {
            secretService.decryptForWork.mockImplementation(() => {
                throw new Error('bad envelope');
            });
            const result = await client.fetchActivityFeed(makeWork() as never, {
                limit: 50,
                types: ['all'],
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(
                    (result as { ok: false; degraded: { reason: string } }).degraded.reason,
                ).toBe('parse_error');
        });
    });

    describe('happy path', () => {
        it('signs the request, fetches, and maps entries with correct categories', async () => {
            secretService.decryptForWork.mockReturnValue('a'.repeat(64));
            httpService.get.mockReturnValue(
                of(
                    makeResponse({
                        entries: [
                            {
                                id: 'u-1',
                                type: 'user_registered',
                                timestamp: '2026-05-12T10:00:00.000Z',
                                summary: 'Maria signed up',
                                actor: { id: 'u-1', name: 'Maria' },
                                target: {
                                    id: 'u-1',
                                    type: 'user',
                                    name: 'Maria',
                                    adminUrl: '/admin/users/u-1',
                                },
                            },
                            {
                                id: 'i-7',
                                type: 'item_created',
                                timestamp: '2026-05-12T09:00:00.000Z',
                                summary: 'New item submitted',
                                actor: null,
                                target: {
                                    id: 'i-7',
                                    type: 'item',
                                    name: 'Cool Tool',
                                    adminUrl: '/admin/items/i-7',
                                },
                            },
                        ],
                        nextCursor: '2026-05-12T08:00:00.000Z',
                        serverTime: new Date().toISOString(),
                    }),
                ),
            );

            const result = await client.fetchActivityFeed(makeWork() as never, {
                limit: 50,
                types: ['all'],
                since: '2026-05-10T00:00:00.000Z',
            });

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.entries).toHaveLength(2);
            expect(result.entries[0].source).toBe('directory-site');
            expect(result.entries[0].category).toBe('users');
            expect(result.entries[1].category).toBe('submissions');
            expect(result.nextCursor).toBe('2026-05-12T08:00:00.000Z');

            // Verify signing headers are present.
            const headers = httpService.get.mock.calls[0][1].headers;
            expect(headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
            expect(headers['x-platform-ts']).toBeDefined();
            expect(headers['User-Agent']).toMatch(/ever-works-platform/);
        });

        it('strips trailing slash from website URL', async () => {
            secretService.decryptForWork.mockReturnValue('a'.repeat(64));
            httpService.get.mockReturnValue(
                of(makeResponse({ entries: [], serverTime: new Date().toISOString() })),
            );
            await client.fetchActivityFeed(
                makeWork({ website: 'https://demo.example.com/' }) as never,
                { limit: 50, types: ['all'] },
            );
            const url = httpService.get.mock.calls[0][0] as string;
            expect(url).toMatch(/^https:\/\/demo\.example\.com\/api\/platform\/activity-feed/);
            expect(url.startsWith('https://demo.example.com//')).toBe(false);
        });
    });

    describe('error translation', () => {
        beforeEach(() => {
            secretService.decryptForWork.mockReturnValue('a'.repeat(64));
        });

        it('translates 401 into degraded:unauthorized without retrying', async () => {
            httpService.get.mockReturnValue(
                throwError(() =>
                    makeAxiosError({ response: { status: 401 } as never, message: 'Unauthorized' }),
                ),
            );
            const result = await client.fetchActivityFeed(makeWork() as never, {
                limit: 50,
                types: ['all'],
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(
                    (result as { ok: false; degraded: { reason: string } }).degraded.reason,
                ).toBe('unauthorized');
            expect(httpService.get).toHaveBeenCalledTimes(1);
        });

        it('translates timeout into degraded:timeout', async () => {
            httpService.get.mockReturnValue(
                throwError(() => makeAxiosError({ code: 'ECONNABORTED', message: 'timeout' })),
            );
            const result = await client.fetchActivityFeed(makeWork() as never, {
                limit: 50,
                types: ['all'],
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(
                    (result as { ok: false; degraded: { reason: string } }).degraded.reason,
                ).toBe('timeout');
        });

        it('retries once on 5xx then returns upstream_5xx', async () => {
            httpService.get.mockReturnValue(
                throwError(() =>
                    makeAxiosError({ response: { status: 503 } as never, message: 'unavailable' }),
                ),
            );
            const result = await client.fetchActivityFeed(makeWork() as never, {
                limit: 50,
                types: ['all'],
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(
                    (result as { ok: false; degraded: { reason: string } }).degraded.reason,
                ).toBe('upstream_5xx');
            expect(httpService.get).toHaveBeenCalledTimes(2);
        });

        it('rejects responses with malformed shape', async () => {
            httpService.get.mockReturnValue(of(makeResponse({ entries: 'not-an-array' })));
            const result = await client.fetchActivityFeed(makeWork() as never, {
                limit: 50,
                types: ['all'],
            });
            expect(result.ok).toBe(false);
            if (!result.ok)
                expect(
                    (result as { ok: false; degraded: { reason: string } }).degraded.reason,
                ).toBe('parse_error');
        });
    });
});
