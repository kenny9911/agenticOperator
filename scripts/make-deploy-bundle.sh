#!/usr/bin/env bash
# Build the AO image and pack everything an OFFLINE target machine needs into
# one tarball: app + postgres images (plus Inngest only for explicit bundled
# mode), compose files, a pre-filled .env.deploy draft, and the preflight /
# connectivity / survey scripts.
#
# Run on a machine WITH internet + Docker (the build machine):
#
#   scripts/make-deploy-bundle.sh \
#     --public-origin  http://<target-lan-ip>:3002 \
#     --inngest-origin http://<target-lan-ip>:8288 \
#     --mode shared \
#     --shared-network <existing-docker-network> \
#     --shared-inngest-url http://<shared-inngest-container>:8288 \
#     --callback-alias ao-v2-app \
#     [--arch arm64|amd64]   # default arm64 (Apple Silicon target)
#     [--tag  <image-tag>]   # default vYYYYMMDD
#
# Isolated machine only: `--mode bundled` explicitly includes the Inngest
# image and configures the opt-in bundled-inngest profile.
#
# The two origins are REQUIRED: NEXT_PUBLIC_* values are baked into the
# browser bundle at build time, so they must be the target machine's address
# as seen from an operator's browser — not localhost, not a Docker name.
set -euo pipefail

cd "$(dirname "$0")/.."

ARCH="arm64"
TAG="v$(date +%Y%m%d)"
PUBLIC_ORIGIN=""
INNGEST_ORIGIN=""
MODE="shared"
SHARED_NETWORK=""
SHARED_INNGEST_URL=""
CALLBACK_ALIAS=""
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:17.10-alpine}"
INNGEST_IMAGE="${INNGEST_IMAGE:-inngest/inngest:v1.19.2}"

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --public-origin) PUBLIC_ORIGIN="$2"; shift 2 ;;
    --inngest-origin) INNGEST_ORIGIN="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --shared-network) SHARED_NETWORK="$2"; shift 2 ;;
    --shared-inngest-url) SHARED_INNGEST_URL="$2"; shift 2 ;;
    --callback-alias) CALLBACK_ALIAS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^set -euo pipefail$/p' "$0" | sed -n 's/^# \{0,1\}//p'
      exit 0
      ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

if [ -z "$PUBLIC_ORIGIN" ] || [ -z "$INNGEST_ORIGIN" ]; then
  echo "ERROR: --public-origin and --inngest-origin are required." >&2
  echo "  e.g. --public-origin http://10.100.0.42:3002 --inngest-origin http://10.100.0.42:8288" >&2
  exit 1
fi

if [ "$MODE" != "shared" ] && [ "$MODE" != "bundled" ]; then
  echo "ERROR: --mode must be shared or bundled." >&2
  exit 1
fi

if [ "$MODE" = "shared" ] && { [ -z "$SHARED_NETWORK" ] || [ -z "$SHARED_INNGEST_URL" ] || [ -z "$CALLBACK_ALIAS" ]; }; then
  echo "ERROR: shared mode requires --shared-network, --shared-inngest-url and --callback-alias." >&2
  exit 1
fi

AO_IMAGE="agentic-operator:${TAG}-${ARCH}"
PLATFORM="linux/${ARCH}"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/ao-deploy-bundle.XXXXXX")
trap 'rm -rf -- "$STAGE"' EXIT
BUNDLE="ao-deploy-bundle-${TAG}-${ARCH}.tar"

echo "==> [1/5] building ${AO_IMAGE} for ${PLATFORM}"
docker build --platform "$PLATFORM" \
  --build-arg NEXT_PUBLIC_BASE_URL="$PUBLIC_ORIGIN" \
  --build-arg NEXT_PUBLIC_INNGEST_URL="$INNGEST_ORIGIN" \
  --build-arg NEXT_PUBLIC_FACTORY_ENABLED=0 \
  -t "$AO_IMAGE" -f Dockerfile .

