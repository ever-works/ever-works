import { randomUUID } from 'node:crypto';
import { slugifyText } from '../items-generator/utils/text.utils';

export class User {
    id: string;
    username: string;
    email: string;

    static async sessionMock() {
        const user = new User();

        user.id = slugifyText(process.env.GIT_NAME || randomUUID());
        user.username = process.env.GIT_NAME;
        user.email = process.env.GIT_EMAIL;

        return user;
    }

    getGitToken() {
        return process.env.GITHUB_APIKEY;
    }

    asCommitter() {
        return { name: this.username, email: this.email };
    }
}
