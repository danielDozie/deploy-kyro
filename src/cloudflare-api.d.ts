/**
 * Direct Cloudflare v4 REST API client for fast provisioning
 */
export interface DeployOptions {
    apiToken: string;
    workerName: string;
    r2BucketName: string;
    dbName: string;
    adminEmail: string;
    adminPassword?: string;
    scriptContent: string;
    onProgress?: (step: string, message: string) => void;
}
export interface DeployResult {
    ok: boolean;
    liveUrl: string;
    accountId: string;
    subdomain: string;
    d1DatabaseId: string;
    r2Bucket: string;
    workerName: string;
    adminEmail: string;
}
/**
 * 1. Get the Cloudflare Account ID associated with the API token
 */
export declare function getAccountId(apiToken: string): Promise<string>;
/**
 * 2. Get or create the Workers subdomain (e.g. username.workers.dev)
 */
export declare function getWorkersSubdomain(apiToken: string, accountId: string): Promise<string>;
/**
 * 3. Create R2 Bucket (or verify it exists)
 */
export declare function createR2Bucket(apiToken: string, accountId: string, bucketName: string): Promise<string>;
/**
 * 4. Create D1 Database (or fetch existing UUID if already created)
 */
export declare function createD1Database(apiToken: string, accountId: string, dbName: string): Promise<string>;
/**
 * 5. Deploy Worker Script with D1, R2, and secret bindings
 */
export declare function uploadWorkerScript(apiToken: string, accountId: string, workerName: string, scriptContent: string, d1DatabaseId: string, r2BucketName: string, adminEmail: string, adminPassword?: string): Promise<void>;
/**
 * 6. Enable workers.dev subdomain for the worker
 */
export declare function enableWorkerSubdomain(apiToken: string, accountId: string, workerName: string): Promise<void>;
/**
 * High-level Fast Orchestrator Function
 */
export declare function deployDirectToCloudflare(opts: DeployOptions): Promise<DeployResult>;
//# sourceMappingURL=cloudflare-api.d.ts.map