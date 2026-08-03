import { createServer } from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
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
// ── Template Warmup Store ───────────────────────────────────────────────────
const TEMPLATE_CACHE_DIR = join(os.tmpdir(), 'kyro-template-cache');
let isWarming = false;
let isTemplateReady = false;
async function warmTemplateStore() {
    if (isWarming || isTemplateReady)
        return;
    isWarming = true;
    console.log('[Template Warmup] ⚡ Pre-warming Kyro template in background…');
    try {
        if (!existsSync(TEMPLATE_CACHE_DIR)) {
            mkdirSync(TEMPLATE_CACHE_DIR, { recursive: true });
            await new Promise((resolve, reject) => {
                const child = spawn('git', ['clone', '--depth=1', 'https://github.com/danielDozie/kyro-cms.git', '.'], { cwd: TEMPLATE_CACHE_DIR, shell: true });
                child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git clone exited with code ${code}`))));
            });
            await new Promise((resolve, reject) => {
                const child = spawn('pnpm', ['install', '--ignore-scripts', '--prefer-offline', '--no-frozen-lockfile'], { cwd: TEMPLATE_CACHE_DIR, shell: true });
                child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pnpm install exited with code ${code}`))));
            });
        }
        isTemplateReady = true;
        console.log('[Template Warmup] ✔ Pre-installed Kyro template is READY for instant deploys!');
    }
    catch (err) {
        console.warn('[Template Warmup Warning]:', err);
        isTemplateReady = false;
    }
    finally {
        isWarming = false;
    }
}
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
        const workerName = (body.workerName || projectName).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const cloudflareApiToken = body.cloudflareApiToken || body.token || body.accessToken || process.env.CLOUDFLARE_API_TOKEN || '';
        if (!cloudflareApiToken) {
            clearInterval(pingInterval);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing Cloudflare API Token' }));
            return;
        }
        const deployId = randomBytes(4).toString('hex');
        const baseDir = join(os.tmpdir(), `kyro-deploy-${deployId}`);
        const projectDir = join(baseDir, projectName);
        mkdirSync(baseDir, { recursive: true });
        try {
            if (isTemplateReady && existsSync(TEMPLATE_CACHE_DIR)) {
                sendSSE(res, { type: 'info', step: 'scaffold', message: '⚡ Instantly copying pre-warmed Kyro CMS template…' });
                cpSync(TEMPLATE_CACHE_DIR, projectDir, { recursive: true });
                sendSSE(res, { type: 'success', step: 'scaffold', message: '✔ Pre-warmed Kyro template ready (0.2s)' });
            }
            else {
                // Fallback: Fetch & Install
                sendSSE(res, { type: 'info', step: 'scaffold', message: '⚡ Fetching Kyro CMS template from GitHub…' });
                await spawnStreaming(res, 'scaffold', 'git', ['clone', '--depth=1', 'https://github.com/danielDozie/kyro-cms.git', projectDir], { cwd: baseDir });
                sendSSE(res, { type: 'success', step: 'scaffold', message: `✔ Kyro CMS template fetched` });
                sendSSE(res, { type: 'info', step: 'install', message: '📦 Resolving dependencies (pnpm install)…' });
                await spawnStreaming(res, 'install', 'pnpm', ['install', '--ignore-scripts', '--prefer-offline', '--no-frozen-lockfile'], { cwd: projectDir });
                sendSSE(res, { type: 'success', step: 'install', message: '✔ Dependencies resolved' });
            }
            // 2. Build Astro project for Cloudflare Pages
            sendSSE(res, { type: 'info', step: 'build', message: '⚡ Compiling Astro + Kyro CMS for Cloudflare Pages (@astrojs/cloudflare)…' });
            const adminDir = join(projectDir, 'admin');
            await spawnStreaming(res, 'build', 'npx', ['astro', 'build'], {
                cwd: existsSync(adminDir) ? adminDir : projectDir,
                env: {
                    ...process.env,
                    CLOUDFLARE: 'true',
                    CF_PAGES: 'true',
                    ADMIN_EMAIL: adminEmail,
                    ADMIN_PASSWORD: adminPassword,
                },
            });
            sendSSE(res, { type: 'success', step: 'build', message: '✔ Astro Cloudflare bundle compiled (dist/)' });
            // 3. Deploy to Cloudflare Pages via Wrangler
            sendSSE(res, { type: 'info', step: 'deploy', message: `☁️ Deploying to Cloudflare Pages ("${workerName}")…` });
            const deployOutput = await spawnStreaming(res, 'deploy', 'npx', [
                'wrangler',
                'pages',
                'deploy',
                'dist',
                `--project-name=${workerName}`,
                '--branch=main',
                '--commit-dirty=true',
            ], {
                cwd: existsSync(adminDir) ? adminDir : projectDir,
                env: {
                    ...process.env,
                    CLOUDFLARE_API_TOKEN: cloudflareApiToken,
                },
            });
            // Extract live URL from wrangler output or construct fallback pages.dev URL
            let liveUrl = `https://${workerName}.pages.dev`;
            const urlMatch = deployOutput.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i);
            if (urlMatch) {
                liveUrl = urlMatch[0];
            }
            sendSSE(res, {
                type: 'done',
                data: {
                    liveUrl,
                    adminEmail,
                    adminPassword,
                    workerName,
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
            // Best-effort temp dir cleanup
            setTimeout(() => {
                try {
                    if (existsSync(baseDir))
                        rmSync(baseDir, { recursive: true, force: true });
                }
                catch { }
            }, 10_000);
        }
        return;
    }
    // 404 Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});
server.listen(PORT, () => {
    console.log(`🚀 Deploy Server running on port ${PORT}`);
    // Pre-warm template store in background on startup
    warmTemplateStore().catch(() => { });
});
//# sourceMappingURL=server.js.map