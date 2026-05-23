import { Injectable } from '@nestjs/common';
import type {
    IKbToolsFacade,
    IKbToolsFacadeSearchInput,
    IKbToolsFacadeWriteInput,
    KbToolFacadeResult,
} from '@ever-works/plugin';
import { KbAgentToolsService } from './kb-agent-tools.service';
import type {
    KbSearchToolInput,
    KbWriteToolInput,
} from './kb-agent-tools.service';

/**
 * EW-641 Phase 2/d row 36c — bridges `@ever-works/plugin`'s
 * `IKbToolsFacade` to the NestJS-side `KbAgentToolsService` (row 36).
 *
 * Why a separate adapter:
 *  - `KbAgentToolsService` is a NestJS @Injectable wired into
 *    `KnowledgeBaseModule`. The agent-pipeline plugin (and any other
 *    plugin in `packages/plugins/`) runs in plain-object world — no
 *    DI container — so it can't depend on `KbAgentToolsService`
 *    directly.
 *  - The adapter exposes only the interface surface declared in
 *    `@ever-works/plugin`. Pipeline plugins consume it via
 *    `StepExecutionContext.kbTools`; the row 36b
 *    `createKbTools(ctx)` factory builds Vercel-AI-SDK
 *    `tool({ description, inputSchema, execute })` definitions
 *    whose `execute` callbacks delegate to this facade.
 *
 * The adapter is a 1:1 method-name-mapping shim — every method just
 * forwards to the corresponding `KbAgentToolsService` method. Kept
 * as a thin layer so the row-36 service can evolve without breaking
 * the plugin contract.
 *
 * Permission gates (`ensureCanView` / `ensureCanEdit` / manager+ for
 * lock/unlock) live in `KnowledgeBaseService` two layers down; the
 * adapter doesn't re-implement them.
 */
@Injectable()
export class KbToolsFacadeAdapter implements IKbToolsFacade {
    constructor(private readonly kbAgentTools: KbAgentToolsService) {}

    kbSearch(
        workId: string,
        userId: string,
        input: IKbToolsFacadeSearchInput,
    ): Promise<KbToolFacadeResult<{ items: ReadonlyArray<unknown>; total: number }>> {
        // The plugin-side interface uses string-union `class` / `status`
        // for LLM friendliness. The agent-side service expects the
        // contracts enum types. Cast at the boundary per cumulative
        // gotcha #5 (KbDocumentClass enum vs contracts string-union).
        return this.kbAgentTools.kbSearch(workId, userId, input as KbSearchToolInput);
    }

    kbRead(workId: string, userId: string, idOrPath: string): Promise<KbToolFacadeResult<unknown>> {
        return this.kbAgentTools.kbRead(workId, userId, idOrPath);
    }

    kbWrite(
        workId: string,
        userId: string,
        input: IKbToolsFacadeWriteInput,
    ): Promise<KbToolFacadeResult<{ document: unknown; action: 'created' | 'updated' }>> {
        // Same cast-at-boundary story as kbSearch for `class`.
        return this.kbAgentTools.kbWrite(workId, userId, input as KbWriteToolInput);
    }

    kbLock(
        workId: string,
        userId: string,
        docId: string,
        mode: 'full' | 'additions-only',
    ): Promise<KbToolFacadeResult<unknown>> {
        return this.kbAgentTools.kbLock(workId, userId, docId, mode);
    }

    kbUnlock(workId: string, userId: string, docId: string): Promise<KbToolFacadeResult<unknown>> {
        return this.kbAgentTools.kbUnlock(workId, userId, docId);
    }
}
