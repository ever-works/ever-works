/**
 * Public API for the Ever Works platform-default providers that back the
 * default choices in the onboarding wizard (Ever Works Git storage,
 * Ever Works Kubernetes deploy).
 */
export * from './types';
export { EverWorksGitProvider, type EverWorksGitHttpFetch } from './ever-works-git.provider';
export {
    EverWorksK8sDeployProvider,
    type EverWorksKubeconfigReader,
} from './ever-works-k8s-deploy.provider';
export {
    EverWorksDeployQuotaService,
    EVER_WORKS_DEPLOY_QUOTA_COUNTER,
} from './ever-works-deploy-quota.service';
