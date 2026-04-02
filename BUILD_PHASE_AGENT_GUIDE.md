# Build Phase Setup Guide (Agent Handoff)

Configure automatic dSYM upload with selectable source mode:
- `repo`
- `local_dir`
- `zip` (via separate `/v1/sources` endpoint)

## Required build-phase upload target

`POST /v1/dsyms` with:
- `appId`
- `buildVersion`
- `dsym`
- optional `sourceType`
- optional `repoUrl` + `commitSha`
- optional `localSourceDir`

## Source modes

1. `repo`
- include `repoUrl` and `commitSha`

2. `local_dir`
- include `localSourceDir` (absolute path on server machine)

3. `zip`
- upload separately to `/v1/sources` for same app/build

## Xcode xcconfig vars

- `CRASH_REPORTER_SERVER_URL`
- `CRASH_REPORTER_APP_ID`
- `CRASH_REPORTER_SOURCE_TYPE` = `repo | local_dir`
- `CRASH_REPORTER_GITHUB_REPO_URL`
- `CRASH_REPORTER_GIT_COMMIT_SHA`
- `CRASH_REPORTER_LOCAL_SOURCE_DIR`
- `CRASH_REPORTER_API_TOKEN`
- `CRASH_REPORTER_FAIL_BUILD_ON_UPLOAD_ERROR` (`0` default, set `1` to fail build if upload fails)

## Build phase script

```bash
set -euo pipefail

if [[ -z "${CRASH_REPORTER_SERVER_URL:-}" ]]; then
  echo "[CrashReporter] CRASH_REPORTER_SERVER_URL not set; skipping dSYM upload"
  exit 0
fi

if [[ -z "${DWARF_DSYM_FOLDER_PATH:-}" || -z "${DWARF_DSYM_FILE_NAME:-}" ]]; then
  echo "[CrashReporter] dSYM env vars missing; skipping"
  exit 0
fi

DSYM_PATH="${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}"
if [[ ! -d "$DSYM_PATH" ]]; then
  echo "[CrashReporter] dSYM path not found: $DSYM_PATH"
  exit 0
fi

ZIP_PATH="${TEMP_DIR}/${DWARF_DSYM_FILE_NAME}.zip"
rm -f "$ZIP_PATH"
(
  cd "$DWARF_DSYM_FOLDER_PATH"
  /usr/bin/zip -r -q "$ZIP_PATH" "$DWARF_DSYM_FILE_NAME"
)

BUILD_VERSION="${CURRENT_PROJECT_VERSION:-${MARKETING_VERSION:-0}}"
APP_ID="${CRASH_REPORTER_APP_ID:-${PRODUCT_BUNDLE_IDENTIFIER}}"
SOURCE_TYPE="${CRASH_REPORTER_SOURCE_TYPE:-repo}"
FAIL_BUILD_ON_UPLOAD_ERROR="${CRASH_REPORTER_FAIL_BUILD_ON_UPLOAD_ERROR:-0}"

REPO_URL="${CRASH_REPORTER_GITHUB_REPO_URL:-}"
if [[ -z "$REPO_URL" ]]; then
  REPO_URL="$(git -C "$PROJECT_DIR/../.." remote get-url origin 2>/dev/null | sed 's#git@github.com:#https://github.com/#;s#\.git$##' || true)"
fi

COMMIT_SHA="${CRASH_REPORTER_GIT_COMMIT_SHA:-}"
if [[ -z "$COMMIT_SHA" ]]; then
  COMMIT_SHA="$(git -C "$PROJECT_DIR/../.." rev-parse HEAD 2>/dev/null || true)"
fi

CURL_ARGS=(
  --fail-with-body
  -X POST
  "$CRASH_REPORTER_SERVER_URL/v1/dsyms"
  -F "appId=$APP_ID"
  -F "buildVersion=$BUILD_VERSION"
  -F "sourceType=$SOURCE_TYPE"
  -F "dsym=@$ZIP_PATH"
)

if [[ "$SOURCE_TYPE" == "repo" && -n "$REPO_URL" ]]; then
  CURL_ARGS+=( -F "repoUrl=$REPO_URL" )
fi

if [[ "$SOURCE_TYPE" == "repo" && -n "$COMMIT_SHA" ]]; then
  CURL_ARGS+=( -F "commitSha=$COMMIT_SHA" )
fi

if [[ "$SOURCE_TYPE" == "local_dir" ]]; then
  LOCAL_SOURCE_DIR="${CRASH_REPORTER_LOCAL_SOURCE_DIR:-$PROJECT_DIR/../..}"
  CURL_ARGS+=( -F "localSourceDir=$LOCAL_SOURCE_DIR" )
fi

if [[ -n "${CRASH_REPORTER_API_TOKEN:-}" ]]; then
  CURL_ARGS+=( -H "Authorization: Bearer ${CRASH_REPORTER_API_TOKEN}" )
fi

set +e
CURL_OUTPUT="$(
  /usr/bin/curl \
    --retry 2 \
    --retry-delay 1 \
    --retry-connrefused \
    --connect-timeout 5 \
    --max-time 60 \
    "${CURL_ARGS[@]}" \
    2>&1
)"
CURL_EXIT=$?
set -e

if [[ $CURL_EXIT -ne 0 ]]; then
  echo "[CrashReporter] dSYM upload failed: $CURL_OUTPUT"
  if [[ "$FAIL_BUILD_ON_UPLOAD_ERROR" == "1" ]]; then
    exit 1
  fi
  echo "[CrashReporter] Continuing build (set CRASH_REPORTER_FAIL_BUILD_ON_UPLOAD_ERROR=1 to fail on upload errors)"
  exit 0
fi

echo "[CrashReporter] dSYM upload complete: $CURL_OUTPUT"
```

## Server source-resolution order

At crash processing time, source context is chosen by:
1. payload metadata override
2. latest `source_mappings` for app/build
3. dSYM-linked fallback fields
