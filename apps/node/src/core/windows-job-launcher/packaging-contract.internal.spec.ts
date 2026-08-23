import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = join(__dirname, '../../../native/windows-job-launcher');
const repositoryRoot = join(__dirname, '../../../../..');

describe('Windows Job launcher packaging contract', () => {
	it('keeps the deterministic build explicitly unsigned and ineligible for production', async () => {
		const source = await readFile(join(packageRoot, 'build-release.ps1'), 'utf8');
		for (const required of [
			'CycloneDX',
			'in-toto',
			'unsignedBuildSha256',
			'sbomSha256',
			'provenanceSha256',
			'productionEligible = $false',
			'authenticode = [ordered]@{ status = "unsigned"'
		]) {
			expect(source).toContain(required);
		}
		expect(source).not.toContain('Get-Date');
		expect(source).not.toContain('generatedAt');
		expect(source).not.toContain('Set-AuthenticodeSignature');
		expect(source).not.toContain('upload-artifact');
	});

	it('defines separate unsigned-build and signed-artifact schemas with exact trust pins', async () => {
		const unsignedSchema = JSON.parse(
			await readFile(join(packageRoot, 'unsigned-release-metadata.schema.json'), 'utf8')
		) as Record<string, any>;
		const signedSchema = JSON.parse(
			await readFile(join(packageRoot, 'signed-artifact-manifest.schema.json'), 'utf8')
		) as Record<string, any>;

		expect(unsignedSchema.properties.productionEligible.const).toBe(false);
		expect(unsignedSchema.required).toEqual(
			expect.arrayContaining(['unsignedBuildSha256', 'sbomSha256', 'provenanceSha256'])
		);
		expect(signedSchema.required).toEqual(
			expect.arrayContaining([
				'signedArtifactSha256',
				'publisherSubject',
				'publisherCertificateSha256',
				'sbomSha256',
				'provenanceSha256'
			])
		);
		expect(signedSchema.properties.productionEligible.const).toBe(false);
		expect(signedSchema.properties.releaseApproval.const).toBe('required');
	});

	it('creates a signed manifest only after Status=Valid and exact subject/certificate verification', async () => {
		const source = await readFile(join(packageRoot, 'create-signed-manifest.ps1'), 'utf8');
		for (const required of [
			'Get-AuthenticodeSignature -LiteralPath',
			'$signature.Status -ne "Valid"',
			'$signature.SignerCertificate.Subject',
			'GetCertHashString',
			'signedArtifactSha256',
			'productionEligible = $false',
			'releaseApproval = "required"'
		]) {
			expect(source).toContain(required);
		}
		expect(source).not.toContain('SignTool');
		expect(source).not.toContain('Set-AuthenticodeSignature');
	});

	it('keeps self-signed certificate creation confined to an explicit CI test fixture', async () => {
		const source = await readFile(join(packageRoot, 'prepare-test-signed-manifest.ps1'), 'utf8');
		expect(source).toContain('New-SelfSignedCertificate');
		expect(source).toContain('EVER_WORKS_TEST_SIGNED_HELPER_PATH');
		expect(source).toContain('testOnly = $true');
		expect(source).toContain('productionEligible = $false');
		expect(source).toContain('Remove-Item -LiteralPath');
	});

	it('runs signed/unsigned trust tests without uploading, publishing, installing, or deploying a binary', async () => {
		const workflow = await readFile(join(repositoryRoot, '.github/workflows/windows-job-launcher.yml'), 'utf8');
		expect(workflow).toContain('prepare-test-signed-manifest.ps1');
		expect(workflow).toContain('windows-job-helper-trust.windows.spec.ts');
		expect(workflow).toContain('if: always()');
		for (const prohibited of ['upload-artifact', 'release create', 'kubectl', 'install-service.ps1']) {
			expect(workflow).not.toContain(prohibited);
		}
	});
});
