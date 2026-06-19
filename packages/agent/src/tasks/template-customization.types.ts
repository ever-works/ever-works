export type TemplateCustomizationPayload = {
    customizationId: string;
    /**
     * EW-742 P3.2 T22 — enqueue-site tenant-runtime binding capture.
     * See `KbEmbedDocumentPayload` (the PoC dispatcher) for the full
     * contract; the same null/null fail-open semantics apply.
     */
    providerId?: string | null;
    credentialVersion?: number | null;
};
