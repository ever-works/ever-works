import { HttpException, HttpStatus } from '@nestjs/common';
import type { EmailSendCapExceededDetails, EmailSendCapLimitKind } from '@ever-works/contracts';

const LIMIT_LABEL: Record<EmailSendCapLimitKind, string> = {
    recipientsPerMessage: 'recipients on one message',
    inboxBurst: "sends in the last minute from this agent's inbox",
    inboxRecipients: "distinct recipients in the last 5 minutes from this agent's inbox",
    inboxDaily: "sends in the last 24 hours from this agent's inbox",
    workspaceDaily: 'sends in the last 24 hours across this account',
    workspaceMonthly: 'sends in the last 30 days across this account',
};

/**
 * Agent email (AW-05) — a send would break a ceiling. HTTP 429.
 *
 * Modelled on `BudgetExceededException`: the body names WHICH ceiling, the
 * count, the ceiling and when capacity returns, so the web client renders
 * it without string matching and an Agent's tool result is a sentence the
 * model can act on. Nothing was sent and nothing was lost.
 */
export class EmailSendCapExceededException extends HttpException {
    constructor(public readonly details: EmailSendCapExceededDetails) {
        const label = LIMIT_LABEL[details.limitKind];
        const wait =
            details.retryAfterSeconds > 0
                ? ` Capacity returns in about ${formatWait(details.retryAfterSeconds)}.`
                : ' Waiting will not help — reduce the recipients.';
        const message =
            details.limitKind === 'recipientsPerMessage'
                ? `This message has ${details.used} recipients; the limit is ${details.cap} ${label}.${wait}`
                : `Send limit reached: ${details.used} of ${details.cap} ${label}.${wait} Nothing was sent.`;
        super(
            {
                statusCode: HttpStatus.TOO_MANY_REQUESTS,
                error: 'EmailSendCapExceeded',
                message,
                details,
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }
}

function formatWait(seconds: number): string {
    if (seconds < 90) return `${seconds} seconds`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 90) return `${minutes} minutes`;
    return `${Math.ceil(minutes / 60)} hours`;
}
