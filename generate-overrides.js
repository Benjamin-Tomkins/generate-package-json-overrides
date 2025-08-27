#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

/**
 * Parse npm ls JSON output into overrides format
 */
function parseNpmLsToOverrides(lsData) {
  const overrides = {};
  
  function processPackage(name, packageInfo, parentKey = null) {
    if (!packageInfo?.version) return;
    
    const packageKey = `${name}@${packageInfo.version}`;
    const deps = {};
    
    // Process dependencies recursively
    if (packageInfo.dependencies) {
      for (const [depName, depInfo] of Object.entries(packageInfo.dependencies)) {
        if (depInfo.version && !depInfo.extraneous) {
          deps[depName] = depInfo.version;
          
          // Recursively process nested dependencies
          processPackage(depName, depInfo, packageKey);
        }
      }
    }
    
    // Only add to overrides if it has dependencies
    if (Object.keys(deps).length > 0) {
      overrides[packageKey] = Object.fromEntries(
        Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))
      );
    }
  }
  
  // Process all top-level dependencies
  if (lsData.dependencies) {
    for (const [name, info] of Object.entries(lsData.dependencies)) {
      processPackage(name, info);
    }
  }
  
  return overrides;
}

/**
 * Main function to generate overrides
 */
function generateOverrides() {
  console.log('🔒 Generating Dependency Overrides\n');
  
  // Check for package-lock.json
  if (!existsSync('package-lock.json')) {
    console.error('❌ package-lock.json not found. Run npm install first.');
    process.exit(1);
  }
  
  // Clean up any extraneous packages
  console.log('🧹 Cleaning up dependencies...');
  try {
    execSync('npm install', { stdio: 'pipe' });
    console.log('✅ Dependencies cleaned up');
  } catch (error) {
    console.error('❌ Failed to clean dependencies:', error.message);
    process.exit(1);
  }
  
  // Generate dependency tree as JSON
  console.log('📊 Generating dependency tree...');
  let lsOutput;
  try {
    lsOutput = execSync('npm ls --json --all', { encoding: 'utf8' });
  } catch (error) {
    // npm ls might exit with non-zero but still provide valid JSON
    lsOutput = error.stdout;
    if (!lsOutput) {
      console.error('❌ Failed to generate dependency tree');
      process.exit(1);
    }
  }
  
  // Parse JSON output
  let lsData;
  try {
    lsData = JSON.parse(lsOutput);
  } catch (error) {
    console.error('❌ Failed to parse npm ls output');
    process.exit(1);
  }
  
  // Generate overrides
  const overrides = parseNpmLsToOverrides(lsData);
  
  if (Object.keys(overrides).length === 0) {
    console.log('ℹ️  No packages found that need overrides');
    return;
  }
  
  // Create output
  const output = { overrides };
  // const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  // const filename = `overrides-${timestamp}.json`;
  const filename = `overrides.json`;
  
  // Save to file
  writeFileSync(filename, JSON.stringify(output, null, 2));
  
  // Display summary
  const packageCount = Object.keys(overrides).length;
  const totalDeps = Object.values(overrides).reduce((sum, deps) => sum + Object.keys(deps).length, 0);
  
  console.log(`\n✅ Generated overrides for ${packageCount} packages with ${totalDeps} dependencies`);
  console.log(`💾 Saved to: ${filename}`);
  
  // Show first few entries as preview
  console.log('\n📋 Preview (first 3 packages):');
  Object.entries(overrides).slice(0, 3).forEach(([pkg, deps]) => {
    console.log(`  📦 ${pkg}: ${Object.keys(deps).length} dependencies`);
    Object.entries(deps).slice(0, 3).forEach(([name, version]) => {
      console.log(`    └─ ${name}@${version}`);
    });
    if (Object.keys(deps).length > 3) {
      console.log(`    └─ ... and ${Object.keys(deps).length - 3} more`);
    }
  });
  
  if (packageCount > 3) {
    console.log(`  └─ ... and ${packageCount - 3} more packages`);
  }
  
  console.log(`\n📋 Copy the contents of ${filename} to your target project's package.json`);
  console.log('🚀 Then run: rm -rf node_modules package-lock.json && npm install');
  
  return filename;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    generateOverrides();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

export { generateOverrides };
