#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { platform, arch } from 'node:os';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Paths (Windows/Linux safe) ────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
// Include port if needed, e.g. "nexus.company.com:8081"
const NEXUS_DOMAIN   = 'nexus.company.com';
// Cert file name (PEM bundle) located next to this script
const CERT_FILENAME  = 'certificate.pem';

const validManagers  = ['npm', 'pnpm', 'yarn'];

// ── Args: [<pm>] [--pm <pm>] [--debug|-d] ─────────────────────────────────────
const argsRaw = process.argv.slice(2);
let packageManager = 'npm';
let debug = false;

for (let i = 0; i < argsRaw.length; i++) {
  const a = argsRaw[i];
  if (a === '--debug' || a === '-d') { debug = true; continue; }
  if ((a === '--pm' || a === '-p') && validManagers.includes(argsRaw[i + 1])) { packageManager = argsRaw[i + 1]; i++; continue; }
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
const getBinaryPath = () => {
  const os = platform();
  const architecture = arch();
  if (os === 'win32') return '/nexus/repository/cypress-binary/windows/cypress.zip';
  if (os === 'linux') {
    return architecture === 'x64'
      ? '/nexus/repository/cypress-binary/linux64/cypress.zip'
      : '/nexus/repository/cypress-binary/linux/cypress.zip';
  }
  throw new Error(`Unsupported platform: ${os}`);
};

// ── PM args (quiet by default; verbose only in --debug) ───────────────────────
const getInstallArgs = (pm, dbg) => {
  switch (pm) {
    case 'npm':  return dbg ? ['install', '--verbose'] : ['install', '--silent'];
    case 'pnpm': return ['install', '--reporter', dbg ? 'default' : 'silent'];
    case 'yarn': return dbg ? ['install', '--verbose'] : ['install', '--silent'];
    default:     return ['install'];
  }
};

// ── PM install hints ──────────────────────────────────────────────────────────
const getInstallInstructions = (pm) => {
  if (pm === 'pnpm' || pm === 'yarn') {
    return 'Try: "corepack enable" (Node 16+) or install globally if Corepack is unavailable.';
  }
  return `Install ${pm} and ensure it's on PATH.`;
};

// ── Log redactor (avoid leaking secrets) ──────────────────────────────────────
const redactFactory = (username, password) => (s) => {
  let out = s.toString().replace(/https?:\/\/[^/\s]+:[^@/\s]+@/g, 'https://***:***@');
  if (username) out = out.split(username).join('***');
  if (password) out = out.split(password).join('***');
  return out;
};

try {
  const binPath = getBinaryPath();

  // Cert must exist (fail-fast)
  const certPath = resolve(__dirname, CERT_FILENAME);
  if (!existsSync(certPath)) {
    console.error(`Certificate required but not found: ${certPath}`);
    console.error(`Update CERT_FILENAME in the Config section or place the PEM bundle next to this script.`);
    process.exit(1);
  }

  // Build URL with encoded creds
  const binaryUrl = new URL(`https://${NEXUS_DOMAIN}${binPath}`);
  binaryUrl.username = encodeURIComponent(nexusUsername);
  binaryUrl.password = encodeURIComponent(nexusPassword);

  // Compose env
  const env = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: certPath,
    CYPRESS_INSTALL_BINARY: binaryUrl.toString(),
    CYPRESS_CRASH_REPORTS: '0',
    // Remove if not supported in your Cypress version:
    CYPRESS_COMMERCIAL_RECOMMENDATIONS: '0',
  };

  const pmArgs = getInstallArgs(packageManager, debug);
  const isWin = platform() === 'win32';
  const exe = isWin ? `${packageManager}.cmd` : packageManager;

  // Debug info (sanitized)
  if (debug) {
    console.log(`[debug] os=${platform()} arch=${arch()}`);
    console.log(`[debug] cert: ${certPath}`);
    console.log(`[debug] pm: ${exe} ${pmArgs.join(' ')}`);
    console.log(`[debug] cypress url (redacted): https://${NEXUS_DOMAIN}${binPath}`);
  } else {
    console.log(`Running: ${packageManager} ${pmArgs.join(' ')}`);
  }

  // Execute package manager (pipe + redact)
  const child = spawn(exe, pmArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  const redact = redactFactory(nexusUsername, nexusPassword);

  if (debug) {
    child.stdout.on('data', (d) => process.stdout.write(redact(d)));
  }
  child.stderr.on('data', (d) => process.stderr.write(redact(d)));

  child.on('error', (error) => {
    console.error(`Failed to start ${packageManager}: ${error.message}`);
    console.error(`${packageManager} is not installed or not available on PATH.`);
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
