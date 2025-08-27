#### 1. In your scaffold project
node generate-overrides.js

#### 2. In a new project
rm -rf node_modules package-lock.json

#### 3. Make sure the main dependencies and devDependencies are added

#### 4. Copy the generated JSON content to a new project's package.json

#### 5. Install the modules
`npm install` or `pnpm install` or `yarn install`


#### Add this to package.json
```
{
  "scripts": {
    "cypress:install": "node install-cypress.mjs",
    "cypress:install:npm": "node install-cypress.mjs npm",
    "cypress:install:pnpm": "node install-cypress.mjs pnpm",
    "cypress:install:yarn": "node install-cypress.mjs yarn"
  }
}
```

```
# Default: npm, quiet
NEXUS_USERNAME='alice' NEXUS_PASSWORD='s3cr3t' node install-cypress.mjs

# npm, verbose debug
NEXUS_USERNAME='alice' NEXUS_PASSWORD='s3cr3t' node install-cypress.mjs --debug

# pnpm (positional)
NEXUS_USERNAME='alice' NEXUS_PASSWORD='s3cr3t' node install-cypress.mjs pnpm

# pnpm (flag) + debug
NEXUS_USERNAME='alice' NEXUS_PASSWORD='s3cr3t' node install-cypress.mjs --pm pnpm -d

# yarn
NEXUS_USERNAME='alice' NEXUS_PASSWORD='s3cr3t' node install-cypress.mjs yarn

```
