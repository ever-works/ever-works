jest.mock('@ever-works/agent/database', () => ({
    ProductChangelogReadRepository: class ProductChangelogReadRepository {},
    UserRepository: class UserRepository {},
}));
// Stub the auth barrel so its transitive @ever-works/agent/database imports
// are not pulled into this controller test.
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));

import 'reflect-metadata';
import {
    BadRequestException,
    NotFoundException,
    RequestMethod,
    ValidationPipe,
} from '@nestjs/common';
import {
    GUARDS_METADATA,
    HEADERS_METADATA,
    METHOD_METADATA,
    PATH_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangelogController } from './changelog.controller';
import type { ChangelogService } from './changelog.service';
import { MarkChangelogReadDto } from './dto/mark-changelog-read.dto';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { AuthSessionGuard } from '../auth';

describe('ChangelogController', () => {
    const auth = {
        userId: 'user-1',
        email: 'u@e.test',
        username: 'u',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
    } as AuthenticatedUser;

    let service: jest.Mocked<
        Pick<ChangelogService, 'list' | 'getBySlug' | 'unreadCount' | 'markRead' | 'markAllRead'>
    >;
    let controller: ChangelogController;

    beforeEach(() => {
        service = {
            list: jest.fn(),
            getBySlug: jest.fn(),
            unreadCount: jest.fn(),
            markRead: jest.fn(),
            markAllRead: jest.fn(),
        };
        controller = new ChangelogController(service as unknown as ChangelogService);
    });

    const HANDLERS = ['list', 'unreadCount', 'getOne', 'markRead', 'markAllRead'] as const;
    const handler = (name: (typeof HANDLERS)[number]) =>
        ChangelogController.prototype[name] as unknown as (...args: unknown[]) => unknown;

    describe('wiring', () => {
        it('is mounted at api/changelog behind AuthSessionGuard (FR-32)', () => {
            expect(Reflect.getMetadata(PATH_METADATA, ChangelogController)).toBe('api/changelog');
            expect(Reflect.getMetadata(GUARDS_METADATA, ChangelogController)).toContain(
                AuthSessionGuard,
            );
        });

        it.each(HANDLERS)('%s sets Cache-Control: private, no-store', (name) => {
            expect(Reflect.getMetadata(HEADERS_METADATA, handler(name))).toContainEqual({
                name: 'Cache-Control',
                value: 'private, no-store',
            });
        });

        it.each([
            ['list', 120],
            ['unreadCount', 120],
            ['getOne', 120],
            ['markRead', 60],
            ['markAllRead', 10],
        ] as const)(
            '%s is throttled at %i requests per minute per person (FR-44)',
            (name, limit) => {
                expect(Reflect.getMetadata('THROTTLER:LIMITlong', handler(name))).toBe(limit);
                expect(Reflect.getMetadata('THROTTLER:TTLlong', handler(name))).toBe(60_000);
            },
        );

        it('routes match the documented surface', () => {
            const route = (name: (typeof HANDLERS)[number]) => [
                Reflect.getMetadata(METHOD_METADATA, handler(name)),
                Reflect.getMetadata(PATH_METADATA, handler(name)),
            ];
            expect(route('list')).toEqual([RequestMethod.GET, '/']);
            expect(route('unreadCount')).toEqual([RequestMethod.GET, 'unread-count']);
            expect(route('getOne')).toEqual([RequestMethod.GET, ':slug']);
            expect(route('markRead')).toEqual([RequestMethod.POST, 'read']);
            expect(route('markAllRead')).toEqual([RequestMethod.POST, 'read-all']);
        });

        it('declares GET unread-count before GET :slug so the count is never swallowed as a slug', () => {
            const order = Object.getOwnPropertyNames(ChangelogController.prototype);
            expect(order.indexOf('unreadCount')).toBeGreaterThan(-1);
            expect(order.indexOf('unreadCount')).toBeLessThan(order.indexOf('getOne'));
        });
    });

    describe('list', () => {
        it('passes a known category, the limit and the cursor through', async () => {
            const response = {
                entries: [],
                nextCursor: null,
                total: 0,
                unreadCount: 0,
                categoriesWithEntries: [],
            };
            service.list.mockResolvedValue(response);

            await expect(controller.list(auth, 'costs', 5, 'some-entry')).resolves.toBe(response);
            expect(service.list).toHaveBeenCalledWith('user-1', {
                category: 'costs',
                limit: 5,
                cursor: 'some-entry',
            });
        });

        it('treats an unknown category as All rather than erroring', async () => {
            service.list.mockResolvedValue({} as never);

            await controller.list(auth, 'not-a-category', 20, undefined);
            expect(service.list).toHaveBeenCalledWith('user-1', {
                category: undefined,
                limit: 20,
                cursor: undefined,
            });
        });

        it('rejects a malformed cursor', async () => {
            await expect(controller.list(auth, undefined, 20, '../etc')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(service.list).not.toHaveBeenCalled();
        });
    });

    describe('unreadCount', () => {
        it('wraps the count', async () => {
            service.unreadCount.mockResolvedValue(3);

            await expect(controller.unreadCount(auth)).resolves.toEqual({ count: 3 });
            expect(service.unreadCount).toHaveBeenCalledWith('user-1');
        });
    });

    describe('getOne (S-15)', () => {
        it('returns a visible entry', async () => {
            const dto = { slug: 'first-entry' } as never;
            service.getBySlug.mockResolvedValue(dto);

            await expect(controller.getOne(auth, 'first-entry')).resolves.toBe(dto);
        });

        it('404s identically for an absent entry, a scheduled entry and a malformed slug', async () => {
            service.getBySlug.mockResolvedValue(null);

            const absent = await controller.getOne(auth, 'never-existed').catch((error) => error);
            const scheduled = await controller
                .getOne(auth, 'scheduled-entry')
                .catch((error) => error);
            const malformed = await controller.getOne(auth, 'Not A Slug').catch((error) => error);

            for (const error of [absent, scheduled, malformed]) {
                expect(error).toBeInstanceOf(NotFoundException);
            }
            expect(scheduled.getResponse()).toEqual(absent.getResponse());
            expect(malformed.getResponse()).toEqual(absent.getResponse());
            // A malformed slug never reaches the service.
            expect(service.getBySlug).toHaveBeenCalledTimes(2);
        });
    });

    describe('markRead / markAllRead', () => {
        it('passes the slugs through and returns the fresh count', async () => {
            service.markRead.mockResolvedValue({ unreadCount: 1 });

            await expect(controller.markRead(auth, { slugs: ['first-entry'] })).resolves.toEqual({
                unreadCount: 1,
            });
            expect(service.markRead).toHaveBeenCalledWith('user-1', ['first-entry']);
        });

        it('marks everything read', async () => {
            service.markAllRead.mockResolvedValue({ unreadCount: 0 });

            await expect(controller.markAllRead(auth)).resolves.toEqual({ unreadCount: 0 });
            expect(service.markAllRead).toHaveBeenCalledWith('user-1');
        });
    });

    describe('MarkChangelogReadDto (FR-6, FR-17)', () => {
        const errorsFor = async (body: unknown) =>
            validate(plainToInstance(MarkChangelogReadDto, body) as object);

        it('accepts 1 to 25 well-formed slugs', async () => {
            expect(await errorsFor({ slugs: ['first-entry'] })).toHaveLength(0);
            expect(
                await errorsFor({ slugs: Array.from({ length: 25 }, (_, i) => `entry-${i}`) }),
            ).toHaveLength(0);
        });

        it.each([
            ['an empty array', { slugs: [] }],
            ['26 slugs', { slugs: Array.from({ length: 26 }, (_, i) => `entry-${i}`) }],
            ['an uppercase slug', { slugs: ['First-Entry'] }],
            ['a slug with a slash', { slugs: ['first/entry'] }],
            ['a too-short slug', { slugs: ['ab'] }],
            ['a non-string slug', { slugs: [42] }],
            ['a missing slugs field', {}],
        ])('rejects %s', async (_label, body) => {
            expect((await errorsFor(body)).length).toBeGreaterThan(0);
        });

        it('is rejected by the global ValidationPipe with extra fields', async () => {
            const pipe = new ValidationPipe({
                whitelist: true,
                transform: true,
                forbidNonWhitelisted: true,
            });
            await expect(
                pipe.transform(
                    { slugs: ['first-entry'], userId: 'someone-else' },
                    { type: 'body', metatype: MarkChangelogReadDto },
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });
});
