#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Match shutdown.sh when the local Docker socket requires administrative access.
if ! docker info >/dev/null 2>&1 && (( EUID != 0 )) && command -v sudo >/dev/null; then
  endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}"
  case "$endpoint" in
    unix:///var/run/docker.sock|unix:///run/docker.sock)
      if sudo docker info >/dev/null 2>&1; then
        exec sudo docker compose restart playwright-studio
      fi
      ;;
  esac
fi

exec docker compose restart playwright-studio
