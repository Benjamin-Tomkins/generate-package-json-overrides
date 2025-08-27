#!/usr/bin/env node
/**
 * Cypress Binary + Package Manager Bootstrap (Portable, No-Shell)
 * ---------------------------------------------------------------------------
 * GOAL
 *  - Set up environment for Cypress to install its binary from a private Nexus,
 *    using a local PEM bundle, and then run a package manager install.
 *  - Work consistently on Windows + Linux without relying on `shell:true`.
 *
 * KEY DESIGN DECISIONS
 *  1) **No shell**: We never set `shell:true`. Windows `.cmd` shims are skipped.
 *     Instead we resolve each package manager's JS CLI and run:
 *         node <pm-cli.js> <args...>
 *     This avoids the common Windows `spawn EINVAL` issues.
 *
 *  2) **Env sanitization**: On Windows, CreateProcess is picky. We coerce all
 *     environment values to strings and ensure PATH is present (normalize PATH/Path).
 *
 *  3) **Credential redaction**: Any logs that might contain credentials are
 *     redacted before being printed.
 *
 *  4) **Fail-fast on certificate**: If the PEM bundle isn't present, we exit
 *     early with a clear message so you never leak into partial installs.
 *
 * HOW TO RUN (examples)
 *   PowerShell:
 *     $env:NEXUS_USERNAME="user"; $env:NEXUS_PASSWORD="token"
 *     node .\scripts\CypressInstaller.js --pm npm --debug
 *
 *   CMD:
 *     set NEXUS_USERNAME=user
 *     set NEXUS_PASSWORD=token
 *     node scripts\CypressInstaller.js -p pnpm
 *
 *   As an npm preinstall:
 *     // package.json
 *     { "scripts": { "preinstall": "node scripts/CypressInstaller.js --pm npm" } }
 *
 * NOTES
 *   - Set NEXUS_USERNAME/NEXUS_PASSWORD in your environment (token or user/pass).
 *   - Place CERT_FILENAME (PEM bundle) next to this script (or adjust path below).
 *   - Toggle/keep CYPRESS_COMMERCIAL_RECOMMENDATIONS as appropriate for your version.
 */

import { spawn } from 'node:child_process';
import { platform, arch } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ── Paths (Windows/Linux safe) ────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
// Include port if needed, e.g. "nexus.company.com:8081"
const NEXUS_DOMAIN   = 'nexus.company.com';
// Cert file name (PEM bundle) located next to this script
const CERT_FILENAME  = 'certificate.pem';

// Package managers we support
const validManagers  = ['npm', 'pnpm', 'yarn'];

// ── Arg parsing: [<pm>] [--pm <pm>] [--debug|-d] ─────────────────────────────
const argsRaw = process.argv.slice(2);
let packageManager = 'npm';
let debug = false;

for (let i = 0; i < argsRaw.length; i++) {
  const a = argsRaw[i];
  if (a === '--debug' || a === '-d') { debug = true; continue; }
  if ((a === '--pm' || a === '-p') && validManagers.includes(argsRaw[i + 1])) {
    packageManager = argsRaw[i + 1]; i++; continue;
  }
  if (validManagers.includes(a)) { packageManager = a; continue; }
}

if (!validManagers.includes(packageManager)) {
  console.error(`Invalid package manager: ${packageManager}`);
  console.error(`Valid options: ${validManagers.join(', ')}`);
  process.exit(1);
}

// ── Required env ──────────────────────────────────────────────────────────────
const nexusUsername = process.env.NEXUS_USERNAME;
const nexusPassword = process.env.NEXUS_PASSWORD;

if (!nexusUsername || !nexusPassword) {
  console.error('Missing required environment variables:');
  if (!nexusUsername) console.error('  NEXUS_USERNAME - Nexus authentication username/token');
  if (!nexusPassword) console.error('  NEXUS_PASSWORD - Nexus authentication password/token');
  process.exit(1);
}

