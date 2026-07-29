/**
 * installer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side dependency installation accelerator for the deploy server.
 *
 * Strategy:
 *  1. Detect the fastest available package manager on the server (pnpm > bun > npm)
 *  2. Use --prefer-offline / --frozen-lockfile where possible to hit local cache
 *  3. Warm the package store on server startup (background, non-blocking)
 *  4. Expose a single `fastInstall(projectDir, onProgress)` function used by headless.ts
 *
 * Expected speedup vs cold `npm install`:
 *  - pnpm warm store:  3–8s  (was 60–120s)
 *  - bun:              2–5s  (was 60–120s)
 *  - npm --prefer-offline: 15–30s (was 60–120s)
 */

import { spawnSync, spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// ── Package manager detection ─────────────────────────────────────────────────

type PkgManager = 'pnpm' | 'bun' | 'npm';

function detectPkgManager(): PkgManager {
  const check = (cmd: string) => {
    try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return true; } catch { return false; }
  };
  if (check('pnpm')) return 'pnpm';
  if (check('bun'))  return 'bun';
  return 'npm';
}

export const PKG_MANAGER: PkgManager = detectPkgManager();

console.log(`[installer] Package manager: ${PKG_MANAGER}`);

// ── Warm-up store (run once in background on server start) ───────────────────

const WARMUP_DEPS = [
  'astro@^6.3.1',
  '@astrojs/react@^5.0.4',
  '@tailwindcss/vite@^4.0.0',
  'tailwindcss@^4.0.0',
  'react@^19.0.0',
  'react-dom@^19.0.0',
  '@kyro-cms/core@latest',
  '@kyro-cms/admin@latest',
  'graphql@^16.10.0',
  'graphql-yoga@^5.21.2',
];

let warmupDone = false;
let warmupPromise: Promise<void> | null = null;

/**
 * Pre-warms the package manager store by installing core deps into a temp
 * directory. Subsequent deploys hit the local cache and install in seconds.
 * Called once at server startup — non-blocking.
 */
export function warmPackageStore(): Promise<void> {
  if (warmupDone || warmupPromise) return warmupPromise ?? Promise.resolve();

  warmupPromise = (async () => {
    const tmpDir = join(os.tmpdir(), `kyro-warmup-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });

    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'kyro-warmup', version: '0.0.1', type: 'module', private: true,
      dependencies: Object.fromEntries(
        WARMUP_DEPS.map(d => {
          const atIdx = d.lastIndexOf('@');
          return atIdx > 0 ? [d.slice(0, atIdx), d.slice(atIdx + 1)] : [d, 'latest'];
        })
      ),
    }, null, 2));

    const installArgs = PKG_MANAGER === 'pnpm'
      ? ['install', '--prefer-offline', '--no-frozen-lockfile', '--ignore-scripts', '--reporter=silent']
      : PKG_MANAGER === 'bun'
        ? ['install', '--no-save']
        : ['install', '--prefer-offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'];

    console.log(`[installer] Warming ${PKG_MANAGER} store in background…`);
    await new Promise<void>((resolve) => {
      const child = spawn(PKG_MANAGER, installArgs, {
        cwd: tmpDir,
        stdio: 'ignore',
        env: { ...process.env, npm_config_loglevel: 'error' },
        shell: true,
      });
      child.on('close', () => { warmupDone = true; resolve(); });
      child.on('error', () => resolve()); // non-fatal
    });
    console.log(`[installer] Store warm-up complete ✓`);
  })();

  return warmupPromise;
}

// ── Fast install ──────────────────────────────────────────────────────────────

/**
 * Install dependencies in projectDir using the fastest available method.
 * Streams progress to onProgress callback.
 */
export async function fastInstall(
  projectDir: string,
  onProgress: (step: string, detail?: string) => void
): Promise<void> {
  // Decide install command per package manager
  const [cmd, args] = (() => {
    if (PKG_MANAGER === 'pnpm') {
      const hasLockfile = existsSync(join(projectDir, 'pnpm-lock.yaml'));
      return ['pnpm', [
        'install',
        hasLockfile ? '--frozen-lockfile' : '--no-frozen-lockfile',
        '--prefer-offline',
        '--ignore-scripts',
        '--reporter=append-only',
      ]];
    }
    if (PKG_MANAGER === 'bun') {
      return ['bun', ['install', '--no-save']];
    }
    // npm fallback
    return ['npm', [
      'install',
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--legacy-peer-deps',
    ]];
  })();

  onProgress('install', `Installing dependencies with ${PKG_MANAGER}…`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: projectDir,
      shell: true,
      env: { ...process.env, npm_config_loglevel: 'error', ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1' },
    });

    let lastLine = '';
    const onData = (d: Buffer) => {
      const line = d.toString().trim();
      if (line && line !== lastLine) {
        lastLine = line;
        onProgress('install', line);
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${PKG_MANAGER} install failed with code ${code}`));
    });
    child.on('error', reject);
  });
}
