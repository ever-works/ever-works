import { WorksManifestService } from '../works-manifest.service';

describe('WorksManifestService', () => {
    const service = new WorksManifestService();

    const minimalValid = `
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: Open Source Time Trackers
spec:
  pipeline: standard-pipeline
  domain: software
  items:
    sources:
      - type: web-search
        query: "open source time tracker"
        max: 30
`;

    it('accepts a minimal valid manifest', () => {
        const result = service.parseAndValidate(minimalValid);
        expect(result.ok).toBe(true);
        if (result.kind === 'success') {
            expect(result.manifest.metadata.name).toBe('Open Source Time Trackers');
            expect(result.manifest.spec.items.sources[0].type).toBe('web-search');
        }
    });

    it('rejects invalid YAML', () => {
        const result = service.parseAndValidate('apiVersion: : :');
        expect(result.ok).toBe(false);
        if (result.kind === 'failure') {
            expect(result.code).toBe('manifest_invalid_yaml');
            expect(result.errors[0].subcode).toBe('manifest.invalid_yaml');
        }
    });

    it('rejects unknown apiVersion', () => {
        const yamlText = minimalValid.replace('works.ever.works/v1', 'works.ever.works/v999');
        const result = service.parseAndValidate(yamlText);
        expect(result.ok).toBe(false);
        if (result.kind === 'failure') {
            expect(result.code).toBe('manifest_invalid');
            expect(result.errors.some((e) => e.subcode === 'manifest.unsupported_apiversion')).toBe(
                true,
            );
        }
    });

    it('rejects when sources array is empty', () => {
        const yamlText = `
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: x
spec:
  pipeline: standard-pipeline
  domain: software
  items:
    sources: []
`;
        const result = service.parseAndValidate(yamlText);
        expect(result.ok).toBe(false);
        if (result.kind === 'failure') {
            expect(result.errors.some((e) => e.path.startsWith('spec.items.sources'))).toBe(true);
        }
    });

    it('rejects unknown source type', () => {
        const yamlText = `
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: x
spec:
  pipeline: standard-pipeline
  domain: software
  items:
    sources:
      - type: telepathic
        query: hi
`;
        const result = service.parseAndValidate(yamlText);
        expect(result.ok).toBe(false);
    });

    it('rejects invalid domain enum', () => {
        const yamlText = minimalValid.replace('domain: software', 'domain: spaceship');
        const result = service.parseAndValidate(yamlText);
        expect(result.ok).toBe(false);
        if (result.kind === 'failure') {
            expect(result.errors.some((e) => e.subcode === 'manifest.spec.domain_invalid')).toBe(
                true,
            );
        }
    });

    it('rejects subdomain that does not match DNS rule', () => {
        const yamlText = `
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: x
  subdomain: -bad-start
spec:
  pipeline: standard-pipeline
  domain: software
  items:
    sources:
      - type: web-search
        query: x
`;
        const result = service.parseAndValidate(yamlText);
        expect(result.ok).toBe(false);
    });

    it('rejects markerFile not under .works/', () => {
        const yamlText = `
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: x
spec:
  pipeline: standard-pipeline
  domain: software
  items:
    sources:
      - type: web-search
        query: x
  output:
    markerFile: state.json
`;
        const result = service.parseAndValidate(yamlText);
        expect(result.ok).toBe(false);
        if (result.kind === 'failure') {
            expect(
                result.errors.some((e) => e.subcode === 'manifest.output.marker_outside_works'),
            ).toBe(true);
        }
    });

    it('accepts inline source list', () => {
        const yamlText = `
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: Inline Set
spec:
  pipeline: standard-pipeline
  domain: software
  items:
    sources:
      - type: inline
        items:
          - name: One
            url: https://example.com/one
          - name: Two
`;
        const result = service.parseAndValidate(yamlText);
        expect(result.ok).toBe(true);
    });

    it('rejects manifests larger than 64 KiB', () => {
        const big = 'a'.repeat(64 * 1024 + 1);
        const result = service.parseAndValidate(big);
        expect(result.ok).toBe(false);
        if (result.kind === 'failure') {
            expect(result.errors[0].subcode).toBe('manifest.size_limit');
        }
    });
});
