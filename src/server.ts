import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // .env file may be missing or already loaded
}

const PORT = Number(process.env.PORT) || 3099;

// Cloudflare OAuth App Client ID
const CF_CLIENT_ID = process.env.CF_CLIENT_ID || process.env.CLOUDFLARE_CLIENT_ID || '';
const CF_CLIENT_SECRET = process.env.CF_CLIENT_SECRET || process.env.CLOUDFLARE_CLIENT_SECRET || '';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function generatePassword(length = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/**
 * Spawn a subprocess and stream its output line-by-line as SSE events.
 * Resolves with the full stdout string when the process exits with code 0.
 * Rejects with an Error on non-zero exit.
 */
function spawnStreaming(
  res: ServerResponse,
  step: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
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

    const onData = (data: Buffer) => {
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
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
    const scope =
      process.env.CF_SCOPE ||
      'account:read d1:write workers-kv-storage:write workers-r2:write workers-scripts:write';
    if (scope) authUrl.searchParams.set('scope', scope);
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
      res.end(
        `<h1>Authentication Failed</h1><p>${errorDesc || errorParam || 'Missing authorization code.'}</p>`
      );
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

      const tokenData = (await tokenRes.json()) as any;
      const accessToken = tokenData.access_token || tokenData.result?.access_token;

      if (!accessToken) {
        throw new Error(
          tokenData.error_description || tokenData.errors?.[0]?.message || 'Failed to exchange OAuth token'
        );
      }

      let userEmail = 'Cloudflare User';
      try {
        const userRes = await fetch('https://api.cloudflare.com/client/v4/user', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const userData = (await userRes.json()) as any;
        if (userData.result?.email) userEmail = userData.result.email;
      } catch {
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
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authentication Error</h1><p>${err?.message || String(err)}</p>`);
      return;
    }
  }

  // ── One-click Deploy: POST /deploy-cloudflare ─────────────────────────────
  if (pathname === '/deploy-cloudflare' && method === 'POST') {
    const body = await parseBody<any>(req);

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
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      } catch {
        clearInterval(pingInterval);
      }
    }, 10_000);

    const projectName = (body.projectName || `kyro-app-${Date.now()}`).trim();
    const template: string = body.template || 'minimal';
    const database: string = body.database === 'postgres' ? 'postgres' : 'sqlite';
    const adminEmail: string = body.adminEmail || `admin@${projectName}.local`;
    const adminPassword: string =
      body.adminPassword || generatePassword();

    const cloudflareApiToken: string =
      body.cloudflareApiToken || body.token || body.accessToken || '';

    const workerName: string = (body.workerName || projectName).trim();
    const r2Bucket: string = (body.r2Bucket || `kyro-media-${Date.now()}`).trim();
    const databaseUrl: string = body.databaseUrl || '';
    const hyperdriveName: string = body.hyperdriveName || '';

    // Create a unique temp directory for this deployment
    const deployId = randomBytes(4).toString('hex');
    const baseDir = join(os.tmpdir(), `kyro-deploy-${deployId}`);
    const projectDir = join(baseDir, projectName);
    mkdirSync(baseDir, { recursive: true });

    try {
      // ── Step 1: Scaffold ──────────────────────────────────────────────────
      sendSSE(res, { type: 'info', step: 'scaffold', message: '🛠  Bootstrapping fresh Kyro project…' });

      await spawnStreaming(
        res,
        'scaffold',
        'npx',
        [
          '--yes',
          'create-kyro@latest',
          projectDir,
          `--template=${template}`,
          `--database=${database}`,
          `--admin-email=${adminEmail}`,
          '--non-interactive',
        ],
        { cwd: baseDir, env: { ...process.env, npm_config_loglevel: 'warn' } }
      );

      sendSSE(res, {
        type: 'success',
        step: 'scaffold',
        message: `✔ Project scaffolded in ${projectDir}`,
      });

      // ── Step 2: Deploy via CLI ────────────────────────────────────────────
      sendSSE(res, {
        type: 'info',
        step: 'deploy',
        message: '☁️  Deploying to Cloudflare Workers via CLI…',
      });

      const cliArgs = [
        '@kyro-cms/core',
        'deploy',
        'cloudflare',
        '--non-interactive',
        '--quiet',
        '--json',
        '--name', workerName,
        '--r2-bucket', r2Bucket,
        '--email', adminEmail,
        '--password', adminPassword,
      ];

      if (database === 'postgres') {
        cliArgs.push('--database', 'postgres');
        if (databaseUrl) cliArgs.push('--database-url', databaseUrl);
        if (hyperdriveName) cliArgs.push('--hyperdrive-name', hyperdriveName);
      }

      const cliEnv: NodeJS.ProcessEnv = {
        ...process.env,
        // Pass the Cloudflare token so wrangler can auth without a browser login
        ...(cloudflareApiToken ? { CLOUDFLARE_API_TOKEN: cloudflareApiToken } : {}),
      };

      const cliOutput = await spawnStreaming(
        res,
        'deploy',
        'npx',
        cliArgs,
        { cwd: projectDir, env: cliEnv }
      );

      // Parse the final JSON line emitted by `kyro deploy cloudflare --json`
      const lines = cliOutput.split('\n').reverse();
      let resultData: { ok: boolean; liveUrl?: string; adminEmail?: string; adminPassword?: string } | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed.ok === 'boolean') {
              resultData = parsed;
              break;
            }
          } catch {
            // not the JSON line we're looking for
          }
        }
      }

      if (!resultData?.ok) {
        throw new Error(resultData?.adminEmail ?? 'Deploy CLI did not report success');
      }

      sendSSE(res, {
        type: 'done',
        data: {
          liveUrl: resultData.liveUrl ?? '',
          adminEmail: resultData.adminEmail ?? adminEmail,
          adminPassword: resultData.adminPassword ?? adminPassword,
        },
      });
    } catch (err: any) {
      console.error('[Deploy Error]:', err);
      const msg = err?.message ?? String(err);
      sendSSE(res, { type: 'error', step: 'deploy', message: msg });
    } finally {
      clearInterval(pingInterval);
      res.end();
      // Clean up temp dir in background (non-blocking, best-effort)
      setTimeout(() => {
        try {
          if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
        } catch {
          // non-fatal
        }
      }, 5_000);
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
