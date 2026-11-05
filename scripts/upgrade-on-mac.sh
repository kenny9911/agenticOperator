#!/usr/bin/env bash
# upgrade-on-mac.sh — One-click AO (ao-v2) prod upgrade on 10.100.0.70 (Mac Studio).
#
#     ./scripts/upgrade-on-mac.sh            # 正常升级
#     ./scripts/upgrade-on-mac.sh --check    # 只体检 + 预览这次要升什么，不改任何东西
#     ./scripts/upgrade-on-mac.sh --force    # 没有新 commit 也重建镜像
#     ./scripts/upgrade-on-mac.sh --drained  # 已在 Inngest UI 确认 0/0 并暂停入口，跳过交互确认
#
# 这个脚本刻意和 raas 的 upgrade-on-mac.sh 不同，因为 AO 的生产约束不一样：
#
#   1. 所有 compose 操作必须走 scripts/deploy-compose.sh 包装。裸 `docker compose`
#      会让宿主 shell 里的同名变量盖掉 .env.deploy，preflight 校验的是一套、
#      实际操作的是另一套。
#   2. DATABASE_SCHEMA_SYNC=0 —— 本脚本【绝不】自动改数据库。查出 schema 差异
#      就停在启动新容器之前，转 docs/deploy/deployment.md §5.5 的
#      「生成 SQL → 人工审批 → psql -1 → 验空差异」链路。raas 那套
#      `prisma migrate deploy` 在这里是禁止的。
#   3. 共享 Inngest 只允许一个 callback。重建 app 前必须排空在途 run，
#      之后必须显式重注册（main 镜像不像 steven 那样自动 PUT）。
#   4. /Users/ai-eas-coe/ao-v2 有 5 个未回流仓库的本地补丁。pull 前后都要校验；
#      上游一旦改到这些文件，脚本硬停，交人工合并。
#   5. 回滚 = 把 .env.deploy 的 AO_IMAGE 改回旧 tag 再 up。所以升级一定打新 tag，
#      不覆盖同名镜像。【回滚不要动 git】——工作区的本地补丁是未提交状态，
#      `git reset --hard` 会把它们全部抹掉。
#
# 脚本不读、不打印、不外传任何密钥。macOS 自带 bash 3.2 —— 无关联数组，用平行索引数组。
#
# ⚠️ 改本脚本时注意：变量后面紧跟全角字符（）「」，—— 等）时必须用花括号形式，裸写会崩。
#    macOS bash 3.2 在非 C locale 下会把全角字符的字节吞进变量名，`set -u` 当场退出。
#    这和 scripts/check-connectivity.sh 的本地补丁是同一个坑（2026-08-17 本脚本首跑踩中）。
#    自查：node -e 'console.log((require("fs").readFileSync(process.argv[1],"utf8")
#      .match(/\$[A-Za-z_0-9@*?#][A-Za-z0-9_]*[^\x00-\x7F]/g)||[]).join("\n"))' scripts/upgrade-on-mac.sh

set -uo pipefail

# ── flags ───────────────────────────────────────────────────────────
FORCE=0
CHECK_ONLY=0
ASSUME_DRAINED=0
ASSUME_YES=0
REUSE_IMAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force)   FORCE=1; shift ;;
    -n|--check)   CHECK_ONLY=1; shift ;;
    --drained)    ASSUME_DRAINED=1; shift ;;
    -y|--yes)     ASSUME_YES=1; shift ;;
    --reuse-image)
      [[ $# -ge 2 ]] || { echo "--reuse-image 需要一个镜像 tag"; exit 64; }
      REUSE_IMAGE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--check] [--force] [--drained] [--yes] [--reuse-image TAG]"
      echo "  --check,   -n     只做只读体检 + 预览待升 commit，不 pull / 不构建 / 不重启"
      echo "  --force,   -f     没有新 commit 也重新构建并重建容器"
      echo "  --drained         已确认 RAAS 入口已暂停且 running=0/queued=0，跳过交互确认"
      echo "  --yes,     -y     非交互模式（CI / 无 TTY）：所有确认视为 yes"
      echo "  --reuse-image TAG 跳过构建，复用已有镜像（用于上一轮构建成功但后续步骤失败的重跑）。"
      echo "                    会逐个比对镜像内源码与工作区的 sha256，不一致直接中止。"
      exit 0 ;;
    *) echo "Unknown arg: $1 (use --help)"; exit 64 ;;
  esac
done

