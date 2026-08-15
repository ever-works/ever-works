import { SkillsController } from './skills.controller';
import { UploadsService } from '../uploads/uploads.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Skill files feature — the mime hand-off between the skills controller
 * and the uploads spine.
 *
 * The spine accepts a FIXED allow-list (`ALLOWED_FILE_BINARY_MIME` +
 * `TEXT_LIKE_MIMES`). Browsers report code files with long-tail types
 * (`text/x-python` for `.py`) that are "text-like" by a loose
 * `startsWith('text/')` test but are NOT on that list — uploading a
 * script therefore 400'd with `MimeNotAllowed`. The controller must
 * decide using the spine's OWN predicate and substitute `text/plain`
 * for anything it would reject whose bytes are valid UTF-8.
 *
 * The predicate here is the REAL `UploadsService.acceptsSaveFileMime`
 * (pure — it only reads the module-level allow-list sets), so this spec
 * fails if the controller and the spine ever disagree again.
 */
const acceptsSaveFileMime = UploadsService.prototype.acceptsSaveFileMime;

const AUTH = { userId: 'u1' } as AuthenticatedUser;

function makeController() {
    const service = { getOne: jest.fn().mockResolvedValue({ id: 'sk1', userId: 'u1' }) };
    const files = { add: jest.fn().mockImplementation((_u: string, input: unknown) => input) };
    const uploads = {
        acceptsSaveFileMime: jest.fn((mime: string) => acceptsSaveFileMime.call(null, mime)),
        saveFile: jest.fn().mockResolvedValue({ hash: 'a'.repeat(64) }),
    };
    const controller = new SkillsController(
        {} as never, // SkillRepository
        {} as never, // SkillsFacadeService
        service as never,
        files as never,
        uploads as never,
        {} as never, // SkillFileContentReaderService
    );
    return { controller, service, files, uploads };
}

function multipart(
    originalname: string,
    mimetype: string,
    body: Buffer | string = 'print("hi")\n',
): Express.Multer.File {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return { originalname, mimetype, buffer, size: buffer.length } as Express.Multer.File;
}

describe('SkillsController.uploadFile — uploads-spine mime hand-off', () => {
    it('substitutes text/plain for a UTF-8 script the spine would reject (text/x-python)', async () => {
        const { controller, files, uploads } = makeController();

        // Guard the premise: the browser-declared type really is refused.
        expect(acceptsSaveFileMime.call(null, 'text/x-python')).toBe(false);

        const created = await controller.uploadFile(
            AUTH,
            '11111111-1111-4111-8111-111111111111',
            multipart('analyze.py', 'text/x-python'),
            {},
        );

        // The spine only ever sees a type it accepts.
        const [, sent] = uploads.saveFile.mock.calls[0];
        expect(sent.mimetype).toBe('text/plain');
        expect(acceptsSaveFileMime.call(null, sent.mimetype)).toBe(true);

        // …and the row records the same effective type, so getSkillFile
        // reads it back as text instead of refusing it as binary.
        expect((created as { mime: string }).mime).toBe('text/plain');
        // Text bodies still reach the secret scanner.
        expect((files.add.mock.calls[0][1] as { textContent?: string }).textContent).toBe(
            'print("hi")\n',
        );
    });

    it.each([
        ['setup.sh', 'application/x-sh'],
        ['conf.toml', ''],
        ['notes.rst', 'application/octet-stream'],
        ['data.txt', 'text/plain; charset=utf-8'],
    ])('coerces %s (declared %p) to text/plain', async (name, declared) => {
        const { controller, uploads } = makeController();
        await controller.uploadFile(
            AUTH,
            '11111111-1111-4111-8111-111111111111',
            multipart(name, declared, 'x=1\n'),
            {},
        );
        expect(uploads.saveFile.mock.calls[0][1].mimetype).toBe('text/plain');
    });

    it('preserves a declared type the spine already accepts', async () => {
        const { controller, files, uploads } = makeController();
        await controller.uploadFile(
            AUTH,
            '11111111-1111-4111-8111-111111111111',
            multipart('guide.md', 'text/markdown', '# Guide\n'),
            {},
        );
        expect(uploads.saveFile.mock.calls[0][1].mimetype).toBe('text/markdown');
        expect((files.add.mock.calls[0][1] as { mime: string }).mime).toBe('text/markdown');
    });

    it('leaves a real binary alone — no coercion, no secret scan', async () => {
        const { controller, files, uploads } = makeController();
        // 0x80 is not valid standalone UTF-8, so the decode fails.
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x80, 0xff]);
        await controller.uploadFile(
            AUTH,
            '11111111-1111-4111-8111-111111111111',
            multipart('logo.png', 'image/png', png),
            {},
        );
        expect(uploads.saveFile.mock.calls[0][1].mimetype).toBe('image/png');
        expect(
            (files.add.mock.calls[0][1] as { textContent?: string }).textContent,
        ).toBeUndefined();
    });

    it('404s a cross-user skill BEFORE any bytes are stored', async () => {
        const { controller, service, uploads } = makeController();
        service.getOne.mockRejectedValue(new Error('Skill not found.'));
        await expect(
            controller.uploadFile(
                AUTH,
                '11111111-1111-4111-8111-111111111111',
                multipart('analyze.py', 'text/x-python'),
                {},
            ),
        ).rejects.toThrow('Skill not found.');
        expect(uploads.saveFile).not.toHaveBeenCalled();
    });
});

describe('UploadsService.acceptsSaveFileMime', () => {
    it('mirrors the spine allow-list exactly', () => {
        for (const accepted of [
            'text/plain',
            'text/markdown',
            'application/json',
            'application/x-yaml',
            'image/png',
            'application/pdf',
        ]) {
            expect(acceptsSaveFileMime.call(null, accepted)).toBe(true);
        }
        for (const refused of [
            'text/x-python',
            'text/x-sh',
            'text/x-java',
            'application/toml',
            'application/x-sh',
            'text/plain; charset=utf-8',
            '',
        ]) {
            expect(acceptsSaveFileMime.call(null, refused)).toBe(false);
        }
    });
});
