import type { WorkCodeUpdate } from '../../entities';

const TITLE_TRUNCATE_LEN = 64;

export function buildCodegenBranch(): string {
    return `ai/codegen-${Date.now()}`;
}

export function buildCommitTitle(record: Pick<WorkCodeUpdate, 'title' | 'prompt'>): string {
    return record.title ?? `AI: ${record.prompt.slice(0, TITLE_TRUNCATE_LEN)}`;
}

export function buildCommitMessage(record: WorkCodeUpdate): string {
    return `${buildCommitTitle(record)}\n\nRequested via Ever Works codegen (${record.id})`;
}

export function buildPullRequestBody(record: WorkCodeUpdate, summary: string): string {
    return [
        '## AI code update',
        '',
        `**Code update id:** ${record.id}`,
        `**Source:** ${record.source}`,
        `**Model:** ${record.aiModel ?? 'unspecified'}`,
        '',
        '### Prompt',
        '',
        record.prompt,
        '',
        '### Summary',
        '',
        summary,
        '',
        '---',
        '',
        'Review the diff and `Apply` / `Reject` from the Ever Works Codegen tab to merge or close this PR.',
    ].join('\n');
}
