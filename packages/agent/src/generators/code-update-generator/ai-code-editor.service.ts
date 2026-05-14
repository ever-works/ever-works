import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AiCodeEditResult } from './types';

/**
 * AiCodeEditorService is the seam between CodeUpdateGeneratorService and the
 * actual model invocation. The MVP writes a CODE_UPDATE_REQUEST.md file in
 * the workspace and returns a placeholder diff, so the surrounding flow
 * (PR, preview deploy, apply/reject, rollback) ships end-to-end while the
 * full claude-code editor lands as a follow-up.
 *
 * Replacing this service body with a real `claude --print` subprocess (or a
 * direct AiFacade call) needs no other changes — same contract.
 */
@Injectable()
export class AiCodeEditorService {
    private readonly logger = new Logger(AiCodeEditorService.name);

    async apply(opts: {
        workspaceDir: string;
        prompt: string;
        model?: string;
    }): Promise<AiCodeEditResult> {
        const requestFile = path.join(opts.workspaceDir, 'CODE_UPDATE_REQUEST.md');
        const body = [
            '# AI code update request',
            '',
            `**Model:** ${opts.model ?? 'unspecified'}`,
            `**Generated:** ${new Date().toISOString()}`,
            '',
            '## Prompt',
            '',
            opts.prompt,
            '',
            '> Code edits will be applied here once the `claude-code` code-edit',
            '> mode lands. This file is a placeholder so reviewers can see the',
            '> proposal flow end-to-end.',
            '',
        ].join('\n');

        await fs.writeFile(requestFile, body, 'utf-8');
        this.logger.log(`Wrote CODE_UPDATE_REQUEST.md in ${opts.workspaceDir}`);

        return {
            summary: `Recorded code update request (MVP placeholder). Prompt: ${opts.prompt.slice(0, 120)}`,
            diff: [{ path: 'CODE_UPDATE_REQUEST.md', status: 'added' }],
        };
    }
}
