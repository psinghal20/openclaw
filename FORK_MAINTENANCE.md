# OpenClaw Fork Maintenance Guide

This fork adds `tool.execute` and `tool.list` RPC methods to the OpenClaw
gateway, enabling direct tool execution without the LLM agent loop.  Used
by Scale's trajectory replay and validation system.

## Repository Layout

```
psinghal20/openclaw (branch: feat/tool-execute-rpc)
├── patches/                          # Patch files against upstream
│   ├── 0001-Add-tool.execute-...     # Source change (gateway handler + scopes)
│   └── 0002-Add-Docker-build-...     # Docker build infrastructure
├── docker/
│   ├── Dockerfile                    # Multi-stage: build OpenClaw + runtime image
│   └── build-and-push.sh            # Build and push to ECR
├── FORK_MAINTENANCE.md               # This file
└── src/gateway/server-methods/
    └── tool-execute.ts               # The actual feature code
```

## What We Changed (3 files, ~240 lines)

| File | Change | Lines |
|------|--------|-------|
| `src/gateway/server-methods/tool-execute.ts` | **New file** — `tool.execute` + `tool.list` RPC handlers | ~230 |
| `src/gateway/server-methods.ts` | Import + register `toolExecuteHandlers` in `coreGatewayHandlers` | +2 |
| `src/gateway/method-scopes.ts` | Register `tool.execute` + `tool.list` under `ADMIN_SCOPE` | +2 |

Patch `0001` contains all source changes.  Patch `0002` is docker build
infrastructure that we own entirely.

## Docker Build Notes

- All channel extensions are included (telegram, whatsapp, discord, slack, etc.)
- The `tlon` extension is excluded — its git-hosted dep `@tloncorp/api` has
  TypeScript compilation errors at the pinned commit (readonly array ↔ mutable
  array type mismatch). This is a bug in the upstream `tloncorp/api-beta` repo.
- Build deps `make`, `g++`, `python3` are included for native addons.

---

## Upgrading OpenClaw Version

### Step 1: Check if patch applies against the new version

```bash
cd ~/openclaw-fork

# Fetch upstream tags
git remote add upstream https://github.com/openclaw/openclaw.git 2>/dev/null || true
git fetch upstream --tags

# Test patch against new version (dry run)
git checkout v2026.X.Y
git apply --check patches/0001-Add-tool.execute-and-tool.list-RPC-methods-to-gatewa.patch
```

**If it applies cleanly** — proceed to Step 2.

