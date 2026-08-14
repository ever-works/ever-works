import {
    createGetSkillFileTool,
    isTextLikeMime,
    type SkillFileContentReader,
} from '../agent-tools-skill-file';

const CONTEXT = { userId: 'u1', agentId: 'a1' };

function makeResolved(slug = 'deploy-helper', id = 'sk1') {
    return {
        binding: { priority: 10 },
        skill: { id, slug, title: 'Deploy helper', version: '1.0.0' },
    };
}

function makeFileRow(over: any = {}) {
    return {
        id: 'f1',
        skillId: 'sk1',
        userId: 'u1',
        uploadId: 'a'.repeat(64),
        filename: 'run.sh',
        kind: 'script',
        sizeBytes: 64,
        mime: 'text/plain',
        ...over,
    };
}

describe('isTextLikeMime', () => {
    it('accepts text/* and structured text application mimes', () => {
        expect(isTextLikeMime('text/plain')).toBe(true);
        expect(isTextLikeMime('text/markdown; charset=utf-8')).toBe(true);
        expect(isTextLikeMime('application/json')).toBe(true);
        expect(isTextLikeMime('application/x-yaml')).toBe(true);
    });

    it('refuses binary mimes', () => {
        expect(isTextLikeMime('image/png')).toBe(false);
        expect(isTextLikeMime('application/pdf')).toBe(false);
        expect(isTextLikeMime('application/zip')).toBe(false);
        expect(isTextLikeMime('')).toBe(false);
    });
});

describe('createGetSkillFileTool', () => {
    let skills: any;
    let bindings: any;
    let skillFiles: any;
    let reader: SkillFileContentReader;

    beforeEach(() => {
        skills = {
            findByIdAndUser: jest
                .fn()
                .mockResolvedValue({ id: 'sk1', slug: 'deploy-helper', userId: 'u1' }),
        };
        bindings = { resolveActive: jest.fn().mockResolvedValue([makeResolved()]) };
        skillFiles = {
            findBySkillAndFilename: jest.fn().mockResolvedValue(makeFileRow()),
            findBySkillId: jest.fn().mockResolvedValue([makeFileRow()]),
        };
        reader = {
            readTextContent: jest.fn().mockResolvedValue({ content: '#!/bin/sh\necho hi' }),
        };
    });

    const build = (r: SkillFileContentReader | undefined = reader) =>
        createGetSkillFileTool(skills, bindings, skillFiles, r, CONTEXT);

    it('describes scripts as read-only data (US-6 gating) in the tool description', () => {
        expect(build().description).toMatch(/does not execute/i);
    });

    it('returns text content for a bound skill file', async () => {
        const result = await build().invoke({ skillSlug: 'deploy-helper', filename: 'run.sh' });
        expect(result).toEqual({
            skillSlug: 'deploy-helper',
            filename: 'run.sh',
            kind: 'script',
            mime: 'text/plain',
            sizeBytes: 64,
            content: '#!/bin/sh\necho hi',
        });
        // Ownership rides on every hop: resolveActive + user-scoped reads.
        expect(skillFiles.findBySkillAndFilename).toHaveBeenCalledWith('sk1', 'run.sh', 'u1');
        expect(reader.readTextContent).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', uploadId: 'a'.repeat(64) }),
        );
    });

    it('errors on a skill that is not bound to this Agent, listing what is', async () => {
        const result = await build().invoke({ skillSlug: 'ghost', filename: 'run.sh' });
        expect(result).toEqual({
            error: expect.stringContaining('not bound to this Agent'),
        });
        expect((result as { error: string }).error).toContain('deploy-helper');
    });

    it('errors on an unknown filename, listing the available siblings', async () => {
        skillFiles.findBySkillAndFilename.mockResolvedValueOnce(null);
        const result = await build().invoke({
            skillSlug: 'deploy-helper',
            filename: 'ghost.txt',
        });
        expect(result).toEqual({ error: expect.stringContaining('Available: run.sh') });
    });

    it('refuses binary mimes with a structured error, not bytes', async () => {
        skillFiles.findBySkillAndFilename.mockResolvedValueOnce(
            makeFileRow({ filename: 'logo.png', mime: 'image/png' }),
        );
        const result = await build().invoke({
            skillSlug: 'deploy-helper',
            filename: 'logo.png',
        });
        expect(result).toEqual({ error: expect.stringContaining('binary') });
        expect(reader.readTextContent).not.toHaveBeenCalled();
    });

    it('degrades politely when no content reader is bound', async () => {
        // NOT build(undefined): an explicit undefined argument triggers the
        // default parameter (`r = reader`) and builds WITH the reader.
        const tool = createGetSkillFileTool(skills, bindings, skillFiles, undefined, CONTEXT);
        const result = await tool.invoke({
            skillSlug: 'deploy-helper',
            filename: 'run.sh',
        });
        expect(result).toEqual({ error: expect.stringContaining('not available') });
    });

    it('validates its arguments', async () => {
        expect(await build().invoke({ skillSlug: '', filename: 'x' } as any)).toEqual({
            error: 'skillSlug is required',
        });
        expect(await build().invoke({ skillSlug: 'deploy-helper' } as any)).toEqual({
            error: 'filename is required',
        });
    });

    it('propagates reader errors verbatim (ownership refusal shape)', async () => {
        (reader.readTextContent as jest.Mock).mockResolvedValueOnce({
            error: 'File "run.sh" is not available.',
        });
        const result = await build().invoke({ skillSlug: 'deploy-helper', filename: 'run.sh' });
        expect(result).toEqual({ error: 'File "run.sh" is not available.' });
    });
});