// ── Platform → binary path ────────────────────────────────────────────────────
/**
 * Dev note:
 *  - Adjust these repo paths to match your Nexus layout. We branch by OS/arch.
 *  - Keep these as predictable/static endpoints; Cypress reads CYPRESS_INSTALL_BINARY.
 */
function getBinaryPath() {
  const os = platform();
  const architecture = arch();
  if (os === 'win32') return '/nexus/repository/cypress-binary/windows/cypress.zip';
  if (os === 'linux') {
    return architecture === 'x64'
      ? '/nexus/repository/cypress-binary/linux64/cypress.zip'
      : '/nexus/repository/cypress-binary/linux/cypress.zip';
  }
  throw new Error(`Unsupported platform: ${os}`);
}

// ── PM args (quiet by default; verbose only in --debug) ───────────────────────
/**
 * Dev note:
 *  - We keep output minimal by default to avoid leaking secrets or noise.
 *  - Flip to verbose/reporting when --debug is enabled.
 */
function getInstallArgs(pm, dbg) {
  switch (pm) {
    case 'npm':  return dbg ? ['install', '--verbose'] : ['install', '--silent'];
    case 'pnpm': return ['install', '--reporter', dbg ? 'default' : 'silent'];
    case 'yarn': return dbg ? ['install', '--verbose'] : ['install', '--silent'];
    default:     return ['install'];
  }
}

// ── PM install hints ──────────────────────────────────────────────────────────
function getInstallInstructions(pm) {
  if (pm === 'pnpm' || pm === 'yarn') {
    return 'Try: "corepack enable" (Node 16+) or install globally if Corepack is unavailable.';
  }
  return `Install ${pm} and ensure it's on PATH.`;
}

// ── Log redactor (avoid leaking secrets) ──────────────────────────────────────
function redactFactory(username, password) {
  return (s) => {
    let out = s.toString().replace(/https?:\/\/[^/\s]+:[^@/\s]+@/g, 'https://***:***@');
    if (username) out = out.split(username).join('***');
    if (password) out = out.split(password).join('***');
    return out;
  };
}

// ── Env sanitization (Windows-safe) ───────────────────────────────────────────
/**
 * Dev note:
 *  - Windows' CreateProcess rejects non-string env values and is picky about
 *    PATH casing. We coerce values to strings and ensure PATH exists.
 */
function sanitizeEnv(envIn) {
  const out = {};
  for (const [k, v] of Object.entries(envIn || {})) {
    if (v === undefined || v === null) continue;
    out[String(k)] = String(v);
  }
  if (process.platform === 'win32') {
    out.PATH = out.PATH || out.Path || out.path || process.env.Path || process.env.PATH || '';
  }
  return out;
}

// ── Resolve PM CLI JS entrypoint (no shell) ───────────────────────────────────
/**
 * Dev note:
 *  - We prefer running `node <pm-cli.js> ...` to avoid `.cmd` shims and shell.
 *  - Resolution order:
 *      1) `npm_execpath` (if in a PM lifecycle and it's a JS file)
 *      2) require.resolve known PM entrypoints
 *      3) Local Yarn Berry release under .yarn/releases (if present)
 *      4) Node installation directory fallbacks (some system images)
 *  - If we cannot resolve a JS entrypoint, we fail with guidance rather than
 *    falling back to `.cmd` (which often needs a shell on Windows).
 */
