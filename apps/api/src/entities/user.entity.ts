export class User {
    id: string;
    username: string;
    email: string;

    static async sessionMock() {
        const user = new User();
        user.username = process.env.GIT_NAME;
        user.id = '11111111-1111-1111-1111-111111111111';
        user.email = process.env.GIT_EMAIL;
        
        return user;
    }
    
    getGitToken() {
        return process.env.GITHUB_APIKEY;
    }

    getCommitter() {
        return { name: this.username, email: this.email };
    }
}
