export const REPO_LOCAL_CONFIG_PATH = '.github/review-bot.yml';

export { ConfigParseError, parseRepoConfigYaml } from './parse.js';
export type { ConfigParseErrorCode } from './parse.js';
export { loadRepoConfig } from './load.js';
