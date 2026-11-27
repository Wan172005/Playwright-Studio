#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

log() { printf '[startup] %s\n' "$*"; }
fail() { printf '[startup] %s\n' "$*" >&2; exit 1; }
as_root() {
  if (( EUID == 0 )); then "$@";
  else
    command -v sudo >/dev/null || fail 'Cần sudo để cài Docker hoặc khởi động dịch vụ.'
    sudo "$@"
  fi
}

is_wsl=false
if [[ -n "${WSL_DISTRO_NAME:-}" || -n "${WSL_INTEROP:-}" ]] || [[ "$(uname -r)" == *[Mm]icrosoft* ]]; then
  is_wsl=true
  log 'Đã nhận diện môi trường WSL.'
fi

desktop=false
if $is_wsl && { [[ -d /mnt/wsl/docker-desktop ]] || [[ -f '/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe' ]] || command -v docker.exe >/dev/null; }; then desktop=true; fi
if command -v docker >/dev/null; then
  docker_binary="$(readlink -f "$(command -v docker)" 2>/dev/null || command -v docker)"
  if [[ "$docker_binary" == *docker-desktop* ]] || [[ "$(docker context show 2>/dev/null || true)" == desktop-linux ]]; then desktop=true; fi
fi

# Official Docker Apt repository; never remove or replace conflicting packages.
# https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository
# https://docs.docker.com/engine/install/debian/#install-using-the-apt-repository
install_packages() {
  [[ "$(uname -s)" == Linux && -r /etc/os-release ]] || fail 'Tự cài Docker chỉ hỗ trợ Ubuntu/Debian. Hãy cài Docker Desktop, Compose và Buildx cho hệ điều hành này.'
  local distro codename architecture key_file
  distro="$(. /etc/os-release; printf '%s' "$ID")"
  codename="$(. /etc/os-release; printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
  [[ "$distro" == ubuntu || "$distro" == debian ]] || fail 'Tự cài chỉ hỗ trợ Ubuntu/Debian. Hãy cài Docker, Compose và Buildx cho distro đang dùng.'
  [[ -n "$codename" ]] || fail 'Không xác định được phiên bản Ubuntu/Debian.'
  log "Cài các thành phần còn thiếu: $* (có thể yêu cầu mật khẩu sudo)."
  as_root apt-get update
  as_root apt-get install -y --no-remove --no-install-recommends ca-certificates curl
  if ! grep -Rqs 'https://download.docker.com/linux/' /etc/apt/sources.list /etc/apt/sources.list.d/; then
    architecture="$(dpkg --print-architecture)"
    key_file="$(mktemp)"
    if ! curl -fsSL "https://download.docker.com/linux/$distro/gpg" -o "$key_file"; then
      rm -f "$key_file"; fail 'Không tải được khóa Docker. Kiểm tra kết nối Internet rồi chạy lại.'
    fi
    as_root install -m 0755 -d /etc/apt/keyrings
    as_root install -m 0644 "$key_file" /etc/apt/keyrings/docker.asc
    rm -f "$key_file"
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$distro" "$codename" "$architecture" |
      as_root tee /etc/apt/sources.list.d/docker.sources >/dev/null
    as_root apt-get update
  fi
  as_root apt-get install -y --no-remove --no-install-recommends "$@"
  hash -r
}

docker_cmd=(docker)
missing=()
if ! command -v docker >/dev/null || ! docker --version >/dev/null 2>&1; then
  if $desktop; then fail 'Hãy mở Docker Desktop → Settings → Resources → WSL Integration, bật distro hiện tại rồi chạy lại.'; fi
  missing+=(docker-ce docker-ce-cli containerd.io)
fi
if ! docker buildx version >/dev/null 2>&1; then missing+=(docker-buildx-plugin); fi
if ! docker compose version >/dev/null 2>&1; then missing+=(docker-compose-plugin); fi
if (( ${#missing[@]} )); then install_packages "${missing[@]}"; fi

if ! docker info >/dev/null 2>&1; then
  if $desktop; then fail 'Hãy mở Docker Desktop và bật WSL Integration cho distro hiện tại, sau đó chạy lại start.sh.'; fi
  endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}"
  case "$endpoint" in
    unix:///var/run/docker.sock|unix:///run/docker.sock) ;;
    *) fail 'Không kết nối được Docker context hiện tại. Hãy khởi động daemon tương ứng hoặc chọn lại Docker context.' ;;
  esac
  if (( EUID != 0 )); then
    command -v sudo >/dev/null || fail 'Docker cần quyền quản trị. Hãy cài sudo hoặc chạy script bằng root.'
  fi
  if ! command -v dockerd >/dev/null; then install_packages docker-ce docker-ce-cli containerd.io; fi
  # On a fresh install the current shell may not have access to the Docker socket.
  if ! as_root docker info >/dev/null 2>&1; then
    log 'Khởi động dịch vụ Docker...'
    if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
      as_root systemctl start docker
    else
      as_root service docker start
    fi
  fi
  ready=false
  for ((attempt=0; attempt<30; attempt++)); do
    if docker info >/dev/null 2>&1; then ready=true; break; fi
    if as_root docker info >/dev/null 2>&1; then
      if (( EUID != 0 )); then docker_cmd=(sudo docker); fi
      ready=true; break
    fi
    sleep 1
  done
  $ready || fail 'Docker chưa sẵn sàng. Kiểm tra dịch vụ Docker rồi chạy lại start.sh.'
fi

# User-level plugins might not be visible when Docker needs sudo.
missing=()
if ! "${docker_cmd[@]}" buildx version >/dev/null 2>&1; then missing+=(docker-buildx-plugin); fi
if ! "${docker_cmd[@]}" compose version >/dev/null 2>&1; then missing+=(docker-compose-plugin); fi
if (( ${#missing[@]} )); then install_packages "${missing[@]}"; fi
"${docker_cmd[@]}" buildx version >/dev/null || fail 'Không chạy được plugin Buildx sau khi cài.'
"${docker_cmd[@]}" compose version >/dev/null || fail 'Không chạy được plugin Compose sau khi cài.'

log 'Khởi động Playwright Studio...'
exec "${docker_cmd[@]}" compose up -d
