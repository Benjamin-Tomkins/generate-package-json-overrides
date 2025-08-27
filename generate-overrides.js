#!/usr/bin/env node
// generate-overrides.mjs

import { writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * CLI args
 *   -p, --packages   Comma or space separated list (e.g. "cypress,@foo/bar")
 *   -o, --output     Output file name (default: overrides.json)
 *   --no-clean       Skip the "npm install" cleanup step
 *   -h, --help
 */
function parseArgs(argv) {
  const args = { packages: [], output: 'overrides.json', clean: true };
  const raw = argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '-p' || a === '--packages') {
      const v = raw[++i] || '';
      args.packages.push(...v.split(/[,\s]+/).map(s => s.trim()).filter(Boolean));
    } else if (a === '-o' || a === '--output') {
      args.output = raw[++i] || args.output;
    } else if (a === '--no-clean') {
      args.clean = false;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else {
      // allow bare names at the end:  node script.mjs cypress @scope/pkg
      args.packages.push(...a.split(/[,\s]+/).map(s => s.trim()).filter(Boolean));
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node generate-overrides.mjs [options] [package ...]
Options:
  -p, --packages  Comma/space separated package list to target (default: all)
  -o, --output    Output file (default: overrides.json)
  --no-clean      Skip "npm install" cleanup before building the tree
  -h, --help      Show this help

Examples:
  node generate-overrides.mjs
  node generate-overrides.mjs -p cypress
  node generate-overrides.mjs --packages "cypress,@testing-library/cypress" -o cypress-overrides.json
`);
}

/**
 * Parse npm ls JSON output into overrides format
 * If 'targets' is empty → include all packages.
 */
function parseNpmLsToOverrides(lsData, targets = []) {
  const wantAll = targets.length === 0;
  const targetSet = new Set(targets);
  const overrides = {};

  function processPackage(name, packageInfo) {
    if (!packageInfo?.version) return;

    // Recurse first so we walk the whole tree regardless of filter
    if (packageInfo.dependencies) {
      for (const [depName, depInfo] of Object.entries(packageInfo.dependencies)) {
        if (depInfo && !depInfo.extraneous) {
          processPackage(depName, depInfo);
        }
      }
    }

    // Build the dependency pin set for the current node
    const deps = {};
    if (packageInfo.dependencies) {
      for (const [depName, depInfo] of Object.entries(packageInfo.dependencies)) {
        if (depInfo?.version && !depInfo.extraneous) {
          deps[depName] = depInfo.version;
        }
      }
    }

    // Only add if:
    //  - it has deps to pin, and
    //  - it's targeted OR we want all
    if (Object.keys(deps).length > 0 && (wantAll || targetSet.has(name))) {
      const packageKey = `${name}@${packageInfo.version}`;
      overrides[packageKey] = Object.fromEntries(
        Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))
      );
    }
  }

  if (lsData?.dependencies) {
    for (const [name, info] of Object.entries(lsData.dependencies)) {
      if (info && !info.extraneous) {
        processPackage(name, info);
      }
    }
  }

  return overrides;
}

/**
 * Main
 */
function generateOverrides({ packages, output, clean }) {
  console.log('🔒 Generating Dependency Overrides\n');

  // 1) Check lockfile
  if (!existsSync('package-lock.json')) {
    console.error('❌ package-lock.json not found. Run "npm install" first.');
    process.exit(1);
  }

  // 2) Optional cleanup to remove extraneous stuff and sync lock
  if (clean) {
    console.log('🧹 Cleaning up dependencies with "npm install"...');
    try {
      // Stream output to console to avoid buffer limits on Windows
      execSync('npm install', { stdio: 'inherit' });
      console.log('✅ Dependencies cleaned up');
    } catch (error) {
      console.error('❌ Failed to clean dependencies.');
      process.exit(1);
    }
  } else {
    console.log('⏭️  Skipping cleanup (--no-clean)');
  }

  // 3) Build dependency tree (allow very large output)
  console.log('📊 Generating dependency tree (npm ls --all --json)...');
  let lsOutput;
  try {
    lsOutput = execSync('npm ls --json --all', {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 256 // 256 MB to be safe on Windows
    });
  } catch (error) {
    // npm ls may exit non-zero but still have valid JSON in stdout
    lsOutput = error?.stdout?.toString?.() || '';
    if (!lsOutput) {
      console.error('❌ Failed to generate dependency tree (no JSON output).');
      console.error(error?.message || error);
      process.exit(1);
    }
  }

  let lsData;
  try {
    lsData = JSON.parse(lsOutput);
  } catch {
    console.error('❌ Failed to parse npm ls output as JSON.');
    process.exit(1);
  }

  // 4) Build overrides
  const overrides = parseNpmLsToOverrides(lsData, packages);

  if (Object.keys(overrides).length === 0) {
    console.log(
      packages.length
        ? `ℹ️  No matching packages found to override for: ${packages.join(', ')}`
        : 'ℹ️  No packages found that need overrides'
    );
    return;
  }

  // 5) Write file
  writeFileSync(output, JSON.stringify({ overrides }, null, 2));

  // 6) Summary
  const packageCount = Object.keys(overrides).length;
  const totalDeps = Object.values(overrides).reduce((sum, deps) => sum + Object.keys(deps).length, 0);

  console.log(`\n✅ Generated overrides for ${packageCount} packages with ${totalDeps} pinned dependencies`);
  console.log(`💾 Saved to: ${output}`);

  console.log('\n📋 Preview (first 3):');
  Object.entries(overrides).slice(0, 3).forEach(([pkg, deps]) => {
    const entries = Object.entries(deps);
    console.log(`  📦 ${pkg}: ${entries.length} dependencies`);
    entries.slice(0, 3).forEach(([name, version]) => console.log(`    └─ ${name}@${version}`));
    if (entries.length > 3) console.log(`    └─ ... and ${entries.length - 3} more`);
  });

  if (packageCount > 3) {
    console.log(`  └─ ... and ${packageCount - 3} more packages`);
  }

  console.log(`\n📋 Copy the "overrides" object from ${output} into your target project's package.json`);
  console.log('🚀 Then run: rm -rf node_modules package-lock.json && npm install');
}

// --- Run if called directly (Windows-safe) ---
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  try {
    generateOverrides(args);
  } catch (err) {
    console.error('❌ Error:', err?.message || err);
    process.exit(1);
  }
}

export { generateOverrides };
