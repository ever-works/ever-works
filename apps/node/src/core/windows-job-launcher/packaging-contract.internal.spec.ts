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
			'repro-build-1',
			'repro-build-2',
			'$env:RUSTFLAGS = $fixedRustFlags',
			'$env:CARGO_ENCODED_RUSTFLAGS = $null',
			'$firstBuildSha256 -cne $secondBuildSha256',
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
			expect.arrayContaining([
				'unsignedBuildSha256',
				'authenticodeContentSha256',
				'buildInputs',
				'reproducibility',
				'sbomSha256',
				'provenanceSha256'
			])
		);
		expect(signedSchema.required).toEqual(
			expect.arrayContaining([
				'signedArtifactSha256',
				'authenticodeContentSha256',
				'publisherSubject',
				'publisherCertificateSha256',
				'sbomSha256',
				'provenanceSha256'
			])
		);
		expect(signedSchema.properties.productionEligible.const).toBe(false);
		expect(signedSchema.properties.releaseApproval.const).toBe('required');
	});

	it('requires two isolated executable builds before reproducibility can be recorded', async () => {
		const schema = JSON.parse(
			await readFile(join(packageRoot, 'unsigned-release-metadata.schema.json'), 'utf8')
		) as Record<string, any>;
		const reproducibility = schema.$defs.reproducibility;
		const buildInputs = schema.$defs.buildInputs;
		expect(schema.properties.reproducibility.$ref).toBe('#/$defs/reproducibility');
		expect(schema.properties.buildInputs.$ref).toBe('#/$defs/buildInputs');
		expect(reproducibility.required).toEqual(
			expect.arrayContaining(['verified', 'buildCount', 'buildSha256', 'isolatedTargetDirectories'])
		);
		expect(reproducibility.properties.verified.const).toBe(true);
		expect(reproducibility.properties.buildCount.const).toBe(2);
		expect(reproducibility.properties.buildSha256.minItems).toBe(2);
		expect(reproducibility.properties.buildSha256.maxItems).toBe(2);
		expect(reproducibility.properties.buildArtifacts.uniqueItems).toBe(true);
		expect(buildInputs.required).toEqual(
			expect.arrayContaining([
				'rustFlags',
				'rustc',
				'cargo',
				'targetTriple',
				'msvcToolset',
				'linker',
				'windowsSdk',
				'builder'
			])
		);
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
		expect(workflow).toContain('test-pe-authenticode-content.ps1');
		expect(workflow).toContain('windows-job-helper-trust.windows.spec.ts');
		expect(workflow).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $expectedArtifacts[$index]');
		expect(workflow.match(/\.\\build-release\.ps1/g)).toHaveLength(1);
		expect(workflow).toContain('if: always()');
		for (const prohibited of ['upload-artifact', 'release create', 'kubectl', 'install-service.ps1']) {
			expect(workflow).not.toContain(prohibited);
		}
	});
});
