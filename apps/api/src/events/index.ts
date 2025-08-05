import { User } from '@packages/agent/entities';

export abstract class BaseUserEvent {
    public abstract user: User;
}

export class UserCreatedEvent extends BaseUserEvent {
    static EVENT_NAME = 'user.created';

    constructor(
        public user: User,
        public confirmationToken: string,
        public confirmationUrl?: string,
    ) {
        super();
    }
}

export class UserForgotPasswordEvent extends BaseUserEvent {
    static EVENT_NAME = 'user.forgot_password';

    constructor(
        public user: User,
        public resetToken: string,
        public expiresIn?: string, // e.g. '1 hour'
        public resetUrl?: string,
    ) {
        super();
    }
}

export class UserPasswordChangedEvent extends BaseUserEvent {
    static EVENT_NAME = 'user.password_changed';

    constructor(
        public user: User,
        public changedAt: Date,
        public ipAddress: string,
        public location: string,
        public device: string,
        public browser?: string,
        public secureAccountUrl?: string,
    ) {
        super();
    }
}

export class UserConfirmedEvent extends BaseUserEvent {
    static EVENT_NAME = 'user.confirmed';

    constructor(
        public user: User,
        public dashboardUrl?: string,
    ) {
        super();
    }
}

export class UserNewDeviceLoginEvent extends BaseUserEvent {
    static EVENT_NAME = 'user.new_device_login';

    constructor(
        public user: User,
        public loginTime: Date,
        public device: string,
        public browser: string,
        public location: string,
        public ipAddress: string,
        public verifyToken: string,
        public verifyUrl?: string,
        public secureAccountUrl?: string,
    ) {
        super();
    }
}

export class UserAccountDeletionEvent extends BaseUserEvent {
    static EVENT_NAME = 'user.delete_account';

    constructor(
        public user: User,
        public deleteToken: string,
        public deleteUrl?: string,
        public keepAccountUrl?: string,
        public expiresIn?: string,
    ) {
        super();
    }
}
