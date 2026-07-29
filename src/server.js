import { createServer } from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { createProject } from '@kyro-cms/create-kyro/headless';
import { deployCloudflare } from '@kyro-cms/create-kyro/deployers/cloudflare';
const PORT = Number(process.env.PORT) || 3000;
function sendSSE(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') {
        res.flush();
    }
}
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            }
            catch {
                resolve({});
            }
        });
        req.on('error', reject);
    });
}
const server = createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';
    console.log(`[${new Date().toISOString()}] ${method} ${url}`);
    // Handle CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        });
        res.end();
        return;
    }
    // Health check endpoint
    if (url === '/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
    }
    // One-click deploy endpoint: POST /deploy-cloudflare
    if (url === '/deploy-cloudflare' && method === 'POST') {
        const body = await parseBody(req);
        // Set SSE headers for real-time progress streaming
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });
        // Send initial ping to establish connection immediately
        res.write(': ping\n\n');
        const projectName = body.projectName || `kyro-app-${Date.now()}`;
        const targetDir = body.cwd || os.tmpdir();
        // 1. Scaffold project in temporary directory
        sendSSE(res, { type: 'info', step: 'scaffold', message: '🛠 Scaffolding project files...' });
        const scaffoldResult = await createProject({
            projectName,
            database: body.database === 'postgres' ? 'postgres' : 'sqlite',
            template: body.template || 'minimal',
            adminEmail: body.adminEmail || `admin@${projectName}.local`,
            cwd: targetDir,
            onProgress(step, detail) {
                sendSSE(res, { type: 'info', step, message: detail || step });
            },
        });
        if (!scaffoldResult.ok) {
            sendSSE(res, { type: 'error', step: 'scaffold', message: scaffoldResult.error });
            res.end();
            return;
        }
        sendSSE(res, { type: 'success', step: 'scaffold', message: `Project scaffolded in ${scaffoldResult.projectDir}` });
        // 2. Provision & Deploy to Cloudflare
        sendSSE(res, { type: 'info', step: 'deploy', message: '☁️ Provisioning & deploying to Cloudflare Workers...' });
        const deployer = deployCloudflare({
            projectDir: scaffoldResult.projectDir,
            projectName: body.workerName || projectName,
            r2Bucket: body.r2Bucket,
            database: body.database === 'postgres' ? 'postgres' : 'd1',
            databaseUrl: body.databaseUrl,
            hyperdriveName: body.hyperdriveName,
            adminEmail: scaffoldResult.adminEmail,
            adminPassword: scaffoldResult.adminPassword,
            cloudflareApiToken: body.cloudflareApiToken,
        });
        for await (const event of deployer) {
            sendSSE(res, event);
            if (event.type === 'done' || event.type === 'error')
                break;
        }
        res.end();
        return;
    }
    // 404 Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});
server.listen(PORT, () => {
    console.log(`🚀 Standalone Deploy Server running on http://localhost:${PORT}`);
});
//# sourceMappingURL=server.js.map