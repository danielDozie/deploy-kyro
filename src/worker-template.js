/**
 * Kyro CMS Worker Script Fetcher
 * Downloads the pre-compiled Kyro CMS core bundle from GitHub Releases / Raw GitHub repository
 * and caches it in memory for fast, direct Cloudflare deployments.
 */
let cachedBundle = '';
let lastFetchTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // Cache for 10 minutes
// Configurable bundle URL (GitHub raw, GitHub release asset, or CDN)
const DEFAULT_GITHUB_BUNDLE_URL = process.env.KYRO_BUNDLE_URL ||
    'https://raw.githubusercontent.com/danielDozie/kyro/main/dist/worker.mjs';
/**
 * Fetch the latest Kyro CMS Core JavaScript bundle from GitHub
 */
export async function getKyroWorkerScript(customUrl) {
    const targetUrl = customUrl || DEFAULT_GITHUB_BUNDLE_URL;
    const now = Date.now();
    // Return cached bundle if still valid
    if (cachedBundle && now - lastFetchTime < CACHE_TTL_MS && !customUrl) {
        return cachedBundle;
    }
    try {
        console.log(`[Kyro Bundle] Fetching core bundle from GitHub: ${targetUrl}`);
        const res = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Kyro-Deploy-Server/1.0',
                ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
            },
        });
        if (res.ok) {
            const code = await res.text();
            if (code && code.length > 50) {
                cachedBundle = code;
                lastFetchTime = now;
                console.log(`[Kyro Bundle] Successfully fetched bundle from GitHub (${code.length} bytes)`);
                return code;
            }
        }
        console.warn(`[Kyro Bundle] GitHub fetch returned status ${res.status}. Using fallback template.`);
    }
    catch (err) {
        console.error(`[Kyro Bundle Error] Could not fetch bundle from GitHub:`, err?.message || err);
    }
    // Fallback template if GitHub bundle is not reachable or repository is private without token
    return getFallbackKyroWorkerScript();
}
/**
 * Fallback worker script when offline or if GitHub release asset is not reachable
 */
export function getFallbackKyroWorkerScript() {
    return `
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (pathname === '/api/health' || pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        cms: 'Kyro CMS',
        source: 'Fallback Engine',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        bindings: {
          hasD1: !!env.DB,
          hasR2: !!env.BUCKET,
          adminEmail: env.ADMIN_EMAIL || 'configured'
        }
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(\`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kyro CMS — Cloudflare Live Instance</title>
  <style>
    :root {
      --bg: #0d0f12;
      --card: #161920;
      --border: #262b36;
      --primary: #f97316;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2.5rem;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
    .badge {
      display: inline-block;
      background: rgba(249, 115, 22, 0.15);
      color: var(--primary);
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.8rem; }
    p { color: var(--text-muted); line-height: 1.5; margin-bottom: 1.5rem; }
    .info-box {
      background: #0d0f12;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }
    .info-row { display: flex; justify-content: space-between; padding: 4px 0; }
    .label { color: var(--text-muted); }
    .val { font-family: monospace; color: #38bdf8; }
    .btn {
      display: block;
      width: 100%;
      text-align: center;
      background: var(--primary);
      color: #fff;
      text-decoration: none;
      font-weight: 600;
      padding: 0.8rem;
      border-radius: 8px;
      box-sizing: border-box;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">⚡ Active Cloudflare Worker</div>
    <h1>Kyro CMS Live</h1>
    <p>Your Kyro CMS instance has been deployed to Cloudflare Workers with D1 Database & R2 Storage bindings attached.</p>
    
    <div class="info-box">
      <div class="info-row"><span class="label">Admin Email:</span> <span class="val">\${env.ADMIN_EMAIL || 'admin@kyro.local'}</span></div>
      <div class="info-row"><span class="label">D1 Binding:</span> <span class="val">\${env.DB ? 'Connected' : 'None'}</span></div>
      <div class="info-row"><span class="label">R2 Binding:</span> <span class="val">\${env.BUCKET ? 'Connected' : 'None'}</span></div>
    </div>

    <a href="/api/health" class="btn">View API Health Status</a>
  </div>
</body>
</html>\`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders }
    });
  }
};
`;
}
//# sourceMappingURL=worker-template.js.map