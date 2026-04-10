#!/bin/bash
set -euo pipefail

# Build and push the OpenClaw base image to ECR.
#
# Usage:
#   ./docker/build-and-push.sh              # uses default tag
#   ./docker/build-and-push.sh v0.0.2       # custom version suffix
#
# Prerequisites:
#   - Docker CLI (or Rancher Desktop)
#   - AWS ECR login: aws ecr get-login-password --region us-west-2 | \
#       docker login --username AWS --password-stdin 307185671274.dkr.ecr.us-west-2.amazonaws.com

ECR_REPO="307185671274.dkr.ecr.us-west-2.amazonaws.com/openclaw-environment"
OPENCLAW_VERSION="2026.3.2"
VERSION_SUFFIX="${1:-v0.0.1}"
TAG="openclaw-${OPENCLAW_VERSION}-${VERSION_SUFFIX}"
FULL_TAG="${ECR_REPO}:${TAG}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Building OpenClaw base image..."
echo "  Tag: ${FULL_TAG}"
echo "  Context: ${REPO_ROOT}"

docker buildx build \
  --platform linux/amd64 \
  -f "${SCRIPT_DIR}/Dockerfile" \
  -t "${FULL_TAG}" \
  --push \
  "${REPO_ROOT}"

echo ""
echo "Pushed: ${FULL_TAG}"
echo ""
echo "To use in Scale's Dockerfile:"
echo "  FROM ${FULL_TAG}"
