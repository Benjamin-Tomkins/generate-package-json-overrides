#!/usr/bin/env node
/**
 * Cypress Binary Bootstrap (npm/pnpm/yarn, No Shell, Cross-Platform)
 * -----------------------------------------------------------------------------
 * WHAT IT DOES
 *  - Detects the invoking package manager (npm/pnpm/yarn) and reuses it.
 *  - Injects NODE_EXTRA_CA_CERTS and CYPRESS_INSTALL_BINARY (unless --clean-install).
 *  - Spawns: node <pm-cli.js> install   (no shell, Windows-safe).
 *  - Optional --debug for verbose logs; optional --clean-install to skip env injection.
 *
 * REQUIRED (unless --clean-install is used)
 *   NEXUS_USERNAME, NEXUS_PASSWORD
 *
 * CONFIG
 *   NEXUS_DOMAIN   e.g. "nexus.company.com:8081"
 *   CERT_FILENAME  PEM bundle next to this script
 *
 * NOTES
 *  - Redacts creds from any console output.
 *  - If you also run this as a lifecycle hook (e.g., preinstall), beware of recursion.
 *    This script is intended to be called as a standalone script: `* run cy:install`.
 */

import { spawn } from 'node:child_process';
import { platform, arch } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ── Paths ─────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
const NEXUS_DOMAIN  = 'nexus.company.com'; // include port if needed, e.g. example:8081
const CERT_FILENAME = 'certificate.pem';

// ── CLI Flags ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DEBUG = argv.includes('--debug') || argv.includes('-d');
const CLEAN = argv.includes('--clean-install'); // install without any env injection

