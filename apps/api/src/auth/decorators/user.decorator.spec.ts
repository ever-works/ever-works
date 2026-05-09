import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { CurrentUser } from './user.decorator';

/**
 * NestJS does not expose a documented public hook for unwrapping the function created by
 * `createParamDecorator`. The library convention used across the apps/api spec suite is to
 * apply the decorator to a parameter on a stub method, then walk back through the metadata
 * to retrieve the captured factory. We mirror that approach here: build a controller class,
 * attach `@CurrentUser()` to one of its parameters, and pull the registered factory off the
 * Nest `__routeArguments__` metadata so we can call it directly with a synthesised
 * ExecutionContext.
 */
function getCurrentUserFactory(): (data: unknown, ctx: ExecutionContext) => unknown {
    class TestController {
        // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-unused-vars
        handler(@CurrentUser() user: unknown) {}
    }

    // NestJS stores param decorator metadata under the `__routeArguments__` key. Each entry's
    // value is `{ index, factory, data, pipes }`. We just need the factory.
    const proto = TestController.prototype;
    const meta = Reflect.getMetadata('__routeArguments__', TestController, 'handler') as
        | Record<string, { factory: (data: unknown, ctx: ExecutionContext) => unknown }>
        | undefined;
    expect(meta).toBeDefined();
    const entry = Object.values(meta ?? {})[0];
    expect(typeof entry.factory).toBe('function');
    // Sanity: factory captured from the metadata is the same shape we re-export.
    expect(proto).toBeDefined();
    return entry.factory;
}

function makeContext(request: unknown): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => request,
        }),
    } as unknown as ExecutionContext;
}

describe('@CurrentUser() decorator', () => {
    let factory: (data: unknown, ctx: ExecutionContext) => unknown;

    beforeAll(() => {
        factory = getCurrentUserFactory();
    });

    it('returns request.user from the HTTP request object', () => {
        const user = { userId: 'u1', email: 'a@b.c' };
        const ctx = makeContext({ user });
        expect(factory(undefined, ctx)).toBe(user);
    });

    it('returns undefined when request.user is not set (unauthenticated context)', () => {
        const ctx = makeContext({});
        expect(factory(undefined, ctx)).toBeUndefined();
    });

    it('ignores the `data` argument (no key-path projection)', () => {
        // The decorator does not implement nested-property selection — passing `'userId'`
        // does NOT return only the userId, it still returns the whole user object. Pin the
        // current contract so a future "support sub-key access" refactor breaks loudly.
        const user = { userId: 'u1', email: 'a@b.c' };
        const ctx = makeContext({ user });
        expect(factory('userId', ctx)).toBe(user);
    });

    it('returns falsy primitives verbatim (no defensive coercion)', () => {
        expect(factory(undefined, makeContext({ user: null }))).toBeNull();
        expect(factory(undefined, makeContext({ user: 0 }))).toBe(0);
        expect(factory(undefined, makeContext({ user: '' }))).toBe('');
        expect(factory(undefined, makeContext({ user: false }))).toBe(false);
    });

    it('uses ctx.switchToHttp().getRequest() (not GraphQL/RPC)', () => {
        const getRequest = jest.fn().mockReturnValue({ user: { id: 'x' } });
        const switchToHttp = jest.fn().mockReturnValue({ getRequest });
        const ctx = { switchToHttp } as unknown as ExecutionContext;
        factory(undefined, ctx);
        expect(switchToHttp).toHaveBeenCalledTimes(1);
        expect(getRequest).toHaveBeenCalledTimes(1);
    });
});
