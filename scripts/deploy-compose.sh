#!/usr/bin/env bash
# Run the production Compose stack with .env.deploy as the single source of
# truth. Docker Compose normally gives an exported shell variable precedence
# over --env-file; that can make a preflight validate one project/volume while
# the real command operates on another. This wrapper removes that ambiguity.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=".env.deploy"
EXPECTED_MODE=""
EXPECTED_VOLUME_MODE=""

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy-compose.sh [options] [--] <compose args...>

Options:
  --env-file PATH
  --expect-mode shared|bundled
  --expect-volume-mode new|external

Examples:
  bash scripts/deploy-compose.sh --env-file .env.deploy -- config --quiet
  bash scripts/deploy-compose.sh --env-file .env.deploy -- up -d --wait ao-postgres

DEPLOY_MODE and AO_POSTGRES_VOLUME_MODE are read from the env file. The wrapper
selects the shared-Inngest and existing-volume overlays automatically.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --env-file requires a path." >&2
        exit 2
      fi
      ENV_FILE=$2
      shift 2
      ;;
    --expect-mode)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --expect-mode requires shared or bundled." >&2
        exit 2
      fi
      EXPECTED_MODE=$2
      shift 2
      ;;
    --expect-volume-mode)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --expect-volume-mode requires new or external." >&2
        exit 2
      fi
      EXPECTED_VOLUME_MODE=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -eq 0 ]; then
  usage >&2
  exit 2
fi

case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="$PWD/$ENV_FILE" ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: deployment env file does not exist: $ENV_FILE" >&2
  exit 1
fi

trim_value() {
  local value=$1
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value=${value:1:${#value}-2}
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}

read_env_value() {
  local env_key=$1
  local raw
  raw=$(sed -En "s/^[[:space:]]*(export[[:space:]]+)?${env_key}[[:space:]]*=[[:space:]]*(.*)$/\\2/p" "$ENV_FILE" | tail -n 1)
  trim_value "$raw"
}

DEPLOY_MODE_VALUE=$(read_env_value DEPLOY_MODE)
VOLUME_MODE_VALUE=$(read_env_value AO_POSTGRES_VOLUME_MODE)
SCHEMA_SYNC_VALUE=$(read_env_value DATABASE_SCHEMA_SYNC)

case "$EXPECTED_MODE" in
  ""|shared|bundled) ;;
  *)
    echo "ERROR: --expect-mode must be exactly shared or bundled." >&2
    exit 2
    ;;
esac

case "$EXPECTED_VOLUME_MODE" in
  ""|new|external) ;;
  *)
    echo "ERROR: --expect-volume-mode must be exactly new or external." >&2
    exit 2
    ;;
esac

COMPOSE_FILES=(
  -f "$REPO_ROOT/docker-compose.deploy.yml"
)

case "$DEPLOY_MODE_VALUE" in
  shared)
    COMPOSE_FILES+=(
      -f "$REPO_ROOT/docker-compose.shared-inngest.yml"
    )
    ;;
  bundled) ;;
  *)
    echo "ERROR: DEPLOY_MODE in $ENV_FILE must be exactly shared or bundled." >&2
    exit 1
    ;;
esac

case "$VOLUME_MODE_VALUE" in
  new) ;;
  external)
    COMPOSE_FILES+=(
      -f "$REPO_ROOT/docker-compose.reuse-postgres-volume.yml"
    )
    ;;
  *)
    echo "ERROR: AO_POSTGRES_VOLUME_MODE in $ENV_FILE must be exactly new or external." >&2
    exit 1
    ;;
esac

if [ -n "$EXPECTED_MODE" ] && [ "$DEPLOY_MODE_VALUE" != "$EXPECTED_MODE" ]; then
  echo "ERROR: this command expects DEPLOY_MODE=$EXPECTED_MODE, but $ENV_FILE contains $DEPLOY_MODE_VALUE." >&2
  exit 1
fi

if [ -n "$EXPECTED_VOLUME_MODE" ] && [ "$VOLUME_MODE_VALUE" != "$EXPECTED_VOLUME_MODE" ]; then
  echo "ERROR: this command expects AO_POSTGRES_VOLUME_MODE=$EXPECTED_VOLUME_MODE, but $ENV_FILE contains $VOLUME_MODE_VALUE." >&2
  exit 1
fi

# These two paths can reach production or its only physical PGDATA. Even if an
# operator skips the full preflight, never let the web entrypoint auto-run
# `prisma db push` against them.
if { [ "$DEPLOY_MODE_VALUE" = "shared" ] || [ "$VOLUME_MODE_VALUE" = "external" ]; } \
  && [ "$SCHEMA_SYNC_VALUE" != "0" ]; then
  echo "ERROR: shared/external deployment requires DATABASE_SCHEMA_SYNC=0." >&2
  exit 1
fi

# Unset every key present in the authoritative env file before invoking
# Compose. Also clear Compose control variables and optional topology keys that
# may be commented out in the file. PATH/HOME/DOCKER_HOST remain untouched.
UNSET_ARGS=(
  -u AO_ENV_FILE
  -u AO_EXISTING_POSTGRES_VOLUME
  -u COMPOSE_ENV_FILES
  -u COMPOSE_FILE
  -u COMPOSE_PATH_SEPARATOR
  -u COMPOSE_PROFILES
  -u COMPOSE_PROJECT_NAME
  -u DATABASE_SCHEMA_SYNC
  -u DEPLOY_MODE
  -u AO_POSTGRES_VOLUME_MODE
  -u RAAS_SHARED_NETWORK
  -u AO_SHARED_NETWORK_ALIAS
  -u INNGEST_BASE_URL
  -u INNGEST_SERVE_ORIGIN
)

while IFS= read -r env_key; do
  [ -n "$env_key" ] && UNSET_ARGS+=( -u "$env_key" )
done < <(sed -En 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*$/\2/p' "$ENV_FILE")

exec env "${UNSET_ARGS[@]}" \
  AO_ENV_FILE="$ENV_FILE" \
  docker compose \
  --env-file "$ENV_FILE" \
  --project-directory "$REPO_ROOT" \
  "${COMPOSE_FILES[@]}" \
  "$@"
