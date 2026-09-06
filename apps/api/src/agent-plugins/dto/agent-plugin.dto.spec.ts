import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DescriptorQueryDto } from './agent-plugin.dto';

async function urlErrors(url: unknown): Promise<string[]> {
    const errors = await validate(plainToInstance(DescriptorQueryDto, { url }));
    return errors.flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('DescriptorQueryDto', () => {
    it('accepts an https endpoint, and accepts the query being absent', async () => {
        expect(await urlErrors('https://api.ever.works/mcp')).toEqual([]);
        expect(await validate(plainToInstance(DescriptorQueryDto, {}))).toEqual([]);
    });

    // The endpoint's OpenAPI description promises the descriptor "contains no
    // credentials". `buildEverWorksMcpDescriptor` reports a bad URL in
    // `findings` rather than throwing, so without this the endpoint answers
    // 200 with an mcp.json carrying the credential, and a consumer that writes
    // `files` to disk and ignores `findings` gets it.
    it('rejects userinfo, which @IsUrl permits by default', async () => {
        expect(await urlErrors('https://user:pass@api.ever.works/mcp')).toEqual(['isUrl']);
        expect(await urlErrors('https://token@api.ever.works/mcp')).toEqual(['isUrl']);
    });

    it('rejects a fragment, which @IsUrl also permits by default', async () => {
        expect(await urlErrors('https://api.ever.works/mcp#frag')).toEqual(['isUrl']);
        expect(await urlErrors('https://api.ever.works/mcp#')).toEqual(['isUrl']);
    });

    it('rejects plaintext http and non-http schemes', async () => {
        expect(await urlErrors('http://api.ever.works/mcp')).toEqual(['isUrl']);
        expect(await urlErrors('file:///etc/passwd')).toEqual(['isUrl']);
        expect(await urlErrors('/mcp')).toEqual(['isUrl']);
    });

    /**
     * The list `validateRemoteUrl` (packages/agent-plugins, spec 7.2.1) refuses.
     *
     * Kept as literals rather than by importing that function: apps/api does
     * not depend on `@ever-works/agent-plugins`, and the import only appears to
     * work because pnpm's hoisted virtual store happens to expose it — an
     * artefact of the installer's layout, not a declared edge. Declaring the
     * dependency to make it honest re-resolves apps/api's peer closure and
     * moves `chokidar` from 3.6.0 to 4.0.3, which leaves `nunjucks` (used by
     * the mailer templates) with an unmet `^3.3.0` peer. A drift guard is not
     * worth a major-version bump in an unrelated subsystem.
     *
     * The DTO is deliberately STRICTER on one axis: `validateRemoteUrl` permits
     * plaintext http to a loopback host and this refuses it, because a
     * descriptor we publish should never point at the caller's own machine. So
     * the relationship is "everything the importer rejects, the DTO rejects" —
     * never equality. Loosening the DTO below this list would let the endpoint
     * emit an `mcp.json` its own importer would refuse.
     */
    it('rejects every shape the importer rejects', async () => {
        const refusedBySpec = [
            'https://user:pass@api.ever.works/mcp',
            'https://api.ever.works/mcp#frag',
            'file:///etc/passwd',
            'ftp://api.ever.works/mcp',
            'not-a-url',
        ];

        for (const raw of refusedBySpec) {
            expect(await urlErrors(raw)).toEqual(['isUrl']);
        }
    });
});
