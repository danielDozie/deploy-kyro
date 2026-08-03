/**
 * Direct Cloudflare v4 REST API client for fast provisioning
 */
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
function getHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
}
/**
 * 1. Get the Cloudflare Account ID associated with the API token
 */
export async function getAccountId(apiToken) {
    const res = await fetch(`${CF_API_BASE}/accounts`, {
        headers: getHeaders(apiToken),
    });
    const data = (await res.json());
    if (!res.ok || !data.success || !data.result?.length) {
        throw new Error(data.errors?.[0]?.message || 'Failed to fetch Cloudflare Account ID with provided API Token');
    }
    return data.result[0].id;
}
/**
 * 2. Get or create the Workers subdomain (e.g. username.workers.dev)
 */
export async function getWorkersSubdomain(apiToken, accountId) {
    const res = await fetch(`${CF_API_BASE}/accounts/${accountId}/workers/subdomain`, {
        headers: getHeaders(apiToken),
    });
    const data = (await res.json());
    if (data.result?.subdomain) {
        return data.result.subdomain;
    }
    // Fallback default subdomain if none set
    return `${accountId.substring(0, 8)}`;
}
/**
 * 3. Create R2 Bucket (or verify it exists)
 */
export async function createR2Bucket(apiToken, accountId, bucketName) {
    const res = await fetch(`${CF_API_BASE}/accounts/${accountId}/r2/buckets`, {
        method: 'POST',
        headers: getHeaders(apiToken),
        body: JSON.stringify({ name: bucketName }),
    });
    const data = (await res.json());
    if (!res.ok && !data.errors?.some((e) => e.code === 10006 || e.message?.includes('already exists'))) {
        throw new Error(data.errors?.[0]?.message || `Failed to create R2 bucket "${bucketName}"`);
    }
    return bucketName;
}
/**
 * 4. Create D1 Database (or fetch existing UUID if already created)
 */
export async function createD1Database(apiToken, accountId, dbName) {
    const res = await fetch(`${CF_API_BASE}/accounts/${accountId}/d1/database`, {
        method: 'POST',
        headers: getHeaders(apiToken),
        body: JSON.stringify({ name: dbName }),
    });
    const data = (await res.json());
    if (data.success && data.result?.uuid) {
        return data.result.uuid;
    }
    // If already exists, search list for database UUID
    const listRes = await fetch(`${CF_API_BASE}/accounts/${accountId}/d1/database`, {
        headers: getHeaders(apiToken),
    });
    const listData = (await listRes.json());
    const existing = listData.result?.find((db) => db.name === dbName);
    if (existing?.uuid) {
        return existing.uuid;
    }
    throw new Error(data.errors?.[0]?.message || `Failed to create D1 database "${dbName}"`);
}
/**
 * 5. Deploy Worker Script with D1, R2, and secret bindings
 */
export async function uploadWorkerScript(apiToken, accountId, workerName, scriptContent, d1DatabaseId, r2BucketName, adminEmail, adminPassword) {
    const formData = new FormData();
    const metadata = {
        main_module: 'worker.mjs',
        compatibility_date: '2024-01-01',
        compatibility_flags: ['nodejs_compat'],
        bindings: [
            { type: 'd1', name: 'DB', id: d1DatabaseId },
            { type: 'r2_bucket', name: 'BUCKET', bucket_name: r2BucketName },
            { type: 'plain_text', name: 'ADMIN_EMAIL', text: adminEmail },
            ...(adminPassword ? [{ type: 'plain_text', name: 'ADMIN_PASSWORD', text: adminPassword }] : []),
        ],
    };
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
    formData.append('worker.mjs', new Blob([scriptContent], { type: 'application/javascript+module' }), 'worker.mjs');
    const res = await fetch(`${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${apiToken}`,
        },
        body: formData,
    });
    const data = (await res.json());
    if (!res.ok || !data.success) {
        throw new Error(data.errors?.[0]?.message || `Failed to upload Worker script "${workerName}"`);
    }
}
/**
 * 6. Enable workers.dev subdomain for the worker
 */
export async function enableWorkerSubdomain(apiToken, accountId, workerName) {
    const res = await fetch(`${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
        method: 'POST',
        headers: getHeaders(apiToken),
        body: JSON.stringify({ enabled: true }),
    });
    const data = (await res.json());
    if (!res.ok && !data.success) {
        // Non-fatal if already enabled
        console.warn(`[Cloudflare API] Warning enabling subdomain:`, data.errors?.[0]?.message);
    }
}
/**
 * High-level Fast Orchestrator Function
 */
export async function deployDirectToCloudflare(opts) {
    const log = opts.onProgress || (() => { });
    log('auth', '🔑 Verifying Cloudflare API Token & Account…');
    const accountId = await getAccountId(opts.apiToken);
    log('auth', `✔ Cloudflare Account ID: ${accountId}`);
    log('subdomain', '🌐 Retrieving Workers Subdomain…');
    const subdomain = await getWorkersSubdomain(opts.apiToken, accountId);
    log('r2', `📦 Provisioning R2 Storage Bucket "${opts.r2BucketName}"…`);
    await createR2Bucket(opts.apiToken, accountId, opts.r2BucketName);
    log('r2', `✔ R2 Bucket "${opts.r2BucketName}" ready`);
    log('d1', `🗄 Provisioning D1 SQLite Database "${opts.dbName}"…`);
    const d1DatabaseId = await createD1Database(opts.apiToken, accountId, opts.dbName);
    log('d1', `✔ D1 Database ready (ID: ${d1DatabaseId})`);
    log('worker', `🚀 Uploading Kyro Worker Script & Bindings ("${opts.workerName}")…`);
    await uploadWorkerScript(opts.apiToken, accountId, opts.workerName, opts.scriptContent, d1DatabaseId, opts.r2BucketName, opts.adminEmail, opts.adminPassword);
    log('worker', `✔ Worker script uploaded successfully`);
    log('routing', `⚡ Activating workers.dev route…`);
    await enableWorkerSubdomain(opts.apiToken, accountId, opts.workerName);
    const liveUrl = `https://${opts.workerName}.${subdomain}.workers.dev`;
    log('done', `🎉 Deployment successful! Live at ${liveUrl}`);
    return {
        ok: true,
        liveUrl,
        accountId,
        subdomain,
        d1DatabaseId,
        r2Bucket: opts.r2BucketName,
        workerName: opts.workerName,
        adminEmail: opts.adminEmail,
    };
}
//# sourceMappingURL=cloudflare-api.js.map