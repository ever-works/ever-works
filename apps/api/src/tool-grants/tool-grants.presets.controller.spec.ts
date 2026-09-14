// Same posture as `tool-grants.controller.spec.ts`: the agent barrels are
// stubbed because every dependency is injected as a stub below. Nothing about
// the controller's behaviour is mocked.
jest.mock('@ever-works/agent/policy', () => ({
    ToolGrantService: class {},
    ToolGrantRepository: class {},
}));
jest.mock('@ever-works/agent/services', () => ({ WorkOwnershipService: class {} }));
jest.mock('@ever-works/agent/facades', () => ({ ConnectionScopesFacadeService: class {} }));
jest.mock('@ever-works/agent/database', () => ({
    AgentRepository: class {},
    OrganizationRepository: class {},
    UserRepository: class {},
    AuthAccountRepository: class {},
    buildPluginProviderId: (id: string) => `plugin:${id}`,
}));

import 'reflect-metadata';
import {
    NotFoundException,
    RequestMethod,
    ServiceUnavailableException,
    ValidationPipe,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ToolGrantsController } from './tool-grants.controller';
import { ApplyToolGrantPresetDto, ToolGrantPresetStateQueryDto } from './dto/tool-grant.dto';

/**
 * AW-15 — the access-level preset routes on the tool-grant controller.
 *
 * The property that matters: a preset is a tool-grant write, so it passes
 * the SAME ownership gate as `PUT /api/tool-grants` before the preset service
 * is ever reached, and a foreign scope is a 404 (never a 403).
 */
describe('ToolGrantsController — access-level presets', () => {
    const auth = { userId: 'user-1' } as never;
    const AGENT = '00000000-0000-4000-8000-000000000001';
    const state = {
        providerId: 'github',
        scopeType: 'agent',
        scopeId: AGENT,
        presets: ['read', 'write'],
        requested: 'read',
        effective: 'read',
        clampedBy: null,
    };

    function make(
        overrides: { findAgent?: jest.Mock; ensureAccess?: jest.Mock; presets?: unknown } = {},
    ) {
        const presets =
            overrides.presets === undefined
                ? {
                      listProviders: jest.fn().mockResolvedValue([{ providerId: 'github' }]),
                      getState: jest.fn().mockResolvedValue(state),
                      apply: jest.fn().mockResolvedValue(state),
                  }
                : overrides.presets;
        const findAgent = overrides.findAgent ?? jest.fn().mockResolvedValue({ id: AGENT });
        const ensureAccess = overrides.ensureAccess ?? jest.fn().mockResolvedValue({});
        const controller = new ToolGrantsController(
            {} as never,
            { ensureAccess } as never,
            { findByIdAndUser: findAgent } as never,
            {
                findById: jest.fn().mockResolvedValue({ id: 'org-1', tenantId: 'tenant-1' }),
            } as never,
            {
                findById: jest.fn().mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1' }),
            } as never,
            presets as never,
        );
        return {
            controller,
            presets: presets as Record<string, jest.Mock>,
            findAgent,
            ensureAccess,
        };
    }

    it('lists the declaring providers', async () => {
        const { controller } = make();
        await expect(controller.listPresets()).resolves.toEqual({
            providers: [{ providerId: 'github' }],
        });
    });

    it('reads state for the AUTHENTICATED user after the scope gate', async () => {
        const { controller, presets, findAgent } = make();
        await controller.presetState(auth, {
            providerId: 'github',
            scopeType: 'agent',
            scopeId: AGENT,
        });
        expect(findAgent).toHaveBeenCalledWith(AGENT, 'user-1');
        expect(presets.getState).toHaveBeenCalledWith({
            userId: 'user-1',
            providerId: 'github',
            scopeType: 'agent',
            scopeId: AGENT,
        });
    });

    it('404s a foreign Agent without reaching the preset service', async () => {
        const { controller, presets } = make({ findAgent: jest.fn().mockResolvedValue(null) });
        await expect(
            controller.applyPreset(auth, {
                providerId: 'github',
                scopeType: 'agent',
                scopeId: AGENT,
                preset: 'read',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(presets.apply).not.toHaveBeenCalled();
    });

    it('gates a Work-scoped write through WorkOwnershipService', async () => {
        const ensureAccess = jest.fn().mockRejectedValue(new NotFoundException('nope'));
        const { controller, presets } = make({ ensureAccess });
        await expect(
            controller.applyPreset(auth, {
                providerId: 'github',
                scopeType: 'work',
                scopeId: AGENT,
                preset: 'read',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(presets.apply).not.toHaveBeenCalled();
    });

    it('applies for the authenticated user and returns the state', async () => {
        const { controller, presets } = make();
        const result = await controller.applyPreset(auth, {
            providerId: 'github',
            scopeType: 'agent',
            scopeId: AGENT,
            preset: 'read',
        });
        expect(presets.apply).toHaveBeenCalledWith(
            { userId: 'user-1', providerId: 'github', scopeType: 'agent', scopeId: AGENT },
            'read',
        );
        expect(result).toEqual(state);
    });

    it('answers 503 rather than crashing when the preset service is not bound', async () => {
        const { controller } = make({ presets: null });
        await expect(controller.listPresets()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('routes and throttles as documented', () => {
        const proto = ToolGrantsController.prototype as unknown as Record<string, object>;
        expect(Reflect.getMetadata(PATH_METADATA, proto.listPresets)).toBe('presets');
        expect(Reflect.getMetadata(METHOD_METADATA, proto.listPresets)).toBe(RequestMethod.GET);
        expect(Reflect.getMetadata(PATH_METADATA, proto.presetState)).toBe('presets/state');
        expect(Reflect.getMetadata(PATH_METADATA, proto.applyPreset)).toBe('presets');
        expect(Reflect.getMetadata(METHOD_METADATA, proto.applyPreset)).toBe(RequestMethod.PUT);
        const throttleKeys = Reflect.getMetadataKeys(proto.applyPreset).filter((key) =>
            String(key).startsWith('THROTTLER'),
        );
        expect(throttleKeys.length).toBeGreaterThan(0);
    });

    describe('DTO validation', () => {
        const pipe = new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        });

        async function validate(metatype: new () => object, value: Record<string, unknown>) {
            return pipe.transform(value, { type: 'body', metatype });
        }

        it('accepts only read/write', async () => {
            const base = { providerId: 'github', scopeType: 'agent', scopeId: AGENT };
            await expect(
                validate(ApplyToolGrantPresetDto, { ...base, preset: 'read' }),
            ).resolves.toBeDefined();
            await expect(
                validate(ApplyToolGrantPresetDto, { ...base, preset: 'admin' }),
            ).rejects.toBeDefined();
            await expect(
                validate(ApplyToolGrantPresetDto, { ...base, preset: 'blocked' }),
            ).rejects.toBeDefined();
        });

        it('rejects a malformed provider id and a non-uuid scope id', async () => {
            await expect(
                validate(ToolGrantPresetStateQueryDto, {
                    providerId: '../etc',
                    scopeType: 'agent',
                    scopeId: AGENT,
                }),
            ).rejects.toBeDefined();
            await expect(
                validate(ToolGrantPresetStateQueryDto, {
                    providerId: 'github',
                    scopeType: 'agent',
                    scopeId: 'nope',
                }),
            ).rejects.toBeDefined();
            await expect(
                validate(ToolGrantPresetStateQueryDto, {
                    providerId: 'github',
                    scopeType: 'team',
                    scopeId: AGENT,
                }),
            ).rejects.toBeDefined();
        });
    });
});
