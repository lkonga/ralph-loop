---
name: buildRalphVsix
description: Build and install the ralph-loop VSIX extension
argument-hint: "'rebuild' to rebuild current, or 'bump' to increment version first"
---

# Build Ralph Loop VSIX

Build, test, and install the ralph-loop VS Code extension as a local VSIX package.

## Usage

```
/buildRalphVsix
/buildRalphVsix rebuild
/buildRalphVsix bump
/buildRalphVsix --help
```

**Arguments** (free text after the command):
- `rebuild` — rebuild and reinstall from current source without version change
- `bump` — increment the patch version in `package.json` before building
- (no args) — same as `rebuild`
- `--help` — print this usage section and stop

**Examples:**
- `/buildRalphVsix` — build from current source and install
- `/buildRalphVsix bump` — bump patch version, build, and install
- `/buildRalphVsix rebuild` — clean rebuild of current version

## Prerequisites

- Node.js with npm
- `@vscode/vsce` (installed globally or via npx)
- VS Code or VS Code Insiders CLI (`code` / `code-insiders`)

## Build Sequence

Run all commands from the **ralph-loop workspace root** (the folder containing this prompt's `.github/` directory).

```bash
# 1. Run tests first (package script does this automatically)
npm test

# 2. Compile TypeScript
npm run compile

# 3. Package into VSIX
npx @vscode/vsce package --no-dependencies --allow-missing-repository

# 4. Install the VSIX
code-insiders --install-extension ralph-loop-*.vsix

# 5. Clean up the VSIX artifact (optional)
# rm ralph-loop-*.vsix
```

Alternatively, the `package` npm script combines test + package:

```bash
npm run package
code-insiders --install-extension ralph-loop-*.vsix
```

## Version Bump (if `bump` argument)

Before building, increment the patch version:

```bash
# Read current version
CURRENT=$(node -p "require('./package.json').version")

# Bump patch (e.g., 0.5.8 → 0.5.9)
npm version patch --no-git-tag-version

NEW=$(node -p "require('./package.json').version")
echo "Version bumped: $CURRENT → $NEW"
```

## Verification

After building, verify the VSIX:

```bash
# Check the VSIX was created
ls -la ralph-loop-*.vsix

# Inspect package metadata
unzip -p ralph-loop-*.vsix extension/package.json | python3 -c "
import sys, json
pkg = json.load(sys.stdin)
print(f\"Name: {pkg['name']}\")
print(f\"Version: {pkg['version']}\")
print(f\"Publisher: {pkg['publisher']}\")
print(f\"Activation: {pkg.get('activationEvents', 'N/A')}\")
"
```

## Post-Install

After installing, reload VS Code when prompted. The extension activates when a workspace contains `PRD.md`.