echo "==> [2/5] pulling required runtime images for ${PLATFORM} (mode=${MODE})"
docker pull --platform "$PLATFORM" "$POSTGRES_IMAGE"
IMAGES=("$AO_IMAGE" "$POSTGRES_IMAGE")
if [ "$MODE" = "bundled" ]; then
  docker pull --platform "$PLATFORM" "$INNGEST_IMAGE"
  IMAGES+=("$INNGEST_IMAGE")
fi

echo "==> [3/5] saving images (multi-GB step, takes a few minutes)"
mkdir -p "$STAGE/scripts"
docker save "${IMAGES[@]}" | gzip > "$STAGE/images.tar.gz"

echo "==> [4/5] staging deploy kit"
cp docker-compose.deploy.yml docker-compose.shared-inngest.yml \
  docker-compose.reuse-postgres-volume.yml "$STAGE/"
cp docs/deploy/deployment.md "$STAGE/deployment-full-guide.md"
cp scripts/deploy-compose.sh scripts/deploy-preflight.mjs \
  scripts/check-connectivity.sh scripts/survey-old-deployment.sh "$STAGE/scripts/"
chmod +x "$STAGE"/scripts/*.sh

# Pre-fill the env draft so the target machine only edits secrets/endpoints.
if [ "$MODE" = "shared" ]; then
  PROFILE=""
  BASE_URL="$SHARED_INNGEST_URL"
  SERVE_ORIGIN="http://${CALLBACK_ALIAS}:3002"
else
  PROFILE="bundled-inngest"
  BASE_URL="http://inngest:8288"
  SERVE_ORIGIN="http://app:3002"
  SHARED_NETWORK=""
  CALLBACK_ALIAS=""
fi

sed -E \
  -e "s#^AO_IMAGE=.*#AO_IMAGE=${AO_IMAGE}#" \
  -e "s#^POSTGRES_IMAGE=.*#POSTGRES_IMAGE=${POSTGRES_IMAGE}#" \
  -e "s#^INNGEST_IMAGE=.*#INNGEST_IMAGE=${INNGEST_IMAGE}#" \
  -e "s#^AO_PUBLIC_ORIGIN=.*#AO_PUBLIC_ORIGIN=${PUBLIC_ORIGIN}#" \
  -e "s#^INNGEST_PUBLIC_ORIGIN=.*#INNGEST_PUBLIC_ORIGIN=${INNGEST_ORIGIN}#" \
  -e "s#^DEPLOY_MODE=.*#DEPLOY_MODE=${MODE}#" \
  -e "s#^COMPOSE_PROFILES=.*#COMPOSE_PROFILES=${PROFILE}#" \
  -e "s#^RAAS_SHARED_NETWORK=.*#RAAS_SHARED_NETWORK=${SHARED_NETWORK}#" \
  -e "s#^AO_SHARED_NETWORK_ALIAS=.*#AO_SHARED_NETWORK_ALIAS=${CALLBACK_ALIAS}#" \
  -e "s#^INNGEST_BASE_URL=.*#INNGEST_BASE_URL=${BASE_URL}#" \
  -e "s#^INNGEST_SERVE_ORIGIN=.*#INNGEST_SERVE_ORIGIN=${SERVE_ORIGIN}#" \
  .env.deploy.example > "$STAGE/.env.deploy.draft"

{
  echo "# Images inside images.tar.gz — target .env.deploy must match exactly."
  echo "DEPLOY_MODE=${MODE}"
  echo "AO_IMAGE=${AO_IMAGE}"
  echo "POSTGRES_IMAGE=${POSTGRES_IMAGE}"
  if [ "$MODE" = "bundled" ]; then echo "INNGEST_IMAGE=${INNGEST_IMAGE}"; fi
  echo "AO_PUBLIC_ORIGIN=${PUBLIC_ORIGIN}"
  echo "INNGEST_PUBLIC_ORIGIN=${INNGEST_ORIGIN}"
} > "$STAGE/IMAGES.env"

cat > "$STAGE/README-TARGET.md" <<'EOF'
# 目标机快速部署（离线包）

完整说明见同目录 `deployment-full-guide.md`。在解压后的目录里依次执行：

```bash
# 1. 导入镜像（shared 包含 AO+Postgres；bundled 额外包含 Inngest）
docker load -i images.tar.gz

# 2. 生成并编辑环境文件：镜像 tag 和公开地址已预填，
#    只需替换所有 replace-* 占位（密钥、外部依赖地址）
cp .env.deploy.draft .env.deploy
open -e .env.deploy   # 或 vi .env.deploy

# 3. 外部依赖连通自检（LLM 网关 / Allmeta / RoboHire / RAAS PG / MinIO）
bash scripts/check-connectivity.sh --env-file .env.deploy

# 4. 配置静态校验（用刚 load 的 AO 镜像里的 node 跑，不需要本机装 Node）
docker run --rm --entrypoint node -v "$PWD:/kit" -w /kit \
  "$(grep '^AO_IMAGE=' IMAGES.env | cut -d= -f2)" \
  scripts/deploy-preflight.mjs --env-file .env.deploy

# 5. 默认先只起新 Postgres。DATABASE_SCHEMA_SYNC=0，不会在 app 启动时
#    自动改 schema。shared 仍使用同一 overlay 文件组合；按完整指南把旧库
#    pg_dump 恢复到新卷、审查 schema SQL diff，再事务执行已批准文件。
read_env_value() {
  env_key="$1"
  sed -En "s/^[[:space:]]*(export[[:space:]]+)?${env_key}[[:space:]]*=[[:space:]]*(.*)$/\2/p" .env.deploy \
    | tail -n 1 | tr -d "\"'" | xargs
}
NEW_AO_PROJECT=$(read_env_value COMPOSE_PROJECT_NAME)
NEW_AO_VOLUME="${NEW_AO_PROJECT}-postgres-data"
test -n "$NEW_AO_PROJECT"
if docker volume inspect "$NEW_AO_VOLUME" >/dev/null 2>&1; then
  echo "STOP: target volume already exists: $NEW_AO_VOLUME" >&2
  echo "Follow deployment-full-guide.md to verify whether it is a resumable ao-v2 rehearsal volume." >&2
  exit 1
fi
bash scripts/deploy-compose.sh --env-file .env.deploy -- up -d --wait ao-postgres

# 6. 数据恢复、批准 SQL 执行与空 diff 验证完成后，还必须按完整指南完成
#    partner candidate 手机号 dry-run/人工治理/apply。三项不为 0 时禁止启动
#    app 或注册 callback，避免旧 86138... 与新 11 位键在窗口内造重复 Candidate。
test -s backups/candidate-mobile-backfill-post-apply.txt
grep -q '"conflict_groups": 0' backups/candidate-mobile-backfill-post-apply.txt
grep -q '"manual_review_rows": 0' backups/candidate-mobile-backfill-post-apply.txt
grep -q '"rows_requiring_change": 0' backups/candidate-mobile-backfill-post-apply.txt

#    上述硬闸通过后再起服务。包装脚本从 .env.deploy 选择 shared/bundled
#    以及 new/external volume 文件组合，并隔离宿主 shell 的同名变量。
bash scripts/deploy-compose.sh --env-file .env.deploy -- up -d --wait

# 7. 验收（使用与第 6 步相同的 compose 文件组合）
bash scripts/deploy-compose.sh --env-file .env.deploy -- ps
curl -fsS "http://localhost:3002/api/health?check=ready"
```

若这台机器上还有旧版 Agentic Operator 容器占用 3002/8288 端口，先按
`deployment-full-guide.md`「原地升级」一节完成备份/排空，再执行第 5 步。
EOF

echo "==> [5/5] packing ${BUNDLE}"
tar cf "$BUNDLE" -C "$STAGE" .
echo ""
echo "Done: ${BUNDLE} ($(du -h "$BUNDLE" | cut -f1))"
echo "Transfer it to the target machine, then: mkdir ao-deploy && tar xf ${BUNDLE} -C ao-deploy"
