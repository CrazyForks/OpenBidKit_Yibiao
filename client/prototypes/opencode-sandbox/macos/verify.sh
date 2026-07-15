#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$CLIENT_ROOT/.." && pwd)"
BUNDLE_ID="com.yibiao.opencodesandboxprototype"

case "$(uname -m)" in
    arm64) VENDOR_ARCH="arm64" ;;
    x86_64) VENDOR_ARCH="x64" ;;
    *)
        echo "Unsupported macOS architecture: $(uname -m)" >&2
        exit 2
        ;;
esac

if [[ $# -gt 0 ]]; then
    OPENCODE_SOURCE="$1"
else
    OPENCODE_SOURCE="$CLIENT_ROOT/vendor/opencode/darwin-$VENDOR_ARCH/opencode"
fi

if [[ ! -x "$OPENCODE_SOURCE" ]]; then
    echo "OpenCode executable not found: $OPENCODE_SOURCE" >&2
    exit 2
fi

for command in clang codesign mktemp; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "Required system command not found: $command" >&2
        exit 2
    fi
done

TMP_BASE="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
if [[ -z "$TMP_BASE" ]]; then
    TMP_BASE="/tmp"
fi
TMP_BASE="${TMP_BASE%/}"
BUILD_ROOT="$(mktemp -d "$TMP_BASE/yibiao-opencode-sandbox.XXXXXX")"
APP="$BUILD_ROOT/OpenCodeSandboxPrototype.app"
CONTENTS="$APP/Contents"
LAUNCHER="$CONTENTS/MacOS/OpenCodeSandboxLauncher"
BUNDLED_OPENCODE="$CONTENTS/Resources/opencode"
CONTAINER_ROOT="$HOME/Library/Containers/$BUNDLE_ID"

cleanup() {
    case "$BUILD_ROOT" in
        "$TMP_BASE"/yibiao-opencode-sandbox.*)
            rm -rf -- "$BUILD_ROOT"
            ;;
    esac
    if [[ "$CONTAINER_ROOT" == "$HOME/Library/Containers/$BUNDLE_ID" ]]; then
        rm -rf -- "$CONTAINER_ROOT"
    fi
}
trap cleanup EXIT

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$SCRIPT_DIR/Info.plist" "$CONTENTS/Info.plist"
cp "$OPENCODE_SOURCE" "$BUNDLED_OPENCODE"
chmod 755 "$BUNDLED_OPENCODE"

clang -x objective-c -std=c11 -Wall -Wextra -Werror \
    "$SCRIPT_DIR/launcher.c" -o "$LAUNCHER" \
    -framework Foundation

codesign --force --sign - \
    --identifier "$BUNDLE_ID.opencode" \
    --entitlements "$SCRIPT_DIR/opencode.entitlements" \
    "$BUNDLED_OPENCODE"

codesign --force --sign - \
    --identifier "$BUNDLE_ID" \
    --entitlements "$SCRIPT_DIR/launcher.entitlements" \
    "$APP"

codesign --verify --strict --verbose=2 "$APP"
codesign --verify --strict --verbose=2 "$BUNDLED_OPENCODE"
codesign --display --entitlements :- "$APP" 2>&1
codesign --display --entitlements :- "$BUNDLED_OPENCODE" 2>&1

PATHS_OUTPUT="$("$LAUNCHER" debug paths 2>&1)"
PATHS_CODE=$?
printf '%s\n' "$PATHS_OUTPUT"
if [[ $PATHS_CODE -ne 0 ]]; then
    echo "Sandboxed OpenCode debug paths failed." >&2
    exit 1
fi
if [[ "$PATHS_OUTPUT" != *"opencode-sandbox-prototype"* ]]; then
    echo "OpenCode paths did not use the isolated runtime root." >&2
    exit 1
fi

INSIDE_OUTPUT="$("$LAUNCHER" --read inside.txt 2>&1)"
INSIDE_CODE=$?
printf '%s\n' "$INSIDE_OUTPUT"
if [[ $INSIDE_CODE -ne 0 || "$INSIDE_OUTPUT" != *"sandbox-inside-marker"* ]]; then
    echo "The launcher could not read its internal marker." >&2
    exit 1
fi

set +e
OUTSIDE_OUTPUT="$("$LAUNCHER" --read "$REPO_ROOT/AGENTS.md" 2>&1)"
OUTSIDE_CODE=$?
set -e
printf '%s\n' "$OUTSIDE_OUTPUT"
if [[ $OUTSIDE_CODE -eq 0 ]]; then
    echo "The sandbox unexpectedly read the repository probe." >&2
    exit 1
fi

set +e
SKILLS_OUTPUT="$("$LAUNCHER" debug skill 2>&1)"
SKILLS_CODE=$?
set -e
printf '%s\n' "$SKILLS_OUTPUT"

echo
echo "PASS: App Sandbox allowed the internal marker and denied the repository probe."
if [[ $SKILLS_CODE -eq 0 ]]; then
    if [[ "$SKILLS_OUTPUT" == *"planning-with-files"* || "$SKILLS_OUTPUT" == *"yibiao-user-manual"* ]]; then
        echo "A known host Skill leaked into the sandbox." >&2
        exit 1
    fi
    echo "PASS: OpenCode skill discovery completed without known host Skills."
elif [[ "$SKILLS_OUTPUT" == *"EPERM"* && "$SKILLS_OUTPUT" == *"lstat"* ]]; then
    echo "EXPECTED BLOCKER: OpenCode ancestor scanning reached a path denied by App Sandbox."
else
    echo "OpenCode skill discovery failed for an unexpected reason." >&2
    exit 1
fi
