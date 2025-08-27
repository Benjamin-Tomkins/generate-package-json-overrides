#!/usr/bin/env node
/**
 * Cypress Binary Bootstrap (npm/pnpm/yarn, No Shell, Cross-Platform)
 * - Auto-detects the invoking package manager and reuses it.
 * - Flags:
 *     --clean-install  : do NOT inject binary URL or certs (public defaults)
 *     --debug|-d       : verbose logs
 * - Always injects: CYPRESS_CRASH_REPORTS=0, CYPRESS_COMMERCIAL_RECOMMENDATIONS=0
 */

import { spawn } from 'node:child_process';
import { platform, arch } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// If you ever need private binary mode again, set these and call WITHOUT --clean-install
const NEXUS_DOMAIN  = 'nexus.company.com'; // include port if needed
const CERT_FILENAME = 'certificate.pem';

const argv  = process.argv.slice(2);
const DEBUG = argv.includes('--debug') || argv.includes('-d');
const CLEAN = argv.includes('--clean-install');

function detectPackageManager() {
  const ua = process.env.npm_config_user_agent || '';
  if (/pnpm/i.test(ua)) return 'pnpm';
  if (/yarn/i.test(ua)) return 'yarn';
  if (/npm/i.test(ua))  return 'npm';
  const execpath = (process.env.npm_execpath || '').toLowerCase();
  if (execpath.includes('pnpm')) return 'pnpm';
  if (execpath.includes('yarn')) return 'yarn';
  return 'npm';
}

function getInstallArgs(pm, dbg) {
function getInstallArgs(pm, dbg) {
  switch (pm) {
    case 'npm':  return dbg ? ['install', '--verbose', '--no-fund'] : ['install', '--silent', '--no-fund'];
    case 'pnpm': return dbg 
      ? ['install', '--reporter', 'default', '--ignore-scripts=false'] 
      : ['install', '--reporter', 'silent', '--ignore-scripts=false'];
    case 'yarn': return dbg ? ['install', '--verbose'] : ['install', '--silent'];
    default:     return ['install'];
  }
}

function resolvePmCli(pm) {
  const isJs = p => /\.([cm]?js)$/.test(p || '');
  const fromEnv = process.env.npm_execpath;
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
      () => require.resolve('yarn/bin/yarn.js'),
      () => require.resolve('yarn/bin/yarn.cjs'),
      () => {
        const releases = join(process.cwd(), '.yarn', 'releases');
        if (!existsSync(releases)) throw new Error('no .yarn/releases');
        const files = readdirSync(releases).filter(f => f.startsWith('yarn-') && f.endsWith('.cjs')).sort().reverse();
        if (!files.length) throw new Error('no yarn-*.cjs in .yarn/releases');
        return join(releases, files[0]);
      }
    );
  }

  for (const cand of attempts) {
    try {
      const p = typeof cand === 'function' ? cand() : cand;
      if (p && existsSync(p)) return p;
    } catch { /* next */ }
  }
  return null;
}

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

(async () => {
  try {
    const pm      = detectPackageManager();
    const pmCli   = resolvePmCli(pm);
    const nodeExe = process.env.npm_node_execpath || process.execPath;
    const args    = getInstallArgs(pm, DEBUG);

    if (!pmCli) {
      console.error(`Could not resolve a JS CLI entrypoint for ${pm}.`);
      process.exit(1);
    }

    const childEnv = sanitizeEnv({ ...process.env });

    // Always set these two Cypress flags (clean or injected)
    childEnv.CYPRESS_CRASH_REPORTS = '0';
    childEnv.CYPRESS_COMMERCIAL_RECOMMENDATIONS = '0';

    let redact = (s) => s;

    if (CLEAN) {
      // Clean/public: ensure no private binary or PEM is injected
      delete childEnv.NODE_EXTRA_CA_CERTS;
      delete childEnv.CYPRESS_INSTALL_BINARY;
    } else {
      // Injected/private mode (not used in your Actions run, but supported)
      const certPath = resolve(__dirname, CERT_FILENAME);
      if (!existsSync(certPath)) {
        console.error(`Certificate required but not found: ${certPath}`);
        process.exit(1);
      }
      const user = process.env.NEXUS_USERNAME;
      const pass = process.env.NEXUS_PASSWORD;
      if (!user || !pass) {
        console.error('Missing NEXUS_USERNAME / NEXUS_PASSWORD');
        process.exit(1);
      }
      const binaryUrl = new URL(`https://${NEXUS_DOMAIN}${getBinaryPath()}`);
      binaryUrl.username = encodeURIComponent(user);
      binaryUrl.password = encodeURIComponent(pass);
      childEnv.NODE_EXTRA_CA_CERTS = certPath;
      childEnv.CYPRESS_INSTALL_BINARY = binaryUrl.toString();
      redact = redactFactory(user, pass);
    }

    if (DEBUG) {
      console.log(`[debug] pm=${pm}`);
      console.log(`[debug] node=${nodeExe}`);
      console.log(`[debug] pmCli=${pmCli}`);
      console.log(`[debug] pm args=${args.join(' ')}`);
      console.log(`[debug] clean-install=${CLEAN}`);
    } else {
      console.log(`Running: ${pm} ${args.join(' ')}${CLEAN ? ' (clean-install)' : ''}`);
    }

    const child = spawn(nodeExe, [pmCli, ...args], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (DEBUG) child.stdout.on('data', d => process.stdout.write(redact(d)));
    child.stderr.on('data', d => process.stderr.write(redact(d)));

    child.on('error', err => {
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
