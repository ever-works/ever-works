/**
 * Payload contract for the `memory-fact-embed` task (AW-07).
 *
 * Deliberately just IDS. The body, the scope and the workspace are re-read
 * from the `memory_facts` row by the consumer, which shares the API's
 * database — so an edit that lands between enqueue and execution is what
 * gets embedded, and a payload handed to an older worker cannot carry a
 * stale body into the vector store.
 */
export interface MemoryFactEmbedPayload {
    /** The `memory_facts` row to embed. */
    readonly factId: string;

    /**
     * Owner of the fact. Carried for logs and usage attribution only; the
     * row remains the authority and is re-read.
     */
    readonly userId: string;
}