function resolvePmCli(pm) {
  const fromEnv = process.env.npm_execpath;
  const isJs = p => /\.([cm]?js)$/.test(p || '');
  const nodeDir = dirname(process.execPath);

  const attempts = [];
  if (fromEnv && isJs(fromEnv)) attempts.push(fromEnv);

  if (pm === 'npm') {
    attempts.push(
      () => require.resolve('npm/bin/npm-cli.js'),
      () => join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    );
  } else if (pm === 'pnpm') {
    attempts.push(
      () => require.resolve('pnpm/bin/pnpm.cjs'),
      () => join(nodeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    );
  } else if (pm === 'yarn') {
    attempts.push(
      // Yarn classic
      () => require.resolve('yarn/bin/yarn.js'),
      () => require.resolve('yarn/bin/yarn.cjs'),
      // Yarn Berry (kept in repo)
      () => {
        const releases = join(process.cwd(), '.yarn', 'releases');
        if (!existsSync(releases)) throw new Error('no local Yarn releases');
        const files = readdirSync(releases)
          .filter(f => f.startsWith('yarn-') && f.endsWith('.cjs'))
          .sort()
          .reverse();
        if (!files.length) throw new Error('no yarn-*.cjs in .yarn/releases');
        return join(releases, files[0]);
      }
    );
  }

  for (const cand of attempts) {
    try {
      const p = typeof cand === 'function' ? cand() : cand;
      if (p && existsSync(p)) return p;
    } catch { /* try next */ }
  }
  return null;
}

try {
  const binPath = getBinaryPath();

  // Cert must exist (fail-fast)
  const certPath = resolve(__dirname, CERT_FILENAME);
  if (!existsSync(certPath)) {
    console.error(`Certificate required but not found: ${certPath}`);
    console.error(`Update CERT_FILENAME in the Config section or place the PEM bundle next to this script.`);
    process.exit(1);
  }

  // Build URL with encoded creds (never print the full URL!)
  const binaryUrl = new URL(`https://${NEXUS_DOMAIN}${binPath}`);
  binaryUrl.username = encodeURIComponent(nexusUsername);
  binaryUrl.password = encodeURIComponent(nexusPassword);

  // Compose sanitized env for the child process
  const childEnv = sanitizeEnv({
    ...process.env,
    NODE_EXTRA_CA_CERTS: certPath,
    CYPRESS_INSTALL_BINARY: binaryUrl.toString(),
    CYPRESS_CRASH_REPORTS: '0',
    // Remove or keep depending on your Cypress version/policy:
    CYPRESS_COMMERCIAL_RECOMMENDATIONS: '0',
  });

  // Resolve PM CLI and construct args
  const pmArgs   = getInstallArgs(packageManager, debug);
  const nodeExec = process.env.npm_node_execpath || process.execPath; // Prefer PM's chosen Node if available
  const pmCli    = resolvePmCli(packageManager);

  if (!pmCli) {
    console.error(`Could not resolve a JS CLI entrypoint for ${packageManager}.`);
    console.error(`Hint: ${getInstallInstructions(packageManager)}`);
    process.exit(1);
  }

  // Debug info (sanitized)
  if (debug) {
    console.log(`[debug] os=${platform()} arch=${arch()}`);
    console.log(`[debug] cert: ${certPath}`);
    console.log(`[debug] node: ${nodeExec}`);
    console.log(`[debug] pm cli: ${pmCli}`);
    console.log(`[debug] pm args: ${pmArgs.join(' ')}`);
    console.log(`[debug] cypress url (redacted): https://${NEXUS_DOMAIN}${binPath}`);
  } else {
    console.log(`Running: ${packageManager} ${pmArgs.join(' ')}`);
  }

  // ── Execute package manager without a shell (portable) ─────────────────────
  /**
   * Dev note:
   *  - We spawn Node directly with the PM's CLI JS entrypoint.
   *  - stdio pipes let us redact secrets while still surfacing output.
   *  - windowsHide avoids flashing a console on Windows.
   */
  const child = spawn(nodeExec, [pmCli, ...pmArgs], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const redact = redactFactory(nexusUsername, nexusPassword);

  if (debug) {
    child.stdout.on('data', (d) => process.stdout.write(redact(d)));
  }
  child.stderr.on('data', (d) => process.stderr.write(redact(d)));

  child.on('error', (error) => {
    console.error(`Failed to start ${packageManager}: ${error.message}`);
    console.error(`${packageManager} may not be installed or resolvable as a JS CLI.`);
    console.error(`Hint: ${getInstallInstructions(packageManager)}`);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    if (signal) {
      console.error(`${packageManager} terminated by signal: ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });

} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
