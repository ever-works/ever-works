import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
    EnableUserPluginDto,
    EnableWorkPluginDto,
    SetActiveCapabilityDto,
    SetGlobalPipelineDefaultDto,
    UpdateUserPluginSettingsDto,
    UpdateWorkPluginPriorityDto,
    UpdateWorkPluginSettingsDto,
} from './update-plugin-settings.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('plugins update-plugin-settings DTOs validation', () => {
    describe('UpdateUserPluginSettingsDto', () => {
        it('accepts an empty payload (every field optional)', async () => {
            const dto = plainToInstance(UpdateUserPluginSettingsDto, {});
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a fully populated payload', async () => {
            const dto = plainToInstance(UpdateUserPluginSettingsDto, {
                settings: { foo: 'bar' },
                secretSettings: { apiKey: 'sk-abc' },
                metadata: { version: 1 },
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-object settings via @IsObject', async () => {
            const dto = plainToInstance(UpdateUserPluginSettingsDto, {
                settings: 'string-not-allowed' as unknown as Record<string, unknown>,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'settings').isObject).toBeDefined();
        });

        it('rejects array secretSettings via @IsObject (arrays are not plain objects here)', async () => {
            const dto = plainToInstance(UpdateUserPluginSettingsDto, {
                secretSettings: [] as unknown as Record<string, unknown>,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'secretSettings').isObject).toBeDefined();
        });

        it('rejects non-object metadata via @IsObject', async () => {
            const dto = plainToInstance(UpdateUserPluginSettingsDto, {
                metadata: 42 as unknown as Record<string, unknown>,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'metadata').isObject).toBeDefined();
        });
    });

    describe('EnableUserPluginDto', () => {
        it('accepts an empty payload', async () => {
            const dto = plainToInstance(EnableUserPluginDto, {});
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a fully valid payload', async () => {
            const dto = plainToInstance(EnableUserPluginDto, {
                settings: {},
                secretSettings: {},
                autoEnableForWorks: true,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-boolean autoEnableForWorks via @IsBoolean', async () => {
            const dto = plainToInstance(EnableUserPluginDto, {
                autoEnableForWorks: 'yes' as unknown as boolean,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'autoEnableForWorks').isBoolean).toBeDefined();
        });
    });

    describe('UpdateWorkPluginSettingsDto', () => {
        it('accepts an empty payload', async () => {
            const dto = plainToInstance(UpdateWorkPluginSettingsDto, {});
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-object settings via @IsObject', async () => {
            const dto = plainToInstance(UpdateWorkPluginSettingsDto, {
                settings: 'oops' as unknown as Record<string, unknown>,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'settings').isObject).toBeDefined();
        });
    });

    describe('EnableWorkPluginDto', () => {
        it('accepts an empty payload (every field optional)', async () => {
            const dto = plainToInstance(EnableWorkPluginDto, {});
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts valid activeCapability "ai-provider"', async () => {
            const dto = plainToInstance(EnableWorkPluginDto, {
                activeCapability: 'ai-provider',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects unknown activeCapability via IsValidCapabilityConstraint', async () => {
            const dto = plainToInstance(EnableWorkPluginDto, {
                activeCapability: 'definitely-not-a-capability',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'activeCapability').isValidCapability).toBeDefined();
        });

        it('rejects non-numeric priority via @IsNumber', async () => {
            const dto = plainToInstance(EnableWorkPluginDto, {
                priority: 'high' as unknown as number,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'priority').isNumber).toBeDefined();
        });

        it('rejects negative priority via @Min(0)', async () => {
            const dto = plainToInstance(EnableWorkPluginDto, { priority: -1 });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'priority').min).toBeDefined();
        });

        it('accepts priority of 0 (boundary)', async () => {
            const dto = plainToInstance(EnableWorkPluginDto, { priority: 0 });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('SetActiveCapabilityDto', () => {
        it('accepts a known capability "search"', async () => {
            const dto = plainToInstance(SetActiveCapabilityDto, { capability: 'search' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing capability via @IsString', async () => {
            const dto = plainToInstance(SetActiveCapabilityDto, {});
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'capability').isString).toBeDefined();
        });

        it('rejects unknown capability via IsValidCapabilityConstraint', async () => {
            const dto = plainToInstance(SetActiveCapabilityDto, { capability: 'unknown-cap' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'capability').isValidCapability).toBeDefined();
        });
    });

    describe('UpdateWorkPluginPriorityDto', () => {
        it('accepts a positive priority', async () => {
            const dto = plainToInstance(UpdateWorkPluginPriorityDto, { priority: 5 });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts priority=0 boundary', async () => {
            const dto = plainToInstance(UpdateWorkPluginPriorityDto, { priority: 0 });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing priority via @IsNumber', async () => {
            const dto = plainToInstance(UpdateWorkPluginPriorityDto, {});
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'priority').isNumber).toBeDefined();
        });

        it('rejects negative priority via @Min(0)', async () => {
            const dto = plainToInstance(UpdateWorkPluginPriorityDto, { priority: -1 });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'priority').min).toBeDefined();
        });
    });

    describe('SetGlobalPipelineDefaultDto', () => {
        it('accepts a fully valid payload with pluginId and enforce', async () => {
            const dto = plainToInstance(SetGlobalPipelineDefaultDto, {
                pluginId: 'standard-pipeline',
                enforce: true,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts an undefined pluginId (optional clears the default)', async () => {
            const dto = plainToInstance(SetGlobalPipelineDefaultDto, { enforce: false });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a null pluginId — @IsOptional short-circuits both null AND undefined, allowing callers to clear the default', async () => {
            const dto = plainToInstance(SetGlobalPipelineDefaultDto, {
                pluginId: null,
                enforce: false,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string pluginId via @IsString (only null/undefined skipped)', async () => {
            const dto = plainToInstance(SetGlobalPipelineDefaultDto, {
                pluginId: 42 as unknown as string,
                enforce: false,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'pluginId').isString).toBeDefined();
        });

        it('rejects missing enforce via @IsBoolean', async () => {
            const dto = plainToInstance(SetGlobalPipelineDefaultDto, {
                pluginId: 'standard-pipeline',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'enforce').isBoolean).toBeDefined();
        });

        it('rejects non-boolean enforce via @IsBoolean', async () => {
            const dto = plainToInstance(SetGlobalPipelineDefaultDto, {
                enforce: 'true' as unknown as boolean,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'enforce').isBoolean).toBeDefined();
        });
    });
});