**If it fails** — see [Resolving Patch Conflicts](#resolving-patch-conflicts) below.

### Step 2: Create a new branch and apply patches

```bash
# Create new branch from the target version
git checkout v2026.X.Y -b feat/tool-execute-rpc-v2026.X.Y

# Apply the source patch
git apply patches/0001-Add-tool.execute-and-tool.list-RPC-methods-to-gatewa.patch
git add -A && git commit -m "Add tool.execute and tool.list RPC methods to gateway"

# Copy the docker/ directory from the old branch (we own these files):
git checkout feat/tool-execute-rpc -- docker/
git add docker/ && git commit -m "Add Docker build infrastructure"
```

### Step 3: Verify the build

```bash
# Build the Docker image (tests everything end-to-end)
./docker/build-and-push.sh v0.0.X
```

### Step 4: Regenerate patches for the new version

```bash
# Regenerate patches from the new branch (exclude meta commits)
rm patches/*.patch
git format-patch v2026.X.Y..HEAD -o patches/
# Only keep 0001 (source) and 0002 (docker) — discard any meta patches
git add patches/ && git commit -m "Regenerate patches for v2026.X.Y"
```

### Step 5: Push and update Scale

```bash
# Push the new branch
git push origin feat/tool-execute-rpc-v2026.X.Y

# Build and push new base image
aws ecr get-login-password --region us-west-2 | \
  docker login --username AWS --password-stdin 307185671274.dkr.ecr.us-west-2.amazonaws.com
./docker/build-and-push.sh v0.0.X

# Update Scale monorepo Dockerfile:
#   ARG OPENCLAW_BASE_TAG=openclaw-2026.X.Y-v0.0.X
```

---

## Resolving Patch Conflicts

Patch `0001` modifies two existing files.  Here's how to fix each when
the patch fails to apply:

### `src/gateway/server-methods.ts` (2 lines)

This file aggregates all gateway RPC handlers.  Upstream adds new handlers
here regularly, which shifts context lines.

**Fix:** Add these 2 lines manually:

1. **Import** (add near the other handler imports, ~line 27-34):
   ```typescript
   import { toolExecuteHandlers } from "./server-methods/tool-execute.js";
   ```

2. **Registration** (add inside `coreGatewayHandlers` object, ~line 66-95):
   ```typescript
     ...toolExecuteHandlers,
   ```

### `src/gateway/method-scopes.ts` (2 lines)

This file maps RPC methods to authorization scopes.

**Fix:** Add these 2 lines to the `ADMIN_SCOPE` array:

```typescript
    "tool.execute",
    "tool.list",
```

### `src/gateway/server-methods/tool-execute.ts` (new file)

This file never conflicts — it's always a new file.  However, **check
that the imports still resolve**:

- `@mariozechner/pi-coding-agent` — `createReadTool`, `codingTools`, `readTool`
- `../../agents/bash-tools.js` — `createExecTool`, `createProcessTool`
- `../../agents/apply-patch.js` — `createApplyPatchTool`
- `../../agents/openclaw-tools.js` — `createOpenClawTools`
- `../../agents/agent-scope.js` — `resolveAgentWorkspaceDir`, `resolveDefaultAgentId`
- `../../config/config.js` — `loadConfig`
- `../../config/sessions.js` — `resolveMainSessionKey`
- `../protocol/index.js` — `ErrorCodes`, `errorShape`

If any import path changed upstream, update the import in `tool-execute.ts`
accordingly.

### Docker build: tlon extension

If a new OpenClaw version fixes `@tloncorp/api` TypeScript errors, you can
remove the `RUN rm -rf extensions/tlon` line from `docker/Dockerfile` to
re-enable the tlon extension.  Test by running the build — if it passes,
tlon is fixed upstream.

---

## Building the Base Image

### Prerequisites

- Docker CLI (Rancher Desktop or Docker Desktop)
- AWS ECR access:
  ```bash
  aws ecr get-login-password --region us-west-2 | \
    docker login --username AWS --password-stdin 307185671274.dkr.ecr.us-west-2.amazonaws.com
  ```

### Build and Push

```bash
cd ~/openclaw-fork

# Default tag: openclaw-2026.3.2-v0.0.1
./docker/build-and-push.sh

# Custom version suffix
./docker/build-and-push.sh v0.0.2
```

The script:
1. Builds a multi-stage Docker image (builder stage compiles OpenClaw, runtime stage installs it)
2. Pushes to `307185671274.dkr.ecr.us-west-2.amazonaws.com/openclaw-environment:<tag>`
3. Prints the full tag for use in Scale's Dockerfile

### Image Tag Convention

```
openclaw-{upstream_version}-{scale_patch_version}
```

Examples:
- `openclaw-2026.3.2-v0.0.1` — first build, no channel extensions
- `openclaw-2026.3.2-v0.0.2` — added channel extensions (telegram, whatsapp, etc.)
- `openclaw-2026.4.8-v0.0.1` — first build from new upstream version

### Current Images

| Tag | Upstream | Channels | Notes |
|-----|----------|----------|-------|
| `openclaw-2026.3.2-v0.0.1` | v2026.3.2 | No | Initial build, no extensions |
| `openclaw-2026.3.2-v0.0.2` | v2026.3.2 | Yes (except tlon) | All channels enabled |

---

## Using in Scale's Dockerfile

The Scale monorepo Dockerfile at `server/docker/openclaw/Dockerfile` references
the base image:

```dockerfile
ARG OPENCLAW_BASE_TAG=openclaw-2026.3.2-v0.0.2
FROM 307185671274.dkr.ecr.us-west-2.amazonaws.com/openclaw-environment:${OPENCLAW_BASE_TAG}
```

To update: change `OPENCLAW_BASE_TAG` to the new tag and rebuild the Scale image.

---

## Testing After Upgrade

After building a new base image, verify the fork's additions work:

```bash
# 1. Create a test sandbox
cd ~/scaleapi/server
bash docker/openclaw/scripts/create-sandbox.sh \
  -a "test-upgrade-$(date +%s)" \
  -i "307185671274.dkr.ecr.us-west-2.amazonaws.com/openclaw-environment:<new-tag>" \
  --no-mcp

# 2. Verify tool.list returns all tools (should be 25+)
SANDBOX_ID="<from output above>"
curl -s -X POST "http://localhost:8787/sandbox-exec" \
  -H "Content-Type: application/json" \
  -d "{\"sandbox_id\": \"${SANDBOX_ID}\", \"command\": [\"openclaw\", \"gateway\", \"call\", \"tool.list\", \"--json\"]}" \
  | jq -r '.stdout' | jq '.tools | length'

# 3. Verify tool.execute works
curl -s -X POST "http://localhost:8787/sandbox-exec" \
  -H "Content-Type: application/json" \
  -d "{\"sandbox_id\": \"${SANDBOX_ID}\", \"command\": [\"openclaw\", \"gateway\", \"call\", \"tool.execute\", \"--params\", \"{\\\"name\\\":\\\"exec\\\",\\\"arguments\\\":{\\\"command\\\":\\\"echo ok\\\"}}\", \"--json\"]}" \
  | jq -r '.stdout' | jq '.'
```

Expected: `tool.list` returns 25+ tools, `tool.execute` returns `{ isError: false }`.

---

## Contributing Upstream

If the upstream OpenClaw project accepts a `tool.execute` feature, this
fork becomes unnecessary.

**PR candidate:** `patches/0001-Add-tool.execute-and-tool.list-RPC-methods-to-gatewa.patch`

This adds a general-purpose tool execution API that benefits any OpenClaw
deployment needing programmatic tool access (CI/CD pipelines, testing
frameworks, trajectory replay systems).

If the PR is accepted upstream, remove the fork dependency:
1. Update Scale's Dockerfile to use vanilla `openclaw@<version>` (revert to `FROM node:22-slim` + `npm install -g openclaw`)
2. Archive this fork repo
