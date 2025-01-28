import { Directory } from "../data-generator/data-generator.service";

export interface BaseInput {
    owner: string;
    repo: string;
}

export interface VercelInput extends BaseInput {
    provider: 'vercel';
    data: {
        token: string;
    }
}

export type DeployInput = VercelInput;

export type DeployProvider = DeployInput['provider']

export interface IDeployService {
    deploy: (input: DeployInput, directory: Directory) => Promise<void>;
}
