import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { URL } from 'node:url';
import { createProject } from '@kyro-cms/create-kyro/headless';
import { deployCloudflare } from '@kyro-cms/create-kyro/deployers/cloudflare';
import { warmPackageStore, fastInstall, PKG_MANAGER } from './installer.js';

try {
  process.loadEnvFile();
} catch {
  // .env file may be missing or already loaded
}

const PORT = Number(process.env.PORT) || 3099;

// Cloudflare OAuth App Client ID (Wrangler OAuth ID or custom app ID)
const CF_CLIENT_ID = process.env.CF_CLIENT_ID || process.env.CLOUDFLARE_CLIENT_ID || '';
const CF_CLIENT_SECRET = process.env.CF_CLIENT_SECRET || process.env.CLOUDFLARE_CLIENT_SECRET || '';

function sendSSE(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof (res as any).flush === 'function') {
    (res as any).flush();
  }
}

function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({} as T);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost:3099'}`);
  const pathname = reqUrl.pathname;
  const method = req.method || 'GET';

  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

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
  if (pathname === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // ── Cloudflare OAuth Login Endpoint ──────────────────────────────────────
  if (pathname === '/api/auth/cloudflare' && method === 'GET') {
    const redirectUri = `${reqUrl.origin}/api/auth/cloudflare/callback`;
    const state = Math.random().toString(36).substring(2);

    const authUrl = new URL('https://dash.cloudflare.com/oauth2/auth');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CF_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    const scope = process.env.CF_SCOPE || 'account:read d1:write workers-kv-storage:write workers-r2:write workers-scripts:write';
    if (scope) {
      authUrl.searchParams.set('scope', scope);
    }
    authUrl.searchParams.set('state', state);

    console.log('[OAuth Redirect URL]:', authUrl.toString());
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  // ── Cloudflare OAuth Callback Endpoint ──────────────────────────────────
  if (pathname === '/api/auth/cloudflare/callback' && method === 'GET') {
    const code = reqUrl.searchParams.get('code');
    const errorParam = reqUrl.searchParams.get('error');
    const errorDesc = reqUrl.searchParams.get('error_description');
    const redirectUri = `${reqUrl.origin}/api/auth/cloudflare/callback`;

    if (!code) {
      console.error('[Cloudflare Auth Callback Error]:', { error: errorParam, description: errorDesc, query: Object.fromEntries(reqUrl.searchParams) });
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authentication Failed</h1><p>${errorDesc || errorParam || 'Missing authorization code.'}</p>`);
      return;
    }

    try {
      // Exchange code for OAuth access_token
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

      const tokenData = (await tokenRes.json()) as any;
      const accessToken = tokenData.access_token || tokenData.result?.access_token;

      if (!accessToken) {
        throw new Error(tokenData.error_description || tokenData.errors?.[0]?.message || 'Failed to exchange OAuth token');
      }

      // Get authenticated user info
      let userEmail = 'Cloudflare User';
      try {
        const userRes = await fetch('https://api.cloudflare.com/client/v4/user', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const userData = (await userRes.json()) as any;
        if (userData.result?.email) {
          userEmail = userData.result.email;
        }
      } catch {
        // Non-fatal profile fetch fallback
      }

      // Send postMessage back to parent window (DeployModal popup handler) and close popup
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
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authentication Error</h1><p>${err?.message || String(err)}</p>`);
      return;
    }
  }

  // One-click deploy endpoint: POST /deploy-cloudflare
  if (pathname === '/deploy-cloudflare' && method === 'POST') {
    const body = await parseBody<any>(req);

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
      // Use server-side fast installer instead of the default npm install
      installer: (projectDir, onProgress) => fastInstall(projectDir, onProgress),
      onProgress(step: string, detail?: string) {
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
      cloudflareApiToken: body.cloudflareApiToken || body.token || body.accessToken,
      packager: PKG_MANAGER,
    });

    for await (const event of deployer) {
      sendSSE(res, event);
      if (event.type === 'done' || event.type === 'error') break;
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
  // Warm package store in background so first deploy is fast
  warmPackageStore().catch(() => {});
});
