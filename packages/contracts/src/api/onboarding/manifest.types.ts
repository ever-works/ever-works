import type { OnboardingRequestSource } from './register-work.request.js';

export interface WorksManifestMetadata {
	name: string;
	slug?: string;
	description?: string;
	subdomain?: string;
}

export interface WorksManifestSpec {
	pipeline: string;
	domain: 'software' | 'ecommerce' | 'services' | 'general';
	taxonomy?: {
		categories?: ReadonlyArray<string>;
		tags?: ReadonlyArray<string>;
		lockTaxonomy?: boolean;
	};
	items: {
		sources: ReadonlyArray<OnboardingRequestSource>;
	};
	generators?: {
		aiProvider?: string;
		searchProvider?: string;
		screenshot?: string;
		model?: string;
	};
	deployment?: {
		target?: string;
		customDomain?: string;
	};
	output?: WorksManifestOutput;
}

export interface WorksManifestOutput {
	repos?: {
		website?: 'managed' | 'none';
		awesomeList?: 'managed' | 'none';
	};
	llmsTxt?: boolean;
	itemsJson?: boolean;
	markerFile?: string;
}

export interface WorksManifestV1 {
	apiVersion: 'works.ever.works/v1';
	kind: 'Work';
	metadata: WorksManifestMetadata;
	spec: WorksManifestSpec;
}