// ── PM Detection ──────────────────────────────────────────────────────────────
function detectPackageManager() {
  // Most reliable: npm_config_user_agent e.g. "pnpm/9.6.0 npm/? node/v20.11.1 ..."
  const ua = process.env.npm_config_user_agent || '';
  if (/^pnpm\//i.test(ua) || /pnpm/i.test(ua)) return 'pnpm';
  if (/^yarn\//i.test(ua) || /yarn/i.test(ua)) return 'yarn';
  if (/^npm\//i.test(ua)  || /npm/i.test(ua))  return 'npm';

  // Fallback: npm_execpath often points to a JS file containing "pnpm" or "yarn"
  const execpath = (process.env.npm_execpath || '').toLowerCase();
  if (execpath.includes('pnpm')) return 'pnpm';
  if (execpath.includes('yarn')) return 'yarn';
  return 'npm'; // safe default
}

// ── PM Args (quiet by default; verbose in --debug) ────────────────────────────
function getInstallArgs(pm, dbg) {
  switch (pm) {
    case 'npm':  return dbg ? ['install', '--verbose'] : ['install', '--silent'];
    case 'pnpm': return dbg ? ['install', '--reporter', 'default'] : ['install', '--reporter', 'silent'];
    case 'yarn': return dbg ? ['install', '--verbose'] : ['install', '--silent'];
    default:     return ['install'];
  }
}

// ── Resolve PM CLI entrypoint (JS file) ───────────────────────────────────────
function resolvePmCli(pm) {
  const isJs = p => /\.([cm]?js)$/.test(p || '');
  const fromEnv = process.env.npm_execpath; // often already the JS CLI for pnpm/yarn
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
      // Yarn Berry in-repo .yarn/releases
      () => {
        const releases = join(process.cwd(), '.yarn', 'releases');
        if (!existsSync(releases)) throw new Error('no .yarn/releases');
        const files = readdirSync(releases)
          .filter(f => f.startsWith('yarn-') && f.endsWith('.cjs'))
          .sort().reverse();
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

// ── Redaction + Env Sanitize ──────────────────────────────────────────────────
function redactFactory(username, password) {
  return (s) => {
    let out = s.toString().replace(/https?:\/\/[^/\s]+:[^@/\s]+@/g, 'https://***:***@');
    if (username) out = out.split(username).join('***');
    if (password) out = out.split(password).join('***');
    return out;
  };
}

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

// ── Platform → binary path on Nexus ───────────────────────────────────────────
function getBinaryPath() {
  const os = platform();
  const a  = arch();
  if (os === 'win32') return '/nexus/repository/cypress-binary/windows/cypress.zip';
  if (os === 'linux')  return a === 'x64'
    ? '/nexus/repository/cypress-binary/linux64/cypress.zip'
    : '/nexus/repository/cypress-binary/linux/cypress.zip';
  if (os === 'darwin') return a === 'arm64'
    ? '/nexus/repository/cypress-binary/macos-arm64/cypress.zip'
    : '/nexus/repository/cypress-binary/macos-x64/cypress.zip';
  throw new Error(`Unsupported platform: ${os} ${a}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const pm = detectPackageManager();
    const pmCli = resolvePmCli(pm);
    const nodeExec = process.env.npm_node_execpath || process.execPath;
    const args = getInstallArgs(pm, DEBUG);

    if (!pmCli) {
      console.error(`Could not resolve a JS CLI entrypoint for ${pm}.`);
      console.error(`Ensure ${pm} is installed and resolvable (no shell used).`);
      process.exit(1);
    }

    // Build child environment
    const childEnv = sanitizeEnv({ ...process.env });
    let redact = (s) => s; // default no-op

    if (!CLEAN) {
      // Require creds and cert only in injected mode
      const certPath = resolve(__dirname, CERT_FILENAME);
      if (!existsSync(certPath)) {
        console.error(`Certificate required but not found: ${certPath}`);
        console.error(`Update CERT_FILENAME or place the PEM bundle next to this script.`);
        process.exit(1);
      }
      const user = process.env.NEXUS_USERNAME;
      const pass = process.env.NEXUS_PASSWORD;
      if (!user || !pass) {
        console.error('Missing required environment variables:');
        if (!user) console.error('  NEXUS_USERNAME - Nexus authentication username/token');
        if (!pass) console.error('  NEXUS_PASSWORD - Nexus authentication password/token');
        process.exit(1);
      }

      const binaryUrl = new URL(`https://${NEXUS_DOMAIN}${getBinaryPath()}`);
      binaryUrl.username = encodeURIComponent(user);
      binaryUrl.password = encodeURIComponent(pass);

      Object.assign(childEnv, {
        NODE_EXTRA_CA_CERTS: certPath,
        CYPRESS_INSTALL_BINARY: binaryUrl.toString(),
        CYPRESS_CRASH_REPORTS: '0',
        CYPRESS_COMMERCIAL_RECOMMENDATIONS: '0',
      });

      redact = redactFactory(user, pass);
    } else {
      // Explicitly remove any preexisting Cypress/NODE cert vars for a clean test
      delete childEnv.NODE_EXTRA_CA_CERTS;
      delete childEnv.CYPRESS_INSTALL_BINARY;
      delete childEnv.CYPRESS_CRASH_REPORTS;
      delete childEnv.CYPRESS_COMMERCIAL_RECOMMENDATIONS;
    }

    // Debug banner
    if (DEBUG) {
      console.log(`[debug] pm=${pm}`);
      console.log(`[debug] node=${nodeExec}`);
      console.log(`[debug] pmCli=${pmCli}`);
      console.log(`[debug] pm args=${args.join(' ')}`);
      if (!CLEAN) {
        console.log(`[debug] cert=${childEnv.NODE_EXTRA_CA_CERTS}`);
        console.log(`[debug] cypress url (redacted): https://${NEXUS_DOMAIN}${getBinaryPath()}`);
      } else {
        console.log('[debug] clean-install: Cypress env injection disabled');
      }
    } else {
      console.log(`Running: ${pm} ${args.join(' ')}${CLEAN ? ' (clean-install)' : ''}`);
    }

    // Spawn: node <pm-cli.js> install
    const child = spawn(nodeExec, [pmCli, ...args], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'], // pipe to allow redaction
      windowsHide: true,
    });

    if (DEBUG) child.stdout.on('data', (d) => process.stdout.write(redact(d)));
    child.stderr.on('data', (d) => process.stderr.write(redact(d)));

    child.on('error', (err) => {
      console.error(`Failed to start ${pm}: ${err.message}`);
      process.exit(1);
    });

    child.on('close', (code, signal) => {
      if (signal) {
        console.error(`${pm} terminated by signal: ${signal}`);
        process.exit(1);
      }
      process.exit(code ?? 1);
    });

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
