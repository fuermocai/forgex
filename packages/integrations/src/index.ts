/**
 * @forgex/integrations 公共入口（v0.4.0 Phase 4）。
 *
 * Git / CI-CD 集成：本地 Git、GitLab（私有化）、Jenkins（私有化）。
 */
export * from './types.js';
export { GitService } from './git/git-service.js';
export { RepositoryManager } from './git/repository-manager.js';
export { ChangeSetManager } from './git/change-set-manager.js';
export { ReviewManager } from './git/review-manager.js';
export { type PipelineAdapter, LocalPipelineAdapter } from './ci/pipeline-adapter.js';
export { GitLabAdapter, type GitLabConfig } from './gitlab/gitlab-adapter.js';
export { JenkinsAdapter, type JenkinsConfig } from './jenkins/jenkins-adapter.js';
