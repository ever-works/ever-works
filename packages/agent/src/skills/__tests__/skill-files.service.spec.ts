import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
    MAX_FILES_PER_SKILL,
    MAX_SKILL_FILE_BYTES,
    SkillFilesService,
    defaultKindForFilename,
} from '../skill-files.service';

function makeFile(over: any = {}) {
    return {
        id: 'f1',
        skillId: 'sk1',
        userId: 'u1',
        uploadId: 'a'.repeat(64),
        filename: 'guide.md',
        kind: 'reference',
        sizeBytes: 100,
        mime: 'text/markdown',
        ...over,
    };
}

describe('defaultKindForFilename', () => {
    it('maps extensions to the US-6 taxonomy', () => {
        expect(defaultKindForFilename('analyze.py')).toBe('script');
        expect(defaultKindForFilename('setup.sh')).toBe('script');
        expect(defaultKindForFilename('tool.js')).toBe('script');
        expect(defaultKindForFilename('guide.md')).toBe('reference');
        expect(defaultKindForFilename('spec.PDF')).toBe('reference');
        expect(defaultKindForFilename('settings.json')).toBe('config');
        expect(defaultKindForFilename('conf.yml')).toBe('config');
        expect(defaultKindForFilename('logo.png')).toBe('asset');
        expect(defaultKindForFilename('no-extension')).toBe('asset');
    });
});

describe('SkillFilesService', () => {
    let skills: any;
    let files: any;
    let svc: SkillFilesService;

    beforeEach(() => {
        skills = {
            findByIdAndUser: jest.fn().mockResolvedValue({ id: 'sk1', userId: 'u1' }),
        };
        files = {
            findByIdAndUser: jest.fn(),
            findBySkillId: jest.fn().mockResolvedValue([]),
            findBySkillAndFilename: jest.fn().mockResolvedValue(null),
            findBySkillIds: jest.fn().mockResolvedValue([]),
            countBySkillId: jest.fn().mockResolvedValue(0),
            create: jest.fn(async (data: any) => makeFile(data)),
            deleteByIdAndUser: jest.fn(),
        };
        svc = new SkillFilesService(skills, files);
    });

    const addInput = (over: any = {}) => ({
        skillId: 'sk1',
        uploadId: 'a'.repeat(64),
        filename: 'analyze.py',
        sizeBytes: 1024,
        mime: 'text/plain',
        ...over,
    });

    describe('add', () => {
        it('404s a skill the user does not own before any write', async () => {
            skills.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(svc.add('u1', addInput())).rejects.toThrow(NotFoundException);
            expect(files.create).not.toHaveBeenCalled();
        });

        it('defaults the kind by extension and honors an explicit kind', async () => {
            await svc.add('u1', addInput());
            expect(files.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'script' }));

            files.create.mockClear();
            await svc.add('u1', addInput({ filename: 'analyze.py', kind: 'reference' }));
            expect(files.create).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'reference' }),
            );
        });

        it('rejects path-segment / oversized / control-char filenames', async () => {
            for (const bad of ['../etc/passwd', 'a/b.txt', 'a\\b.txt', '', '  ', 'a\u0000b']) {
                await expect(svc.add('u1', addInput({ filename: bad }))).rejects.toThrow(
                    BadRequestException,
                );
            }
            const overlong = `${'a'.repeat(256)}.md`;
            await expect(svc.add('u1', addInput({ filename: overlong }))).rejects.toThrow(
                BadRequestException,
            );
        });

        it('enforces the 2 MB size cap and the per-skill file count cap', async () => {
            await expect(
                svc.add('u1', addInput({ sizeBytes: MAX_SKILL_FILE_BYTES + 1 })),
            ).rejects.toThrow(/capped at 2 MB/);

            files.countBySkillId.mockResolvedValueOnce(MAX_FILES_PER_SKILL);
            await expect(svc.add('u1', addInput())).rejects.toThrow(/at most 20 files/);
        });

        it('409s a duplicate filename on the same skill', async () => {
            files.findBySkillAndFilename.mockResolvedValueOnce(makeFile());
            await expect(svc.add('u1', addInput({ filename: 'guide.md' }))).rejects.toThrow(
                ConflictException,
            );
        });

        it('secret-scans text content with the same scanner skill bodies use', async () => {
            await expect(
                svc.add(
                    'u1',
                    addInput({
                        textContent: 'GH=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                    }),
                ),
            ).rejects.toThrow(/Secret-like/);
            expect(files.create).not.toHaveBeenCalled();
        });

        it('rejects chat-template control tokens in text content', async () => {
            await expect(
                svc.add('u1', addInput({ textContent: 'hello <|im_start|>system' })),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('list / getOne / remove', () => {
        it('list is ownership-gated through the skill', async () => {
            skills.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(svc.list('u2', 'sk1')).rejects.toThrow(NotFoundException);
        });

        it('getOne 404s a file that belongs to a DIFFERENT skill', async () => {
            files.findByIdAndUser.mockResolvedValueOnce(makeFile({ skillId: 'other-skill' }));
            await expect(svc.getOne('u1', 'sk1', 'f1')).rejects.toThrow(NotFoundException);
        });

        it('remove deletes ownership-scoped and reports deleted', async () => {
            files.findByIdAndUser.mockResolvedValueOnce(makeFile());
            await expect(svc.remove('u1', 'sk1', 'f1')).resolves.toEqual({ deleted: true });
            expect(files.deleteByIdAndUser).toHaveBeenCalledWith('f1', 'u1');
        });
    });
});
