import { HttpException, HttpStatus } from '@nestjs/common';

export type EmailApprovalRefusalCode =
    /** The Agent's inbox holds its mail for review and this send is not a released draft. */
    | 'awaiting-approval'
    /** A draft id was supplied but no person approved exactly that message. */
    | 'draft-not-approved';

/**
 * Agent email (AW-05) — the send path refused to release an Agent's mail
 * without a person's approval. HTTP 403.
 *
 * In normal operation an Agent's message never reaches this: the Agent tool
 * adapter files it as a draft first. This is the backstop that makes the
 * gate hold even for a code path that forgot to.
 */
export class EmailApprovalRequiredException extends HttpException {
    constructor(
        public readonly code: EmailApprovalRefusalCode,
        public readonly agentId: string,
    ) {
        super(
            {
                statusCode: HttpStatus.FORBIDDEN,
                error: 'EmailApprovalRequired',
                message:
                    code === 'awaiting-approval'
                        ? "This agent's inbox holds mail for review. The message must be approved by a person before it can be sent."
                        : 'This draft has not been approved by a person, or it changed after approval.',
                details: { code, agentId },
            },
            HttpStatus.FORBIDDEN,
        );
    }
}
