#!/usr/bin/env bash
# Build the AO image and pack everything an OFFLINE target machine needs into
# one tarball: app + postgres + inngest images, compose file, a pre-filled
# .env.deploy draft, and the preflight / connectivity / survey scripts.
#
# Run on a machine WITH internet + Docker (the build machine):
#
#   scripts/make-deploy-bundle.sh \
#     --public-origin  http://<target-lan-ip>:3002 \
#     --inngest-origin http://<target-lan-ip>:8288 \
#     [--arch arm64|amd64]   # default arm64 (Apple Silicon target)
#     [--tag  <image-tag>]   # default vYYYYMMDD
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
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:17.10-alpine}"
INNGEST_IMAGE="${INNGEST_IMAGE:-inngest/inngest:v1.19.2}"

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --public-origin) PUBLIC_ORIGIN="$2"; shift 2 ;;
    --inngest-origin) INNGEST_ORIGIN="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

if [ -z "$PUBLIC_ORIGIN" ] || [ -z "$INNGEST_ORIGIN" ]; then
  echo "ERROR: --public-origin and --inngest-origin are required." >&2
  echo "  e.g. --public-origin http://10.100.0.42:3002 --inngest-origin http://10.100.0.42:8288" >&2
  exit 1
fi

AO_IMAGE="agentic-operator:${TAG}-${ARCH}"
PLATFORM="linux/${ARCH}"
STAGE="deploy-bundle-stage"
BUNDLE="ao-deploy-bundle-${TAG}-${ARCH}.tar"

echo "==> [1/5] building ${AO_IMAGE} for ${PLATFORM}"
docker build --platform "$PLATFORM" \
  --build-arg NEXT_PUBLIC_BASE_URL="$PUBLIC_ORIGIN" \
  --build-arg NEXT_PUBLIC_INNGEST_URL="$INNGEST_ORIGIN" \
  --build-arg NEXT_PUBLIC_FACTORY_ENABLED=0 \
  -t "$AO_IMAGE" -f Dockerfile .

echo "==> [2/5] pulling ${POSTGRES_IMAGE} and ${INNGEST_IMAGE} for ${PLATFORM}"
docker pull --platform "$PLATFORM" "$POSTGRES_IMAGE"
docker pull --platform "$PLATFORM" "$INNGEST_IMAGE"

echo "==> [3/5] saving images (multi-GB step, takes a few minutes)"
rm -rf "$STAGE"
mkdir -p "$STAGE/scripts"
docker save "$AO_IMAGE" "$POSTGRES_IMAGE" "$INNGEST_IMAGE" | gzip > "$STAGE/images.tar.gz"

echo "==> [4/5] staging deploy kit"
cp docker-compose.deploy.yml docker-compose.shared-inngest.yml "$STAGE/"
cp docs/deploy/deployment.md "$STAGE/deployment-full-guide.md"
cp scripts/deploy-preflight.mjs scripts/check-connectivity.sh scripts/survey-old-deployment.sh "$STAGE/scripts/"
chmod +x "$STAGE"/scripts/*.sh

# Pre-fill the env draft so the target machine only edits secrets/endpoints.
sed -E \
  -e "s#^AO_IMAGE=.*#AO_IMAGE=${AO_IMAGE}#" \
  -e "s#^POSTGRES_IMAGE=.*#POSTGRES_IMAGE=${POSTGRES_IMAGE}#" \
  -e "s#^INNGEST_IMAGE=.*#INNGEST_IMAGE=${INNGEST_IMAGE}#" \
  -e "s#^AO_PUBLIC_ORIGIN=.*#AO_PUBLIC_ORIGIN=${PUBLIC_ORIGIN}#" \
  -e "s#^INNGEST_PUBLIC_ORIGIN=.*#INNGEST_PUBLIC_ORIGIN=${INNGEST_ORIGIN}#" \
  .env.deploy.example > "$STAGE/.env.deploy.draft"

{
  echo "# Images inside images.tar.gz — target .env.deploy must match exactly."
  echo "AO_IMAGE=${AO_IMAGE}"
  echo "POSTGRES_IMAGE=${POSTGRES_IMAGE}"
  echo "INNGEST_IMAGE=${INNGEST_IMAGE}"
  echo "AO_PUBLIC_ORIGIN=${PUBLIC_ORIGIN}"
  echo "INNGEST_PUBLIC_ORIGIN=${INNGEST_ORIGIN}"
} > "$STAGE/IMAGES.env"

cat > "$STAGE/README-TARGET.md" <<'EOF'
# 目标机快速部署（离线包）

完整说明见仓库 docs/deploy/deployment.md。在解压后的目录里依次执行：

```bash
# 1. 导入三个镜像（几分钟）
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

# 5. 起整套服务（注意：没有 --build，全部用已导入的镜像）
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --wait

# 6. 验收
docker compose --env-file .env.deploy -f docker-compose.deploy.yml ps
curl -fsS "http://localhost:3002/api/health?check=ready"
```

若这台机器上还有旧版 Agentic Operator 容器占用 3002/8288 端口，先按
docs/deploy/deployment.md「原地升级」一节停掉旧容器再执行第 5 步。
EOF

echo "==> [5/5] packing ${BUNDLE}"
tar cf "$BUNDLE" -C "$STAGE" .
rm -rf "$STAGE"
echo ""
echo "Done: ${BUNDLE} ($(du -h "$BUNDLE" | cut -f1))"
echo "Transfer it to the target machine, then: mkdir ao-deploy && tar xf ${BUNDLE} -C ao-deploy"
