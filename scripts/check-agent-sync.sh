#!/usr/bin/env bash
set -euo pipefail

# Validates that all agent files in ralph-loop/agents.source/ are symlinks
# pointing to vscode-config-files/agents.source/ and none are broken.

AGENTS_DIR="$(cd "$(dirname "$0")/../agents.source" && pwd)"
CONFIG_AGENTS_DIR="$(cd "$(dirname "$0")/../../vscode-config-files/agents.source" 2>/dev/null && pwd)" || true

errors=0

if [ ! -d "$AGENTS_DIR" ]; then
	echo "FAIL: agents.source/ directory not found at $AGENTS_DIR"
	exit 1
fi

echo "Checking agent symlinks in $AGENTS_DIR ..."

for f in "$AGENTS_DIR"/*.agent.md; do
	name="$(basename "$f")"

	if [ ! -L "$f" ]; then
		echo "FAIL: $name is a regular file, expected symlink"
		errors=$((errors + 1))
		continue
	fi

	if [ ! -e "$f" ]; then
		echo "FAIL: $name is a broken symlink -> $(readlink "$f")"
		errors=$((errors + 1))
		continue
	fi

	target="$(readlink -f "$f")"
	if [ -n "$CONFIG_AGENTS_DIR" ] && [[ "$target" != "$CONFIG_AGENTS_DIR"/* ]]; then
		echo "WARN: $name resolves outside vscode-config-files/agents.source/ -> $target"
	fi

	echo "  OK: $name -> $(readlink "$f")"
done

total=$(ls "$AGENTS_DIR"/*.agent.md 2>/dev/null | wc -l)
symlinks=$(find "$AGENTS_DIR" -maxdepth 1 -name '*.agent.md' -type l | wc -l)

echo ""
echo "Total agents: $total | Symlinks: $symlinks | Errors: $errors"

if [ "$errors" -gt 0 ]; then
	echo "FAILED: $errors issue(s) found"
	exit 1
fi

if [ "$total" -ne "$symlinks" ]; then
	echo "FAILED: symlink count ($symlinks) does not match total ($total)"
	exit 1
fi

echo "All agent symlinks are valid."
exit 0
