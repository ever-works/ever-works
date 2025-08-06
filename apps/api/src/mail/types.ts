export interface Address {
    name: string;
    address: string;
}

export interface SendMailOptions {
    to?: string | Address | Array<string | Address>;
    cc?: string | Address | Array<string | Address>;
    bcc?: string | Address | Array<string | Address>;
    replyTo?: string | Address | Array<string | Address>;
    inReplyTo?: string | Address;
    from?: string | Address;
    subject?: string;
    text?: string | Buffer;
    html?: string | Buffer;
    sender?: string | Address;
    raw?: string | Buffer;
    references?: string | string[];
    encoding?: string;
    date?: Date | string;
    context?: {
        [name: string]: any;
    };
    transporterName?: string;
    template?: string;
}
