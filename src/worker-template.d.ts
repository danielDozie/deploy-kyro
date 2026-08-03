/**
 * Kyro CMS Worker Script Fetcher
 * Downloads the pre-compiled Kyro CMS core bundle from GitHub Releases / Raw GitHub repository
 * and caches it in memory for fast, direct Cloudflare deployments.
 */
/**
 * Fetch the latest Kyro CMS Core JavaScript bundle from GitHub
 */
export declare function getKyroWorkerScript(customUrl?: string): Promise<string>;
/**
 * Fallback worker script when offline or if GitHub release asset is not reachable
 */
export declare function getFallbackKyroWorkerScript(): string;
//# sourceMappingURL=worker-template.d.ts.map