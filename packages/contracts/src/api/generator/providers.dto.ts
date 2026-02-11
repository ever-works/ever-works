/**
 * Provider selection for each capability category
 */
export interface ProvidersDto {
	/** Search provider plugin ID */
	search?: string;
	/** Screenshot provider plugin ID */
	screenshot?: string;
	/** AI provider plugin ID */
	ai?: string;
	/** Content extractor provider plugin ID */
	contentExtractor?: string;
	/** Pipeline provider plugin ID */
	pipeline?: string;
}
