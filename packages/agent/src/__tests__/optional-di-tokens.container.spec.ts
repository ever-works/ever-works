import { Test } from '@nestjs/testing';
import { PLUGINS_MODULE_OPTIONS } from '../plugins/plugins.constants';
import { PluginInstallerService } from '../plugins/services/plugin-installer.service';
import { PluginRepository } from '../plugins/repositories/plugin.repository';
import { PluginAllowlistRepository } from '../plugins/repositories/plugin-allowlist.repository';
import { SafetyGateService } from '../safety/safety-gate.service';
import { AutonomyGrantService } from '../safety/autonomy-grant.service';
import { WorkspacePauseService } from '../safety/workspace-pause.service';
import { RailRefusalService } from '../safety/rail-refusal.service';
import { SafetyStateCache } from '../safety/safety-state.cache';
import {
    SAFETY_CAP_CHECK,
    SAFETY_GRANT_CHECK,
    SAFETY_RULE_CHECK,
    SAFETY_SCOPE_PAUSE,
} from '../safety/safety-rails';

/**
 * C-9 (Gauzy Ever Works #29) — `@Optional()` constructor parameters whose type the emitted
 * metadata erases to `Object` (a `X | null` union, an interface) were injected as `undefined` even
 * when the container could provide them. Resolved through a REAL Nest container here: a double
 * passed by hand would hide exactly that.
 */
describe('optional dependencies resolve by token in a real container (C-9)', () => {
    it('PluginInstallerService receives the provided PluginAllowlistRepository', async () => {
        const allowlist = { findByPackageName: jest.fn() };
        const moduleRef = await Test.createTestingModule({
            providers: [
                PluginInstallerService,
                { provide: PLUGINS_MODULE_OPTIONS, useValue: {} },
                { provide: PluginRepository, useValue: {} },
                { provide: PluginAllowlistRepository, useValue: allowlist },
            ],
        }).compile();

        const installer = moduleRef.get(PluginInstallerService) as unknown as {
            allowlistRepository: unknown;
        };
        expect(installer.allowlistRepository).toBe(allowlist);
    });

    it('PluginInstallerService still builds without one (the fail-closed refusal path)', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                PluginInstallerService,
                { provide: PLUGINS_MODULE_OPTIONS, useValue: {} },
                { provide: PluginRepository, useValue: {} },
            ],
        }).compile();

        const installer = moduleRef.get(PluginInstallerService) as unknown as {
            allowlistRepository: unknown;
        };
        expect(installer.allowlistRepository ?? null).toBeNull();
    });

    it('SafetyGateService receives each optional rail bound by its token', async () => {
        const rails = {
            scopePause: { isScopePaused: jest.fn() },
            grantCheck: { isToolAllowed: jest.fn() },
            capCheck: { isWithinCaps: jest.fn() },
            ruleCheck: { isRuleSatisfied: jest.fn() },
        };
        const moduleRef = await Test.createTestingModule({
            providers: [
                SafetyGateService,
                { provide: AutonomyGrantService, useValue: {} },
                { provide: WorkspacePauseService, useValue: {} },
                { provide: RailRefusalService, useValue: {} },
                { provide: SafetyStateCache, useValue: {} },
                { provide: SAFETY_SCOPE_PAUSE, useValue: rails.scopePause },
                { provide: SAFETY_GRANT_CHECK, useValue: rails.grantCheck },
                { provide: SAFETY_CAP_CHECK, useValue: rails.capCheck },
                { provide: SAFETY_RULE_CHECK, useValue: rails.ruleCheck },
            ],
        }).compile();

        const gate = moduleRef.get(SafetyGateService) as unknown as typeof rails;
        expect(gate.scopePause).toBe(rails.scopePause);
        expect(gate.grantCheck).toBe(rails.grantCheck);
        expect(gate.capCheck).toBe(rails.capCheck);
        expect(gate.ruleCheck).toBe(rails.ruleCheck);
    });
});
