#!/usr/bin/env node
/**
 * Cypress Binary + npm Bootstrap (Portable, No-Shell)
 * -----------------------------------------------------------------------------
 * WHAT THIS DOES
 *  1) Builds a CYPRESS_INSTALL_BINARY URL to your private Nexus (with creds).
 *  2) Ensures NODE_EXTRA_CA_CERTS points at your local PEM bundle.
 *  3) Spawns:   node <npm-cli.js> install
 *     - No shell. No .cmd shims. Works on Windows + Linux.
 *  4) Optional --debug flag for verbose diagnostics.
 *
 * REQUIRED ENV
 *   NEXUS_USERNAME, NEXUS_PASSWORD  (token/user + token/pass)
 *
 * CONFIG (edit below)
 *   NEXUS_DOMAIN   e.g. "nexus.company.com:8081"
 *   CERT_FILENAME  PEM bundle sitting next to this script
 *
 * DEV NOTES
 *  - We run npm by resolving its JS entrypoint and spawning Node directly.
 *    This avoids Windows `spawn EINVAL` issues that often appear with shells.
 *  - We sanitize env vars to strings and normalize PATH on Windows.
 *  - We never print secrets. All logs are passed through a redactor.
 *  - By default we keep output quiet; add `--debug` to see details + npm verbose.
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
const NEXUS_DOMAIN  = 'nexus.company.com'; // include port if needed
const CERT_FILENAME = 'certificate.pem';   // PEM bundle co-located with this script

// ── Args: [--debug|-d] ────────────────────────────────────────────────────────
const argsRaw = process.argv.slice(2);
const debug = argsRaw.includes('--debug') || argsRaw.includes('-d');

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

// ── NPM args ──────────────────────────────────────────────────────────────────
function getNpmArgs(isDebug) {
  // Keep it quiet by default; turn on verbose when debugging.
  return isDebug ? ['install', '--verbose'] : ['install', '--silent'];
}

// ── Redact anything that might include creds ──────────────────────────────────
function redactFactory(username, password) {
  return (s) => {
    let out = s.toString().replace(/https?:\/\/[^/\s]+:[^@/\s]+@/g, 'https://***:***@');
    if (username) out = out.split(username).join('***');
    if (password) out = out.split(password).join('***');
    return out;
  };
}

// ── Env sanitization (Windows-safe) ───────────────────────────────────────────
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

// ── Resolve npm CLI JS entrypoint (no shell) ──────────────────────────────────
function resolveNpmCli() {
  const fromEnv = process.env.npm_execpath;
  const isJs = p => /\.([cm]?js)$/.test(p || '');
  const nodeDir = dirname(process.execPath);

  const attempts = [];
  if (fromEnv && isJs(fromEnv)) attempts.push(fromEnv);

  attempts.push(
    () => require.resolve('npm/bin/npm-cli.js'),
    () => join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  );

  for (const cand of attempts) {
    try {
      const p = typeof cand === 'function' ? cand() : cand;
      if (p && existsSync(p)) return p;
    } catch { /* try next */ }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
try {
  // 1) Fail fast if certificate missing
  const certPath = resolve(__dirname, CERT_FILENAME);
  if (!existsSync(certPath)) {
    console.error(`Certificate required but not found: ${certPath}`);
    console.error(`Update CERT_FILENAME in the Config section or place the PEM bundle next to this script.`);
    process.exit(1);
  }

  // 2) Build sanitized CYPRESS_INSTALL_BINARY
  const binaryUrl = new URL(`https://${NEXUS_DOMAIN}${getBinaryPath()}`);
  binaryUrl.username = encodeURIComponent(nexusUsername);
  binaryUrl.password = encodeURIComponent(nexusPassword);

  // 3) Prepare child env
  const childEnv = sanitizeEnv({
    ...process.env,
    NODE_EXTRA_CA_CERTS: certPath,
    CYPRESS_INSTALL_BINARY: binaryUrl.toString(),
    CYPRESS_CRASH_REPORTS: '0',
    CYPRESS_COMMERCIAL_RECOMMENDATIONS: '0',
  });

  // 4) Resolve npm CLI and args
  const npmCli   = resolveNpmCli();
  const nodeExec = process.env.npm_node_execpath || process.execPath;
  const npmArgs  = getNpmArgs(debug);

  if (!npmCli) {
    console.error('Could not resolve npm CLI entrypoint (npm/bin/npm-cli.js).');
    console.error('Ensure Node/npm are installed and available to this process.');
    process.exit(1);
  }

  // 5) Log what we’re about to do (redacted)
  const redact = redactFactory(nexusUsername, nexusPassword);
  if (debug) {
    console.log(`[debug] os=${platform()} arch=${arch()}`);
    console.log(`[debug] cert: ${certPath}`);
    console.log(`[debug] node: ${nodeExec}`);
    console.log(`[debug] npm cli: ${npmCli}`);
    console.log(`[debug] npm args: ${npmArgs.join(' ')}`);
    console.log(`[debug] cypress url (redacted): https://${NEXUS_DOMAIN}${getBinaryPath()}`);
  } else {
    console.log(`Running: npm ${npmArgs.join(' ')}`);
  }

  // 6) Spawn: node <npm-cli.js> install
  const child = spawn(nodeExec, [npmCli, ...npmArgs], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Quiet stdout unless debug; always show stderr (both redacted)
  if (debug) child.stdout.on('data', d => process.stdout.write(redact(d)));
  child.stderr.on('data', d => process.stderr.write(redact(d)));

  child.on('error', (err) => {
    console.error(`Failed to start npm: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    if (signal) {
      console.error(`npm terminated by signal: ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });

} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
