import 'reflect-metadata';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { GitFacadeService } from '../../facades/git.facade';
import { AgentsService } from '../agents.service';
import { AgentTemplatesService } from '../agent-templates.service';

/**
 * APW-04 T2 — the git facade reaches `AgentTemplatesService` by TOKEN, not by emitted type.
 *
 * ## The defect this pins
 *
 * The constructor declared `@Optional() git?: GitFacadeService` while the file imported the
 * class with `import type`. A type-only import has no value at run time, so BOTH compilers emit
 * `Object` as that parameter's `design:paramtypes` entry (the shipped
 * `packages/agent/dist/agents/agent-templates.service.js` reads
 * `typeof GitFacadeService === "undefined" ? Object : GitFacadeService`, and the name is
 * undefined there). Nothing provides `Object`, the parameter is `@Optional()`, so in the API
 * the service was always built without a git facade and the repo-template catalog read (plan
 * §7.1) never took its authenticated path, although `AgentsModule` imports `FacadesModule`
 * and the facade was right there. Found by the reviewer's whole-graph walk of
 * `apps/api/src/app-works-di-reachability.spec.ts`'s walker (2026-09-26).
 *
 * The token is now self-declared (`@Inject(GitFacadeService)`, a value import), which Nest
 * reads ahead of `design:paramtypes` — so the answer no longer depends on the compiler.
 */
describe('AgentTemplatesService — the git facade is injected by token', () => {
    it('declares GitFacadeService as the token of constructor[3]', () => {
        const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, AgentTemplatesService) ??
            []) as { index: number; param: unknown }[];

        expect(declared).toEqual(expect.arrayContaining([{ index: 3, param: GitFacadeService }]));
    });

    it('receives the git facade its module provides, when design:paramtypes says Object', async () => {
        // The shipped metadata, whatever this compiler emitted: `Object` for constructor[3].
        const emitted = Reflect.getMetadata('design:paramtypes', AgentTemplatesService) as
            | unknown[]
            | undefined;
        const shipped = [...(emitted ?? [])];
        shipped[3] = Object;
        Reflect.defineMetadata('design:paramtypes', shipped, AgentTemplatesService);

        const git = { getInstallationTokenForOwner: async () => null };

        @Module({
            providers: [
                AgentTemplatesService,
                { provide: AgentsService, useValue: {} },
                { provide: GitFacadeService, useValue: git },
            ],
        })
        class TemplatesHost {}

        try {
            const moduleRef = await Test.createTestingModule({
                imports: [TemplatesHost],
            }).compile();
            const service = moduleRef.get(AgentTemplatesService) as unknown as { git?: unknown };

            expect(service.git).toBe(git);
            await moduleRef.close();
        } finally {
            Reflect.defineMetadata('design:paramtypes', emitted, AgentTemplatesService);
        }
    });

    it('still builds without one — the tokenless public catalog read stays the fallback', async () => {
        @Module({
            providers: [AgentTemplatesService, { provide: AgentsService, useValue: {} }],
        })
        class TemplatesHostWithoutGit {}

        const moduleRef = await Test.createTestingModule({
            imports: [TemplatesHostWithoutGit],
        }).compile();
        const service = moduleRef.get(AgentTemplatesService) as unknown as { git?: unknown };

        expect(service.git).toBeUndefined();
        await moduleRef.close();
    });
});
