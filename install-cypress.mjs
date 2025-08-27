#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { platform, arch } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Fixed nexus domain
const NEXUS_DOMAIN = 'nexus.company.com'; // Replace with your actual domain

// Get package manager from command line args, default to npm
const packageManager = process.argv[2] || 'npm';
const validManagers = ['npm', 'pnpm', 'yarn'];

if (!validManagers.includes(packageManager)) {
  console.error(`Invalid package manager: ${packageManager}`);
  console.error(`Valid options: ${validManagers.join(', ')}`);
  process.exit(1);
}

// Check for required environment variables
const nexusUsername = process.env.NEXUS_USERNAME;
const nexusPassword = process.env.NEXUS_PASSWORD;

if (!nexusUsername || !nexusPassword) {
  console.error('Missing required environment variables:');
  if (!nexusUsername) console.error('  NEXUS_USERNAME - Nexus authentication username token');
  if (!nexusPassword) console.error('  NEXUS_PASSWORD - Nexus authentication password token');
  process.exit(1);
}

// Determine OS and select appropriate URL
const getUrl = () => {
  const os = platform();
  const architecture = arch();
  
  if (os === 'win32') {
    return '/nexus/repository/cypress-binary/windows/cypress.zip';
  } else if (os === 'linux') {
    return architecture === 'x64' 
      ? '/nexus/repository/cypress-binary/linux64/cypress.zip'
      : '/nexus/repository/cypress-binary/linux/cypress.zip';
  } else {
    throw new Error(`Unsupported platform: ${os}`);
  }
};

// Get install command based on package manager
const getInstallArgs = (pm) => {
  switch (pm) {
    case 'npm': return ['install', '--verbose'];
    case 'pnpm': return ['install', '--reporter=default'];
    case 'yarn': return ['install', '--verbose'];
    default: return ['install', '--verbose'];
  }
};

// Get installation instructions for missing package managers
const getInstallInstructions = (pm) => {
  switch (pm) {
    case 'pnpm':
      return 'npm install -g pnpm';
    case 'yarn':
      return 'npm install -g yarn';
    default:
      return `Install ${pm} globally`;
  }
};

try {
  const url = getUrl();
  const certPath = resolve(__dirname, './certificate.pem');
  
  // Build environment variables
  const env = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: certPath,
    CYPRESS_INSTALL_BINARY: `https://${nexusUsername}:${nexusPassword}@${NEXUS_DOMAIN}${url}`,
    CYPRESS_CRASH_REPORTS: '0',
    CYPRESS_COMMERCIAL_RECOMMENDATIONS: '0'
  };
  
  const args = getInstallArgs(packageManager);
  console.log(`Running: ${packageManager} ${args.join(' ')}`);
  
  // Execute package manager install without shell
  const child = spawn(packageManager, args, {
    env,
    stdio: 'inherit',
    shell: false
  });
  
  child.on('close', (code) => {
    process.exit(code);
  });
  
  child.on('error', (error) => {
    console.error(`Failed to start ${packageManager}: ${error.message}`);
    console.error(`${packageManager} is not installed or not available in PATH`);
    console.error(`To install ${packageManager}, run: ${getInstallInstructions(packageManager)}`);
    process.exit(1);
  });
  
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
