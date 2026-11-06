#!/usr/bin/env bash
# Zero-dependency (bash + curl) reachability self-check for the TARGET machine.
# Run BEFORE `docker compose up`: verifies every external dependency named in
# .env.deploy is reachable from this host, so network problems surface before
# containers start failing in confusing ways. Read-only; sends no credentials.
#
# Usage: bash scripts/check-connectivity.sh [--env-file .env.deploy]
set -u

ENV_FILE=".env.deploy"
if [ "${1:-}" = "--env-file" ] && [ -n "${2:-}" ]; then ENV_FILE="$2"; fi
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found (run from the deploy kit directory)" >&2
  exit 1
fi

get() { grep -E "^${1}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }

PASS=0; FAIL=0; SKIP=0

# Any HTTP status (including 401/404) proves the host is reachable; only a
# transport-level failure (code 000) counts as unreachable.
check_http() { # label url
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 6 --max-time 15 "$2" 2>/dev/null || true)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    echo "  ✓ $1  HTTP $code  ($2)"; PASS=$((PASS+1))
  else
    echo "  ✗ $1  连接失败  ($2)"; FAIL=$((FAIL+1))
  fi
}

# curl telnet:// with stdin closed: exit 0 = connected then closed cleanly,
# exit 56 = connected but recv reset — both prove the TCP port is open.
check_tcp() { # label host port
  curl -s --connect-timeout 6 "telnet://$2:$3" </dev/null >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 56 ]; then
    echo "  ✓ $1  TCP 可达  ($2:$3)"; PASS=$((PASS+1))
  else
    echo "  ✗ $1  TCP 不通 (curl exit $rc)  ($2:$3)"; FAIL=$((FAIL+1))
  fi
}

skip() { echo "  - $1  未配置，跳过"; SKIP=$((SKIP+1)); }

echo "===== 外部依赖连通性自检（基于 $ENV_FILE）====="

AI_BASE_URL=$(get AI_BASE_URL)
[ -n "$AI_BASE_URL" ] && check_http "LLM 网关        " "$AI_BASE_URL" || skip "LLM 网关"

ALLMETA_BASE_URL=$(get ALLMETA_BASE_URL)
if [ -n "$ALLMETA_BASE_URL" ]; then
  # Containers reach the host as host.docker.internal; from this shell the
  # same service is localhost.
  host_view=${ALLMETA_BASE_URL//host.docker.internal/localhost}
  check_http "Allmeta 网关    " "$host_view"
else
  skip "Allmeta 网关"
fi

ROBOHIRE=$(get ROBOHIRE_API_BASE_URL)
[ -n "$ROBOHIRE" ] && check_http "RoboHire (公网) " "$ROBOHIRE" || skip "RoboHire"

# Bare container names (no dot, not localhost) only resolve on the Docker
# network, not from this host shell — probing them here would false-fail.
is_container_name() {
  case "$1" in
    localhost|host.docker.internal|127.*|*.*) return 1 ;;
    *) return 0 ;;
  esac
}
# From the host shell, the host bridge name is just localhost.
host_view() { printf '%s' "$1" | sed 's/host\.docker\.internal/localhost/'; }

RAAS_URL=$(get RAAS_POSTGRES_URL)
if [ -n "$RAAS_URL" ]; then
  raas_host=$(printf '%s' "$RAAS_URL" | sed -E 's#^[a-z+]+://([^@]*@)?([^:/?]+).*#\2#')
  raas_port=$(printf '%s' "$RAAS_URL" | sed -nE 's#^[a-z+]+://([^@]*@)?[^:/?]+:([0-9]+).*#\2#p')
  if is_container_name "$raas_host"; then
    echo "  - RAAS Postgres    容器名 '$raas_host'——宿主侧无法探测，起容器后在共享网络内解析；可用:"
    echo "      docker run --rm --network \${RAAS_SHARED_NETWORK:-raas-deploy-next_default} ${POSTGRES_IMAGE:-postgres:17.10-alpine} pg_isready -h $raas_host -p ${raas_port:-5432}"
    SKIP=$((SKIP+1))
  else
    check_tcp "RAAS Postgres   " "$(host_view "$raas_host")" "${raas_port:-5432}"
  fi
else
  skip "RAAS Postgres"
fi

MINIO_HOST=$(get MINIO_ENDPOINT)
MINIO_PORT=$(get MINIO_PORT)
if [ -n "$MINIO_HOST" ]; then
  if is_container_name "$MINIO_HOST"; then
    echo "  - MinIO 简历存储   容器名 '$MINIO_HOST'——宿主侧无法探测，起容器后在共享网络内解析"
    SKIP=$((SKIP+1))
  else
    check_tcp "MinIO 简历存储  " "$(host_view "$MINIO_HOST")" "${MINIO_PORT:-9000}"
  fi
else
  skip "MinIO"
fi

echo ""
echo "===== 参考项（不计入失败）====="
code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 https://github.com 2>/dev/null || true)
[ -n "$code" ] && [ "$code" != "000" ] && echo "  · GitHub 可达（HTTP $code）— 可考虑在线拉代码" || echo "  · GitHub 不可达 — 按离线包流程走"
code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 https://registry-1.docker.io/v2/ 2>/dev/null || true)
[ -n "$code" ] && [ "$code" != "000" ] && echo "  · Docker Hub 可达（HTTP $code）— 基础镜像可在线拉取" || echo "  · Docker Hub 不可达 — 镜像必须随离线包导入"

echo ""
echo "===== 结果：通过 $PASS · 失败 $FAIL · 跳过 $SKIP ====="
if [ "$FAIL" -gt 0 ]; then
  echo "有依赖不可达。对照 docs/deploy/deployment.md「网络前提」一节处理后重试；"
  echo "带着不可达的依赖继续部署，对应 agent 链路会在运行时失败。"
  exit 1
fi
