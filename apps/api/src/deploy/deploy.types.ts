import { User } from "src/entities/user.entity";
import { Directory } from "../entities/directory.entity";

export interface BaseInput {
    owner: string;
    repo: string;
}

export interface VercelInput extends BaseInput {
    provider: 'vercel';
    data: {
        vercelToken: string;
        ghToken?: string;
    }
}

export type DeployInput = VercelInput;

export type DeployProvider = DeployInput['provider']

export interface IDeployService {
    deploy: (input: DeployInput, directory: Directory, user: User) => Promise<void>;
}
