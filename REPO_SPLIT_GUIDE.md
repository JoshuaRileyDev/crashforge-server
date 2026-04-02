# CrashForge Repo Split Guide

This workspace currently contains:

- Server code (Node/Express/Postgres)
- Swift SDK package
- iOS sample app

Target outcome:

1. `crashforge-server` repo
2. `crashforge-ios-sdk` repo

## Recommended split

### Repo 1: `crashforge-server`

Keep:

- `src/`
- `public/`
- `data/`
- `Dockerfile`
- `docker-compose.yml`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `.env.example`
- `.dockerignore`
- `BUILD_PHASE_AGENT_GUIDE.md`
- `README.md` (server README)

Move out:

- `swift-sdk/`
- `ios-sample/` (optional: can stay in server repo if preferred)

### Repo 2: `crashforge-ios-sdk`

Keep:

- `Package.swift`
- `Sources/CrashReporterSDK/`
- `Tests/CrashReporterSDKTests/`
- `README.md` (SDK README)

Optional:

- Add an `Examples/` folder with a minimal sample app later.

## Fastest approach (copy-based)

From current workspace root:

```bash
mkdir -p ../crashforge-server ../crashforge-ios-sdk
```

Copy server:

```bash
rsync -av \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'swift-sdk' \
  --exclude 'ios-sample' \
  ./ ../crashforge-server/
```

Copy SDK:

```bash
rsync -av \
  --exclude '.git' \
  ./swift-sdk/ ../crashforge-ios-sdk/
```

## Initialize and push server repo

```bash
cd ../crashforge-server
git init
git add .
git commit -m "Initial CrashForge Server"
git branch -M main
git remote add origin <SERVER_REPO_URL>
git push -u origin main
```

## Initialize and push SDK repo

```bash
cd ../crashforge-ios-sdk
git init
git add .
git commit -m "Initial CrashForge iOS SDK"
git branch -M main
git remote add origin <SDK_REPO_URL>
git push -u origin main
```

## Post-split checklist

1. Update server README links to the SDK repo URL.
2. Update SDK README links to the server repo URL.
3. Add semantic version tags on SDK repo for SPM usage.
4. Verify CI separately for each repo.
5. If keeping `ios-sample`, point package dependency to `crashforge-ios-sdk` remote URL.
