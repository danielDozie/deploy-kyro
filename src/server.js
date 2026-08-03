import { createServer } from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deployDirectToCloudflare } from './cloudflare-api.js';
import { getKyroWorkerScript } from './worker-template.js';
try {
    process.loadEnvFile();
}
catch {
    // .env file may be missing or already loaded
}
const PORT = Number(process.env.PORT) || 3099;
// Cloudflare OAuth App Client ID
const CF_CLIENT_ID = process.env.CF_CLIENT_ID || process.env.CLOUDFLARE_CLIENT_ID || '';
const CF_CLIENT_SECRET = process.env.CF_CLIENT_SECRET || process.env.CLOUDFLARE_CLIENT_SECRET || '';
// ── Helpers ───────────────────────────────────────────────────────────────────
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
function generatePassword(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(length);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
/**
 * Spawn a subprocess and stream its output line-by-line as SSE events.
 * Resolves with the full stdout string when the process exits with code 0.
 * Rejects with an Error on non-zero exit.
 */
function spawnStreaming(res, step, cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        console.log(`[spawn] ${cmd} ${args.join(' ')} (cwd: ${opts.cwd ?? process.cwd()})`);
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: {
                ...process.env,
                CI: 'true',
                FORCE_COLOR: '1',
                ...opts.env,
            },
            shell: true,
        });
        let fullOutput = '';
        let lastLine = '';
        const onData = (data) => {
            const text = data.toString();
            fullOutput += text;
            // Emit each non-empty line as an SSE event
            const lines = text.split('\n');
            for (const raw of lines) {
                const line = raw.trim();
                if (line && line !== lastLine) {
                    lastLine = line;
                    sendSSE(res, { type: 'info', step, message: line });
                }
            }
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('close', (code) => {
            if (code === 0) {
                resolve(fullOutput);
            }
            else {
                reject(new Error(`Process exited with code ${code}`));
            }
        });
        child.on('error', reject);
    });
}
// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
    const host = req.headers.host ?? `localhost:${PORT}`;
    const rawHeader = req.headers['x-forwarded-proto'];
    const rawProto = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader) ?? '';
    const proto = rawProto.split(',')[0]?.trim() || (host.includes('localhost') ? 'http' : 'https');
    const reqUrl = new URL(req.url || '/', `${proto}://${host}`);
    const pathname = reqUrl.pathname;
    const method = req.method || 'GET';
    console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);
    // CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        });
        res.end();
        return;
    }
    // Health check
    if (pathname === '/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
    }
    // ── Cloudflare OAuth Login ────────────────────────────────────────────────
    if (pathname === '/api/auth/cloudflare' && method === 'GET') {
        const redirectUri = `${reqUrl.origin}/api/auth/cloudflare/callback`;
        const state = Math.random().toString(36).substring(2);
        const authUrl = new URL('https://dash.cloudflare.com/oauth2/auth');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', CF_CLIENT_ID);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        const scope = process.env.CF_SCOPE ||
            'account:read d1:write workers-kv-storage:write workers-r2:write workers-scripts:write';
        if (scope)
            authUrl.searchParams.set('scope', scope);
        authUrl.searchParams.set('state', state);
        console.log('[OAuth Redirect URL]:', authUrl.toString());
        res.writeHead(302, { Location: authUrl.toString() });
        res.end();
        return;
    }
    // ── Cloudflare OAuth Callback ─────────────────────────────────────────────
    if (pathname === '/api/auth/cloudflare/callback' && method === 'GET') {
        const code = reqUrl.searchParams.get('code');
        const errorParam = reqUrl.searchParams.get('error');
        const errorDesc = reqUrl.searchParams.get('error_description');
        const redirectUri = `${reqUrl.origin}/api/auth/cloudflare/callback`;
        if (!code) {
            console.error('[Cloudflare Auth Callback Error]:', {
                error: errorParam,
                description: errorDesc,
                query: Object.fromEntries(reqUrl.searchParams),
            });
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<h1>Authentication Failed</h1><p>${errorDesc || errorParam || 'Missing authorization code.'}</p>`);
            return;
        }
        try {
            const tokenRes = await fetch('https://dash.cloudflare.com/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: CF_CLIENT_ID,
                    ...(CF_CLIENT_SECRET ? { client_secret: CF_CLIENT_SECRET } : {}),
                    code,
                    redirect_uri: redirectUri,
                }),
            });
            const tokenData = (await tokenRes.json());
            const accessToken = tokenData.access_token || tokenData.result?.access_token;
            if (!accessToken) {
                throw new Error(tokenData.error_description || tokenData.errors?.[0]?.message || 'Failed to exchange OAuth token');
            }
            let userEmail = 'Cloudflare User';
            try {
                const userRes = await fetch('https://api.cloudflare.com/client/v4/user', {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                const userData = (await userRes.json());
                if (userData.result?.email)
                    userEmail = userData.result.email;
            }
            catch {
                // Non-fatal profile fetch fallback
            }
            const html = `<!DOCTYPE html>
<html>
<head><title>Cloudflare Authentication</title></head>
<body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center;">
    <h2>✓ Authenticated with Cloudflare</h2>
    <p>Logged in as ${userEmail}. Closing window...</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'cf-auth-success',
        token: ${JSON.stringify(accessToken)},
        email: ${JSON.stringify(userEmail)}
      }, '*');
    }
    setTimeout(function() { window.close(); }, 1200);
  </script>