# ── self-update guard ───────────────────────────────────────────────
# 正在运行的 bash 无法可靠地热加载对自身的修改。下面第 5 步会 ff-merge
# origin/main，可能拉进来一个新版本的【本脚本】，但已载入内存的旧副本会继续跑完。
# raas 那边为此踩过两次。修法：先按绝对路径哈希自己，git 更新后重新哈希，
# 变了就 exec 新版本（--force 隐含，因为此时 HEAD 已等于 origin/main）。
case "$0" in
  /*) SELF_PATH="$0" ;;
  *)  SELF_PATH="$PWD/$0" ;;
esac
self_hash(){ md5 -q "$SELF_PATH" 2>/dev/null || md5sum "$SELF_PATH" 2>/dev/null | cut -d' ' -f1; }
SELF_HASH_AT_START="$(self_hash)"

# ── config (override via env) ───────────────────────────────────────
DEPLOY_DIR="${DEPLOY_DIR:-/Users/ai-eas-coe/ao-v2}"
ENV_FILE="${ENV_FILE:-.env.deploy}"
EXPECT_MODE="${EXPECT_MODE:-shared}"
EXPECT_VOLUME_MODE="${EXPECT_VOLUME_MODE:-new}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BUILD_RETRIES="${BUILD_RETRIES:-3}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-240}"
DRAIN_TIMEOUT_S="${DRAIN_TIMEOUT_S:-900}"
DRAIN_POLL_S="${DRAIN_POLL_S:-15}"
DRAIN_WINDOW_HOURS="${DRAIN_WINDOW_HOURS:-72}"
REGISTER_RETRIES="${REGISTER_RETRIES:-6}"
INNGEST_APP_ID="${INNGEST_APP_ID:-agentic-operator-main}"

# shared 模式下的五个服务；这里绝不该出现 inngest（那是共享实例，不归 AO compose 管）
EXPECTED_SERVICES="ao-postgres gotenberg app archiver monitor-sweeper"

# 升级前后各点一次的表（AO 自有库）
COUNT_TABLES=('"WorkflowRun"' '"RuleCheckAudit"' 'inngest_run_archive' 'log_event')

# ── 5 个未回流的本地补丁（2026-08-05 为打通内网所加）───────────────
# 平行数组：文件 / 特征串 / 最少出现次数。少于期望 = 补丁被覆盖了。
PATCH_FILE=(Dockerfile Dockerfile docker-compose.deploy.yml docker-compose.shared-inngest.yml lib/inngest-admin-client.ts)
PATCH_PATTERN=('PRISMA_ENGINES_MIRROR' 'sha256:' 'INNGEST_DEV: ${INNGEST_DEV' 'raas-partner' 'inngestAuthHeaders')
PATCH_MIN=(2 4 1 5 4)
PATCH_WHY=(
  'prisma engines 镜像源（70 上解析不了 binaries.prisma.sh）'
  'FROM 固定 digest（避免每次联网 resolve tag 超时）'
  'INNGEST_DEV 可被 env 覆盖（共享 Inngest 是生产模式）'
  'shared overlay 第二个 external network（partner PG）'
  'archiver 的 Inngest Bearer 认证 + 事件路径（否则归档恒空）'
)
# 上游一旦改到这些文件，自动 pull 会把补丁冲掉或产生冲突 —— 一律硬停。
PROTECTED_FILES=(
  Dockerfile
  docker-compose.deploy.yml
  docker-compose.shared-inngest.yml
  lib/inngest-admin-client.ts
  scripts/check-connectivity.sh
)

if [[ -t 1 ]]; then
  R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; B='\033[0;34m'; C='\033[0;36m'; N='\033[0m'
else R=''; G=''; Y=''; B=''; C=''; N=''; fi
step(){ echo -e "\n${B}▶ $1${N}"; }
ok(){   echo -e "  ${G}✓${N} $1"; }
warn(){ echo -e "  ${Y}⚠${N} $1"; }
fail(){ echo -e "  ${R}✗${N} $1"; }

ENV_BUMPED=0
OLD_IMAGE=""
ROLLBACK_HASH=""
DB_BACKUP_FILE=""
# 只有走到"新镜像可能已经在跑"之后（第 8 步起）失败才需要回滚指引。
# 更早的中止一律没动过运行中的旧栈，打印回滚步骤只会误导操作员。
SHOW_ROLLBACK=0

restore_ao_image(){
  (( ENV_BUMPED )) || return 0
  [[ -n "$OLD_IMAGE" ]] || return 0
  sed -i '' "s|^AO_IMAGE=.*|AO_IMAGE=${OLD_IMAGE}|" "$ENV_FILE" \
    && { ENV_BUMPED=0; warn "$ENV_FILE 的 AO_IMAGE 已回退为 ${OLD_IMAGE}（旧容器未被动过）"; } \
    || fail "无法回退 AO_IMAGE，请手工把 $ENV_FILE 的 AO_IMAGE 改回 $OLD_IMAGE"
}

print_rollback(){
  if (( SHOW_ROLLBACK == 0 )); then
    echo -e "  ${C}（本次中止发生在切换之前：旧容器、旧镜像、数据库都未被改动，无需回滚。）${N}"
    return 0
  fi
  [[ -n "$OLD_IMAGE" ]] || return 0
  echo ""
  echo -e "${Y}━━━ ROLLBACK ━━━${N}"
  echo    "  cd '$DEPLOY_DIR'"
  echo    "  sed -i '' 's|^AO_IMAGE=.*|AO_IMAGE=${OLD_IMAGE}|' $ENV_FILE"
  echo    "  bash scripts/deploy-compose.sh --env-file $ENV_FILE -- up -d --wait"
  echo    "  bash scripts/deploy-compose.sh --env-file $ENV_FILE -- exec -T app \\"
  echo    "    /app/node_modules/.bin/tsx /app/scripts/register-with-inngest.ts"
  echo    "  # 然后在 Inngest UI 确认 $INNGEST_APP_ID 只有一个 callback"
  echo -e "  ${R}不要用 git reset --hard 回滚代码${N}：工作区里 5 个本地补丁是未提交状态，会被抹掉。"
  echo    "  运行物是镜像，改 AO_IMAGE 就已经回到旧版本。（旧提交：${ROLLBACK_HASH:-未知}）"
  [[ -n "$DB_BACKUP_FILE" ]] && \
  echo    "  # 数据库本次未被修改；万一需要：pg_restore 备份 $DB_BACKUP_FILE"
  echo -e "${Y}━━━━━━━━━━━━━━━━${N}"
}

die(){
  echo -e "\n${R}❌ ABORT:${N} $1"
  restore_ao_image
  print_rollback
  exit 1
}

# .env.deploy 取值（和 deploy-compose.sh 的 read_env_value 同语义，含去引号）
read_env(){
  local raw
  raw=$(sed -En "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*(.*)$/\\2/p" "$ENV_FILE" | tail -n 1)
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  if [[ "$raw" == \"*\" && "$raw" == *\" ]]; then raw=${raw:1:${#raw}-2}
  elif [[ "$raw" == \'*\' && "$raw" == *\' ]]; then raw=${raw:1:${#raw}-2}; fi
  printf '%s' "$raw"
}

aoc(){
  bash scripts/deploy-compose.sh --env-file "$ENV_FILE" \
    --expect-mode "$EXPECT_MODE" --expect-volume-mode "$EXPECT_VOLUME_MODE" -- "$@"
}

pg_scalar(){ # pg_scalar <sql-without-single-quotes>
  aoc exec -T ao-postgres sh -c \
    "psql -X -q -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tA -c '$1'" 2>/dev/null | tr -d '[:space:]'
}

confirm(){ # confirm <prompt>
  (( ASSUME_YES )) && { ok "非交互模式，自动确认：$1"; return 0; }
  [[ -t 0 ]] || die "需要人工确认「${1}」但当前无 TTY。确认无误后加 --yes 重跑。"
  local reply=""
  read -r -p "  ❔ $1 [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || die "操作员未确认：$1"
}

retry(){ # retry <n> <label> <cmd...>
  local n="$1" label="$2"; shift 2
  local i=1
  while (( i <= n )); do
    echo -e "  ${C}· $label (attempt $i/$n)${N}"
    if "$@"; then return 0; fi
    warn "$label 失败 (attempt $i/$n)"
    i=$((i+1)); sleep 5
  done
  return 1
}

# ── 0. preflight ────────────────────────────────────────────────────
step "0/12  Preflight"
[[ -d "$DEPLOY_DIR" ]] || die "部署目录不存在：${DEPLOY_DIR}（可用 DEPLOY_DIR=... 覆盖）"
cd "$DEPLOY_DIR" || die "cd 失败：$DEPLOY_DIR"
command -v docker >/dev/null || die "PATH 里没有 docker"
command -v git    >/dev/null || die "PATH 里没有 git"
command -v curl   >/dev/null || die "PATH 里没有 curl"
docker info >/dev/null 2>&1  || die "连不上 docker daemon（先启动 Docker Desktop）"
[[ -f "$ENV_FILE" ]]                 || die "$DEPLOY_DIR/$ENV_FILE 不存在"
[[ -f scripts/deploy-compose.sh ]]   || die "缺少 scripts/deploy-compose.sh —— 这里不像是 ao-v2 仓库"
[[ -d .git ]]                        || die "$DEPLOY_DIR 不是 git 工作区（离线包部署请走 docs/deploy/deployment.md §9）"
ok "部署目录 / docker / git / $ENV_FILE 就位"

DEPLOY_MODE_V="$(read_env DEPLOY_MODE)"
VOLUME_MODE_V="$(read_env AO_POSTGRES_VOLUME_MODE)"
SCHEMA_SYNC_V="$(read_env DATABASE_SCHEMA_SYNC)"
AO_PORT_V="$(read_env AO_PORT)"; AO_PORT_V="${AO_PORT_V:-3002}"
PROJECT_V="$(read_env COMPOSE_PROJECT_NAME)"
INNGEST_DEV_V="$(read_env INNGEST_DEV)"
MIRROR_V="$(read_env PRISMA_ENGINES_MIRROR)"
OLD_IMAGE="$(read_env AO_IMAGE)"

[[ "$DEPLOY_MODE_V" == "$EXPECT_MODE" ]] \
  || die "DEPLOY_MODE=${DEPLOY_MODE_V}，期望 ${EXPECT_MODE}（生产是共享 Inngest）"
[[ "$VOLUME_MODE_V" == "$EXPECT_VOLUME_MODE" ]] \
  || die "AO_POSTGRES_VOLUME_MODE=${VOLUME_MODE_V}，期望 $EXPECT_VOLUME_MODE"
[[ "$SCHEMA_SYNC_V" == "0" ]] \
  || die "DATABASE_SCHEMA_SYNC=$SCHEMA_SYNC_V —— 生产必须是 0，否则 app 启动会自动 prisma db push 改生产库"
[[ -n "$OLD_IMAGE" ]] \
  || die "$ENV_FILE 里没有 AO_IMAGE= 这一行。脚本靠改这行做版本切换与回滚，请先补上。"
grep -q '^AO_IMAGE=' "$ENV_FILE" \
  || die "$ENV_FILE 的 AO_IMAGE 不在行首（可能被注释/缩进），脚本无法安全改写"
ok "DEPLOY_MODE=$DEPLOY_MODE_V · VOLUME_MODE=$VOLUME_MODE_V · DATABASE_SCHEMA_SYNC=0"
ok "COMPOSE_PROJECT_NAME=${PROJECT_V:-<default>} · 宿主端口 AO_PORT=$AO_PORT_V · 当前镜像 $OLD_IMAGE"

# 这两个不是致命项，但缺了会以很隐蔽的方式坏掉，先亮出来
[[ "$INNGEST_DEV_V" == "0" ]] || warn "INNGEST_DEV=${INNGEST_DEV_V:-<未设置>} —— 共享 Inngest 是生产模式，应为 0"
[[ -n "$MIRROR_V" ]] || warn "未设置 PRISMA_ENGINES_MIRROR —— 构建时 prisma engines 可能拉不下来"

aoc config --quiet || die "compose 无法用 $ENV_FILE 解析（overlay/网络名/必填变量有问题）"
ok "compose 配置可解析（wrapper 已叠加 shared overlay 并清掉宿主同名变量）"

# ── 1. 本地补丁校验（pull 前）───────────────────────────────────────
step "1/12  本地补丁校验（pull 前）"
check_patches(){ # check_patches <label>
  local bad=0 i=0 n cnt
  n=${#PATCH_FILE[@]}
  while (( i < n )); do
    if [[ ! -f "${PATCH_FILE[$i]}" ]]; then
      fail "${PATCH_FILE[$i]} 不存在"; bad=1; i=$((i+1)); continue
    fi
    cnt="$(grep -c -- "${PATCH_PATTERN[$i]}" "${PATCH_FILE[$i]}" 2>/dev/null || true)"
    cnt="${cnt:-0}"
    if (( cnt >= PATCH_MIN[i] )); then
      ok "$(printf '%-36s %2s/%s  %s' "${PATCH_FILE[$i]}" "$cnt" "${PATCH_MIN[$i]}" "${PATCH_WHY[$i]}")"
    else
      fail "$(printf '%-36s %2s/%s  补丁丢失：%s' "${PATCH_FILE[$i]}" "$cnt" "${PATCH_MIN[$i]}" "${PATCH_WHY[$i]}")"
      bad=1
    fi
    i=$((i+1))
  done
  (( bad == 0 )) || die "本地补丁校验未通过（${1}）。见 docs/deploy/deployment.md 与部署备忘；\
补齐后再升级——否则构建失败、或归档静默 401（UI 完全看不出来）。"
}
check_patches "pull 前"

# ── 2. 记录回滚锚点 ─────────────────────────────────────────────────
step "2/12  记录回滚锚点"
ROLLBACK_HASH="${AO_UPGRADE_ROLLBACK_HASH:-$(git rev-parse HEAD)}"
TS="$(date +%Y%m%d-%H%M%S)"
ARCH="$(uname -m)"
mkdir -p "$BACKUP_DIR"
{
  echo "ts=$TS"
  echo "commit=$ROLLBACK_HASH"
  echo "image=$OLD_IMAGE"
} > "$BACKUP_DIR/upgrade-$TS.rollback"
ok "HEAD=$(git rev-parse --short "$ROLLBACK_HASH") · AO_IMAGE=$OLD_IMAGE"
ok "已存 $BACKUP_DIR/upgrade-$TS.rollback"

# ── 3. git fetch + 预览待升内容（--check 到这里就结束）──────────────
step "3/12  git fetch + 预览待升 commit"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || warn "当前分支是 ${BRANCH}（生产口径是 main）"
git fetch origin --prune || die "git fetch 失败（代理没开？）"
NEW_REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null)" \
  || die "取不到 origin/$BRANCH"
NEW_SHORT="$(git rev-parse --short "$NEW_REMOTE")"

if [[ "$NEW_REMOTE" == "$ROLLBACK_HASH" ]]; then
  ok "已经是 origin/${BRANCH}（${NEW_SHORT}），没有新 commit"
  HAS_NEW=0
else
  HAS_NEW=1
  echo "  待升 commit："
  git log --oneline "${ROLLBACK_HASH}..${NEW_REMOTE}" | head -20 | sed 's/^/    /'
  echo "    （共 $(git log --oneline "${ROLLBACK_HASH}..${NEW_REMOTE}" | wc -l | tr -d ' ') 个）"
  echo "  改动文件："
  git diff --name-only "${ROLLBACK_HASH}..${NEW_REMOTE}" | head -40 | sed 's/^/    /'
  # 提前预警：真正的 schema 闸门在第 9 步（要用新镜像比对生产库），但那在构建之后。
  # 这里先看一眼 prisma/ 有没有动，免得操作员白等一次构建才发现要走人工审批链。
  if ! git diff --quiet "$ROLLBACK_HASH" "$NEW_REMOTE" -- prisma/; then
    warn "本次改动包含 prisma/ —— 大概率有 schema 变更，第 9 步会硬停并要求走"
    warn "docs/deploy/deployment.md §5.5 的人工审批链。建议先准备好再开始升级。"
  else
    ok "本次改动未触及 prisma/（预期第 9 步为空差异）"
  fi
fi

# 上游是否碰了受保护文件（本地补丁所在）
COLLISION=""
if (( HAS_NEW )); then
  for f in "${PROTECTED_FILES[@]}"; do
    if ! git diff --quiet "$ROLLBACK_HASH" "$NEW_REMOTE" -- "$f"; then
      if [[ -n "$(git status --porcelain -- "$f")" ]]; then
        COLLISION="$COLLISION $f"
      else
        warn "上游改了 ${f}，但本机该文件无未提交改动（补丁可能已回流）"
      fi
    fi
  done
fi
if [[ -n "$COLLISION" ]]; then
  echo ""
  fail "上游改动与本地补丁撞车：$COLLISION"
  echo "  这些文件在本机有未提交的补丁，自动 pull 会冲突或悄悄覆盖它们。"
  echo "  处理方式：人工逐个合并（先 git diff 看上游改了什么，再把补丁重新打上），"
  echo "  或推动把补丁回流到仓库。合并完再重跑本脚本。"
  die "受保护文件撞车，拒绝自动 pull"
fi
(( HAS_NEW )) && ok "上游未触碰任何受保护文件，可以安全 ff-merge"

# 是否有本地补丁之外的意外改动
UNEXPECTED="$(git status --porcelain | awk '{print $2}' \
  | grep -vE '^(Dockerfile|docker-compose\.deploy\.yml|docker-compose\.shared-inngest\.yml|lib/inngest-admin-client\.ts|scripts/check-connectivity\.sh|\.env\.deploy.*|backups/.*|IMAGES\.env)$' || true)"
if [[ -n "$UNEXPECTED" ]]; then
  warn "工作区还有本地补丁之外的改动："
  echo "$UNEXPECTED" | sed 's/^/      /'
  confirm "确认这些改动可以保留在生产工作区并继续升级？"
fi

if (( CHECK_ONLY )); then
  step "--check 完成"
  echo -e "  ${C}只读体检结束：没有 pull、没有构建、没有重启任何容器。${N}"
  exit 0
fi

if (( HAS_NEW == 0 )) && (( FORCE == 0 )); then
  echo ""
  echo -e "${C}没有新 commit。要强制重建镜像并重启，请加 --force。${N}"
  exit 0
fi
(( HAS_NEW == 0 )) && warn "没有新 commit —— --force：继续重建 + 重启"

# ── 4. 备份（在线，不停服）──────────────────────────────────────────
step "4/12  备份（pg_dump + ${ENV_FILE}）"
cp "$ENV_FILE" "$BACKUP_DIR/$(basename "$ENV_FILE").bak.$TS" \
  && ok "$BACKUP_DIR/$(basename "$ENV_FILE").bak.$TS" \
  || die "备份 $ENV_FILE 失败"
DB_BACKUP_FILE="$BACKUP_DIR/ao-$TS.dump"
aoc exec -T ao-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DB_BACKUP_FILE" \
  || die "pg_dump 失败（ao-postgres 没起？）"
[[ -s "$DB_BACKUP_FILE" ]] || die "pg_dump 产出空文件：$DB_BACKUP_FILE"
ok "数据库备份 ${DB_BACKUP_FILE}（$(du -h "$DB_BACKUP_FILE" | cut -f1)）"
find "$BACKUP_DIR" -maxdepth 1 -name 'ao-*.dump' -type f \
  -mtime +"$BACKUP_RETENTION_DAYS" -delete 2>/dev/null || true

# ── 5. 行数快照（升级前）────────────────────────────────────────────
step "5/12  行数快照（升级前）"
PRE_COUNTS=()
for t in "${COUNT_TABLES[@]}"; do
  c="$(pg_scalar "select count(*) from $t")"
  [[ -n "$c" ]] || c="n/a"
  PRE_COUNTS+=("$c"); printf "  %-28s %s\n" "$t" "$c"
done

# ── 6. ff-only merge（+ 自更新 re-exec）─────────────────────────────
step "6/12  git merge --ff-only origin/$BRANCH"
if (( HAS_NEW )); then
  git merge --ff-only "origin/$BRANCH" 2>&1 | tail -3 | sed 's/^/      /' \
    || die "ff-only merge 失败（部署树分叉了？先 git status / git log 看清楚）"
  ok "$(git rev-parse --short "$ROLLBACK_HASH") → $NEW_SHORT"
else
  ok "已在 ${NEW_SHORT}，跳过 merge"
fi

if [[ -z "${AO_UPGRADE_REEXECED:-}" && "$(self_hash)" != "$SELF_HASH_AT_START" ]]; then
  warn "本升级脚本被刚才的 pull 更新了 —— 重新 exec 新版本继续"
  export AO_UPGRADE_REEXECED=1
  export AO_UPGRADE_ROLLBACK_HASH="$ROLLBACK_HASH"
  # --force 是隐含的：此时 HEAD 已等于 origin/main，新进程的第 3 步会判定"无新 commit"。
  REEXEC_ARGS=(--force)
  (( ASSUME_DRAINED )) && REEXEC_ARGS+=(--drained)
  (( ASSUME_YES ))     && REEXEC_ARGS+=(--yes)
  [[ -n "$REUSE_IMAGE" ]] && REEXEC_ARGS+=(--reuse-image "$REUSE_IMAGE")
  exec bash "$SELF_PATH" "${REEXEC_ARGS[@]}"
fi

# ── 7. 本地补丁校验（pull 后）───────────────────────────────────────
step "7/12  本地补丁校验（pull 后）"
check_patches "pull 后"

# ── 8. 构建新镜像（打新 tag，旧镜像保留作回滚锚点）──────────────────
# 复用已有镜像时的内容校验：把本次改动涉及的源文件在镜像里和工作区里各算一次
# sha256。运行时阶段是 `COPY . .`，所以源码确实在 /app 下。任何一个对不上就中止 ——
# 否则 --reuse-image 会变成"拿旧代码冒充新版本上线"的静默事故。
verify_reused_image(){ # verify_reused_image <tag>
  local img="$1" f in_img host bad=0 files
  files="$(git diff --name-only "$ROLLBACK_HASH" HEAD -- server lib app prisma 2>/dev/null \
           | grep -vE '\.test\.|\.spec\.' | head -6)"
  if [[ -z "$files" ]]; then
    warn "本次改动不含 server/lib/app/prisma 下的源文件，跳过镜像内容校验"
    return 0
  fi
  for f in $files; do
    in_img="$(docker run --rm --entrypoint sha256sum "$img" "/app/$f" 2>/dev/null | awk '{print $1}')"
    host="$(shasum -a 256 "$f" 2>/dev/null | awk '{print $1}')"
    if [[ -z "$in_img" || -z "$host" || "$in_img" != "$host" ]]; then
      fail "镜像内 /app/$f 与工作区不一致（镜像=${in_img:-取不到} 工作区=${host:-取不到}）"
      bad=1
    else
      ok "镜像内容校验通过：$f"
    fi
  done
  return $bad
}

if [[ -n "$REUSE_IMAGE" ]]; then
  step "8/12  复用已有镜像（--reuse-image，跳过构建）"
  docker image inspect "$REUSE_IMAGE" >/dev/null 2>&1 \
    || die "镜像不存在：${REUSE_IMAGE}（docker images | grep agentic-operator 看看有哪些）"
  NEW_IMAGE="$REUSE_IMAGE"
  verify_reused_image "$NEW_IMAGE" \
    || die "复用的镜像与当前代码不一致，拒绝上线。去掉 --reuse-image 正常构建。"
  sed -i '' "s|^AO_IMAGE=.*|AO_IMAGE=${NEW_IMAGE}|" "$ENV_FILE" || die "无法改写 AO_IMAGE"
  ENV_BUMPED=1
  ok "AO_IMAGE: $OLD_IMAGE → ${NEW_IMAGE}（未重新构建）"
else
  step "8/12  构建新镜像（旧栈仍在服务，零影响）"
  NEW_IMAGE="agentic-operator:${TS}-${NEW_SHORT}-${ARCH}"
  sed -i '' "s|^AO_IMAGE=.*|AO_IMAGE=${NEW_IMAGE}|" "$ENV_FILE" || die "无法改写 AO_IMAGE"
  ENV_BUMPED=1
  ok "AO_IMAGE: $OLD_IMAGE → $NEW_IMAGE"
  do_build(){ aoc build app; }
  retry "$BUILD_RETRIES" "compose build app" do_build \
    || die "构建 $BUILD_RETRIES 次都失败。常见原因：代理没开（拉不到 prisma engines / npm 包）、\
工作区有改到一半的 TS 代码（next build 用的是工作区快照）。旧容器完全没被动过。"
  docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || die "构建声称成功但镜像 $NEW_IMAGE 不存在"
  ok "新镜像已就绪：$NEW_IMAGE"
fi

# ── 9. Schema 闸门（只读；有差异就停在切换之前）─────────────────────
step "9/12  Schema 闸门（新镜像的 schema.prisma vs 生产库）"
# 本脚本【不】改数据库。这里只证明「新代码需要的 schema == 生产库现状」。
# 一旦有差异，必须走 docs/deploy/deployment.md §5.5 的人工审批链，
# 而不是让任何自动化对生产库执行 DDL。
#
# ⚠️ 权威判据是 --exit-code（Empty=0 / Error=1 / Not empty=2），不是 --script 的文本输出。
#    Prisma 7 的 CLI 会把 dotenvx 横幅（"◇ injected env (0) from .env.local …"）打到
#    stdout，和 SQL 混在一起；按"文本非空即有差异"判断会稳定误报。2026-08-17 首次
#    生产运行就是这样被误拦的（当时真实差异为空）。退出码不受 stdout 噪声影响。
aoc run --rm -T --no-deps --entrypoint /app/node_modules/.bin/prisma app \
  migrate diff --from-config-datasource --to-schema /app/prisma/schema.prisma --exit-code \
  >/dev/null 2>"$BACKUP_DIR/schema-diff-$TS.err"
DIFF_RC=$?
case "$DIFF_RC" in
  0)
    ok "空差异：生产库已与新代码的 datamodel 一致（本次无需改库）"
    ;;
  2)
    # 确有差异，这时才去取 SQL 证据；顺手滤掉 dotenvx 横幅，让人工评审看到的是纯 SQL。
    SCHEMA_DIFF_FILE="$BACKUP_DIR/schema-diff-$TS.sql"
    aoc run --rm -T --no-deps --entrypoint /app/node_modules/.bin/prisma app \
      migrate diff --from-config-datasource --to-schema /app/prisma/schema.prisma --script \
      2>/dev/null | grep -vE '^[[:space:]]*[◇◈⌘✔✖]|dotenvx\.com' > "$SCHEMA_DIFF_FILE" || true
    echo ""
    echo -e "${R}━━━ 检测到 SCHEMA 差异 —— 本脚本不会自动改库 ━━━${N}"
    grep -vE '^[[:space:]]*(--.*)?$' "$SCHEMA_DIFF_FILE" | head -40 | sed 's/^/    /'
    echo ""
    echo "  完整 SQL：$SCHEMA_DIFF_FILE"
    echo "  按 docs/deploy/deployment.md §5.5 处理：人工评审这份 SQL → 危险语句停点 →"
    echo "  批准后用 psql -1 执行【同一份文件】→ 再验空差异 → 然后重跑本脚本。"
    echo "  禁止 --accept-data-loss，禁止让 entrypoint 自动 db push。"
    die "存在未审批的 schema 差异，拒绝切换（旧栈仍在正常服务）"
    ;;
  *)
    tail -15 "$BACKUP_DIR/schema-diff-$TS.err" 2>/dev/null | sed 's/^/      /'
    die "prisma migrate diff 执行失败（rc=${DIFF_RC}）。这不代表没差异——是查不出来。\
排除故障后重跑；在证明空差异之前不要启动新 app。"
    ;;
esac

# ── 10. 排空在途事件 ────────────────────────────────────────────────
step "10/12  排空在途 Inngest run（重建 app 前的硬闸门）"
# 共享 Inngest 不能停，且 AO 无法替 RAAS 暂停事件入口 —— 那一步必须人工做。
# 脚本负责：把在途数量摆出来、盯到归零、归零前不许往下走。
inflight_live(){
  # 直连共享 Inngest 的 /v0/gql（在 app 容器里跑，网络视角天然正确）。
  # 输出 "RUNNING=<n> QUEUED=<m> VIA=<timeField>"；查不出来则退出码非 0。
  aoc exec -T app node -e '
const base = (process.env.INNGEST_BASE_URL || "http://localhost:8288").replace(/\/+$/, "");
const from = new Date(Date.now() - '"$DRAIN_WINDOW_HOURS"' * 3600e3).toISOString();
const until = new Date(Date.now() + 300e3).toISOString();
async function q(timeField) {
  const query = "{ runs(first: 500, orderBy: [{ field: STARTED_AT, direction: DESC }], filter: { from: \"" + from + "\", until: \"" + until + "\", timeField: " + timeField + " }) { edges { node { id status function { slug } } } } }";
  const r = await fetch(base + "/v0/gql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const b = await r.json();
  if (b.errors) throw new Error(JSON.stringify(b.errors).slice(0, 300));
  return (b.data && b.data.runs && b.data.runs.edges || []).map((e) => e.node);
}
(async () => {
  let nodes = null, via = "", errs = [];
  for (const tf of ["QUEUED_AT", "STARTED_AT"]) {
    try { nodes = await q(tf); via = tf; break; } catch (e) { errs.push(tf + ": " + e.message); }
  }
  if (!nodes) {
    // 查不出来时必须让运维看见原因，否则一个光秃秃的 UNKNOWN 无法排障。
    console.error("      inngest gql 不可用 — " + errs.join(" / "));
    console.log("UNKNOWN");
    process.exit(3);
  }
  const mine = nodes.filter((n) => (n.function && n.function.slug || "").startsWith("agentic-operator-"));
  const up = (s) => String(s || "").toUpperCase();
  const running = mine.filter((n) => up(n.status) === "RUNNING").length;
  const queued = mine.filter((n) => up(n.status) === "QUEUED").length;
  console.log("RUNNING=" + running + " QUEUED=" + queued + " VIA=" + via);
})().catch((e) => { console.error("      inngest gql 调用异常 — " + e.message); console.log("UNKNOWN"); process.exit(3); });
' | tr -d '\r' | tail -1
}

if (( ASSUME_DRAINED )); then
  warn "--drained：跳过交互确认（操作员声明入口已暂停且 0/0）"
else
  echo "  共享 Inngest 不停机，AO 也无法替 RAAS 暂停事件入口 —— 这一步必须人工先做。"
  confirm "已暂停 RAAS 新事件入口（或已进入维护窗口）？"
fi

DRAIN_DEADLINE=$((SECONDS + DRAIN_TIMEOUT_S))
DRAINED=0
LAST_LINE=""
while (( SECONDS < DRAIN_DEADLINE )); do
  LAST_LINE="$(inflight_live)"
  if [[ "$LAST_LINE" == RUNNING=* ]]; then
    r_n="${LAST_LINE#RUNNING=}"; r_n="${r_n%% *}"
    q_n="${LAST_LINE#*QUEUED=}"; q_n="${q_n%% *}"
    printf "  · %s\n" "$LAST_LINE"
    if [[ "$r_n" == "0" && "$q_n" == "0" ]]; then DRAINED=1; break; fi
  else
    warn "查不到在途数量（共享 Inngest 的 gql 没应答或 schema 不匹配）"
    break
  fi
  sleep "$DRAIN_POLL_S"
done

if (( DRAINED )); then
  ok "in-flight 已归零：$LAST_LINE"
else
  echo ""
  warn "未能自动确认 running=0 且 queued=0（最后一次读数：${LAST_LINE:-无}）"
  echo "  请在 Mac Studio 本机浏览器打开 http://localhost:8288 ，看 $INNGEST_APP_ID 的 running/queued。"
  echo "  queued 在约定窗口内归不了零 → 中止升级、恢复入口，由负责人决定等待/导出重放/另做迁移。"
  if (( ASSUME_DRAINED )); then
    warn "--drained：按操作员声明继续"
  else
    confirm "Inngest UI 上确认 running=0 且 queued=0，继续切换？"
  fi
fi

# ── 11. 切换 + 重注册唯一 callback ──────────────────────────────────
step "11/12  用新镜像重建容器"
# 越过这条线之后，容器可能已经是新镜像了 —— 从这里起失败要给回滚指引。
# 在此之前的任何中止，restore_ao_image 已把 AO_IMAGE 还原，旧栈原封不动。
SHOW_ROLLBACK=1
aoc up -d --wait 2>&1 | tail -8 | sed 's/^/      /'
UP_RC=${PIPESTATUS[0]}
(( UP_RC == 0 )) || die "compose up 失败（rc=${UP_RC}）。看 'aoc logs app'；回滚见下方。"
ok "容器已按新镜像重建"

step "11.5/12  等待 app 健康 + 重注册 Inngest callback"
HEALTH_URL="http://127.0.0.1:${AO_PORT_V}/api/health"
deadline=$((SECONDS + HEALTH_TIMEOUT_S)); HEALTHY=0
while (( SECONDS < deadline )); do
  if curl -sS -o /dev/null --max-time 3 -f "$HEALTH_URL" 2>/dev/null; then HEALTHY=1; break; fi
  sleep 3; printf "."
done
echo ""
if (( HEALTHY == 0 )); then
  aoc logs --tail=40 app 2>&1 | sed 's/^/      /'
  die "app 在 ${HEALTH_TIMEOUT_S}s 内没有健康（${HEALTH_URL}）"
fi
ok "app /api/health（ready，含 Postgres 可查）通过"

# main 镜像不会自动 PUT 注册，必须显式把唯一 callback 切到新容器。
do_register(){ aoc exec -T app /app/node_modules/.bin/tsx /app/scripts/register-with-inngest.ts; }
retry "$REGISTER_RETRIES" "register-with-inngest" do_register \
  || die "注册失败。核对 INNGEST_SERVE_ORIGIN=http://<AO_SHARED_NETWORK_ALIAS>:3002、\
共享网络名、以及 Apps 页是否还残留旧 callback 条目。"
ok "callback 已注册（脚本自身已校验函数数）"

# 唯一 callback 硬校验：同一个 app id 只能有一个条目
APPS_LINE="$(aoc exec -T app node -e '
const base = (process.env.INNGEST_BASE_URL || "http://localhost:8288").replace(/\/+$/, "");
(async () => {
  const r = await fetch(base + "/v0/gql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ apps { name url connected functionCount } }" }),
    signal: AbortSignal.timeout(8000),
  });
  const b = await r.json();
  const apps = (b.data && b.data.apps || []).filter((a) => a.name === "'"$INNGEST_APP_ID"'");
  console.log("COUNT=" + apps.length + " " + apps.map((a) => (a.connected ? "up" : "down") + ":" + a.functionCount + ":" + (a.url || "?")).join(" | "));
})().catch(() => { console.log("COUNT=?"); process.exit(3); });
' 2>/dev/null | tr -d '\r' | tail -1)"
case "$APPS_LINE" in
  "COUNT=1 "*) ok "Inngest Apps: $APPS_LINE" ;;
  "COUNT=0 "*) die "Inngest 上没有 $INNGEST_APP_ID 条目 —— 注册没生效" ;;
  COUNT=\?*)   warn "无法核对 Apps 条目数，请到 Inngest UI 人工确认只有一个 $INNGEST_APP_ID" ;;
  *)
    fail "Inngest Apps: $APPS_LINE"
    warn "同一个 app id 出现多个条目 = 事件会双重执行 + partner PG 双写。"
    warn "立刻到 Inngest UI 删掉指向旧容器 URL 的条目，只留 $(read_env INNGEST_SERVE_ORIGIN)/api/inngest。"
    confirm "已在 Inngest UI 删除多余条目，继续？"
    ;;
esac

# ── 12. 验收 ────────────────────────────────────────────────────────
step "12/12  验收"
ANY_FAIL=0

# 用 `ps -q <service>` + docker inspect 判定，比解析 `ps` 的表格输出稳。
svc_running(){ # svc_running <service>
  local cid
  cid="$(aoc ps -q "$1" 2>/dev/null | head -1)"
  [[ -n "$cid" ]] || return 1
  [[ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" == "true" ]]
}
for s in $EXPECTED_SERVICES; do
  if svc_running "$s"; then ok "$s running"; else fail "$s 未运行"; ANY_FAIL=1; fi
done
if svc_running inngest; then
  fail "compose 里起了 bundled inngest —— 生产必须用共享实例（COMPOSE_PROFILES 应为空）"
  ANY_FAIL=1
else
  ok "未启动 bundled inngest（共享实例模式正确）"
fi

echo "  行数对比（升级前 → 升级后）："
i=0
for t in "${COUNT_TABLES[@]}"; do
  post="$(pg_scalar "select count(*) from $t")"; [[ -n "$post" ]] || post="n/a"
  pre="${PRE_COUNTS[$i]}"
  if [[ "$post" == "$pre" ]]; then printf "    ${G}✓${N} %-28s %s\n" "$t" "$post"
  else                             printf "    ${C}~${N} %-28s %s → %s\n" "$t" "$pre" "$post"; fi
  i=$((i+1))
done

smoke(){ # smoke <expect> <url> <desc>
  local code
  code="$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' "$2" 2>/dev/null || echo 000)"
  if [[ "$code" == "$1" ]]; then printf "  ${G}✓${N} HTTP %s  %s\n" "$code" "$3"
  else printf "  ${R}✗${N} HTTP %s (want %s)  %s\n" "$code" "$1" "$3"; ANY_FAIL=1; fi
}
smoke 200 "$HEALTH_URL"                                               "app /api/health (ready, 含 Postgres 可查)"
smoke 200 "http://127.0.0.1:${AO_PORT_V}/api/inngest-admin/functions" "监控读路径（经共享 Inngest 取函数列表）"

DEP="$(curl -sS --max-time 20 "http://127.0.0.1:${AO_PORT_V}/api/dependency-health" 2>/dev/null | head -c 400)"
[[ -n "$DEP" ]] && echo "  依赖健康（仅供参考，不作为失败判据）：${DEP}"

echo ""
if (( ANY_FAIL )); then
  fail "验收有未通过项"
  print_rollback
  exit 2
fi

echo -e "${G}✅ ALL GREEN${N} — ao-v2 升级 $(git rev-parse --short "$ROLLBACK_HASH") → $NEW_SHORT"
echo "   镜像 $OLD_IMAGE → $NEW_IMAGE"
echo ""
echo "还需要人工做的两件事："
echo "  □ 恢复 RAAS 新事件入口"
echo "  □ 跑一条真实链路验证（容器 healthy ≠ 业务通）：触发一次简历匹配 / JD 生成，"
echo "     确认 RoboHire 两个接口 200：aoc logs --since 15m app | grep -i 'RoboHire\\.'"
echo ""
echo "回滚（只改镜像，不要动 git）："
echo "  sed -i '' 's|^AO_IMAGE=.*|AO_IMAGE=${OLD_IMAGE}|' $ENV_FILE && \\"
echo "    bash scripts/deploy-compose.sh --env-file $ENV_FILE -- up -d --wait && \\"
echo "    bash scripts/deploy-compose.sh --env-file $ENV_FILE -- exec -T app \\"
echo "      /app/node_modules/.bin/tsx /app/scripts/register-with-inngest.ts"
exit 0
