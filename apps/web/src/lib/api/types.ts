export interface MessageResponse {
    success: boolean;
    message?: string;
    response?: string;
    error?: string;
    metadata?: Record<string, any>;
}