</body>
</html>`;
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
            return;
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<h1>Authentication Error</h1><p>${err?.message || String(err)}</p>`);
            return;
        }
    }
    // ── One-click Deploy: POST /deploy-cloudflare ─────────────────────────────
    if (pathname === '/deploy-cloudflare' && method === 'POST') {
        const body = await parseBody(req);
        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });
        // Initial ping to establish connection
        res.write(': ping\n\n');
        // Periodic ping every 10s to keep connection alive on Render / proxies
        const pingInterval = setInterval(() => {
            try {
                res.write(': ping\n\n');
                if (typeof res.flush === 'function') {
                    res.flush();
                }
            }
            catch {
                clearInterval(pingInterval);
            }
        }, 10_000);
        const projectName = (body.projectName || `kyro-app-${Date.now()}`).trim();
        const adminEmail = body.adminEmail || `admin@${projectName}.local`;
        const adminPassword = body.adminPassword || generatePassword();
        const cloudflareApiToken = body.cloudflareApiToken || body.token || body.accessToken || process.env.CLOUDFLARE_API_TOKEN || '';
        if (!cloudflareApiToken) {
            clearInterval(pingInterval);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing Cloudflare API Token' }));
            return;
        }
        const workerName = (body.workerName || projectName).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const r2Bucket = (body.r2Bucket || 'kyro-media').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const dbName = (body.dbName || 'kyro-db').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        try {
            sendSSE(res, { type: 'info', step: 'start', message: '🚀 Fetching Kyro CMS core engine bundle…' });
            const scriptContent = await getKyroWorkerScript(body.bundleUrl);
            const result = await deployDirectToCloudflare({
                apiToken: cloudflareApiToken,
                workerName,
                r2BucketName: r2Bucket,
                dbName,
                adminEmail,
                adminPassword,
                scriptContent,
                onProgress: (step, message) => {
                    sendSSE(res, { type: 'info', step, message });
                },
            });
            sendSSE(res, {
                type: 'done',
                data: {
                    liveUrl: result.liveUrl,
                    adminEmail,
                    adminPassword,
                    accountId: result.accountId,
                    workerName: result.workerName,
                },
            });
        }
        catch (err) {
            console.error('[Deploy Error]:', err);
            const msg = err?.message ?? String(err);
            sendSSE(res, { type: 'error', step: 'deploy', message: msg });
        }
        finally {
            clearInterval(pingInterval);
            res.end();
        }
        return;
    }
    // 404 Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});
server.listen(PORT, () => {
    console.log(`🚀 Deploy Server running on port ${PORT}`);
});
//# sourceMappingURL=server.js.map