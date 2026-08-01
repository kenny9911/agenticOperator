# Agentic Operator 跨机器部署与运维（Docker 离线包）

本指南覆盖把**当前版本** AO 部署到另一台 Docker 机器的完整流程，并以真实
目标环境为主线：一台**内网 Mac Studio（Apple Silicon，Docker Desktop）**，
机器上已经在跑一套老版本 AO（需原地升级）和完整的 Allmeta 栈。目标机器上
没有开发工具，所有步骤都设计成可通过远程桌面（ToDesk）整段复制粘贴执行。

两台机器的角色约定（下文全程沿用）：

| 角色 | 机器 | 要求 |
| --- | --- | --- |
| **构建机** | 你的开发 Mac（本仓库所在） | 有公网（docker pull / npm registry）、Docker Desktop、能通内网到目标机 |
| **目标机** | Mac Studio（或任意 Docker 主机） | Docker Engine 24+（含 Compose v2）、≥4 CPU、≥8 GiB RAM、≥25 GiB 空闲磁盘；**不需要** Node/npm/git |

> 目标机能直接上公网时可以走更简单的在线流程，见附录 A。主线按
> 「目标机只通内网」的最严格假设写。

## 1. 部署形态与边界

生产默认编排四个 AO 服务；只有隔离环境显式启用 bundled profile 时才出现
第五个 `inngest` 服务。数据全部落在 named volume 里，重建容器不丢监控、
事件、日志和运行记录：

| 服务 | 作用 | 持久化 volume |
| --- | --- | --- |
| `app` | Next.js UI、API、Agent/Inngest 回调（端口 3002） | `<项目名>-logs`（完整 JSONL agent 日志） |
| `ao-postgres` | AO 运营数据、LogEvent、通知、事件/run/step 归档 | `<项目名>-postgres-data` |
| `inngest`（可选） | 事件调度与实时运行（端口 8288/8289，显式 `--persist`） | `<项目名>-inngest-data` |
| `archiver` | Inngest events/runs/steps 补偿归档到 Postgres | 写 `ao-postgres` |
| `monitor-sweeper` | SLA、健康、错误率、成本和保留策略扫描 | 写 `ao-postgres` |

### Inngest 两种模式（部署前必须选定）

架构铁律：**AO 和 RAAS partner 共用同一个 Inngest 实例**（partner 侧的
RESUME_DOWNLOADED 等事件直接进这个实例触发 AO 函数）。因此：

- **模式 S · 共享 Inngest（生产默认、本指南主线）**——机器上已有 AO +
  RAAS 共用的实例。`.env.deploy` 必须是 `DEPLOY_MODE=shared`、
  `COMPOSE_PROFILES=`，并显式填写共享网络、AO callback alias、
  `INNGEST_BASE_URL` 和 `INNGEST_SERVE_ORIGIN`。所有 shared 命令都叠加
  `docker-compose.shared-inngest.yml`；app、archiver、monitor-sweeper 一起
  加入该网络，bundled 服务不会进入 Compose 服务集合。
  **如果错误地自带一套新 Inngest，partner 事件到不了 AO，六函数链路直接
  断掉。**
- **模式 B · 自带 Inngest（全新隔离机器的显式 opt-in）**——必须先在
  `.env.deploy` 明确设置 bundled mode/profile/URL，再使用
  `deploy:bundled:*` 命令；预检不会用 shell override 掩盖文件里的旧值。配置需
  启用 `COMPOSE_PROFILES=bundled-inngest`，并固定容器内 URL 为
  `http://inngest:8288` / `http://app:3002`。它不能携带 shared network/alias，
  也不能叠加 shared overlay。预检对任何混用 fail-closed。

**验收目标**：RAAS-v1 域六个核心 agent 函数注册并能端到端跑通 ——
`createJdAgent` / `resumeParserAgent` / `candidateIdentityAgent` /
`ruleCheckAgent` / `matchResumeAgent` / `interviewInviterAgent`。

它们依赖五个**外部系统**（不由本 compose 提供，凭证向对应所有者索取）：

| 依赖 | 用途 | 不可达时的表现 |
| --- | --- | --- |
| LLM 网关（`AI_BASE_URL`） | rule-check 评估、JD 生成、匹配解释 | 相关 agent 全部失败 |
| Allmeta（`ALLMETA_BASE_URL`） | Neo4j 唯一 HTTP 入口：实体写入 + 规则拉取 | 实体写入步骤报错；规则回退内置快照 |
| RoboHire（`ROBOHIRE_API_BASE_URL`，**公网**） | 简历解析 + 匹配评分 | resumeParser/matchResume 失败，下游全停 |
| RAAS partner Postgres（`RAAS_POSTGRES_URL`） | 候选人/岗位/匹配结果业务双写（七张表由 RAAS 方建） | 双写步骤失败 |
| MinIO（`MINIO_ENDPOINT`） | 简历 PDF 二进制存取 | RESUME_DOWNLOADED 卡在 parser |

## 2. 第 0 步：勘察目标机现状（一次性）

在目标机的终端里整段粘贴运行勘察脚本（只读、密钥自动脱敏，报告同时存到
`~/ao-deploy-survey.txt`）：

```bash
bash scripts/survey-old-deployment.sh          # 在仓库里时
# 或把 scripts/survey-old-deployment.sh 的内容整段粘贴进目标机终端
```

对着报告确认五件事，后面步骤都会用到：

1. **架构**：`uname -m` 输出 `arm64` → 打包时用 `--arch arm64`（Apple
   Silicon / 国产 ARM）；`x86_64` → `--arch amd64`。
2. **老部署形态**：老 AO 容器名、compose 项目名、占了哪些端口（通常是
   3002）、env 指向哪套 MinIO/Postgres；勘察报告还会输出 AO PostgreSQL
   的实际 image、server major、`data_directory` 和物理 volume 名。不要按
   compose 文件猜生产事实。
3. **共享 Inngest 事实**（决定第 1 节的模式）：`docker ps` 里有没有
   `raas-inngest` 之类的共享事件引擎；共享网络真名和 Inngest 容器名都以
   `docker inspect` 为准，分别写入 `RAAS_SHARED_NETWORK` 与
   `INNGEST_BASE_URL`，没有默认猜测。
4. **端口空位**：3002/8288/8289/5433 是否被占；被占则停老服务或在
   `.env.deploy` 里改 `AO_PORT`/`INNGEST_PORT`/`AO_POSTGRES_PORT`
   （注意老 AO 自己的 ao-postgres 常占 5433/5434）。
5. **外部依赖连通性**：五个依赖里"✗"的项，部署前先解决网络（尤其
   RoboHire 是公网域名，内网机器要确认出网口子）。

## 3. 阶段一 · 把代码/镜像弄到目标机（两条路径）

**路径 A · 在线（目标机能访问 GitHub/DockerHub/npm 时的首选）**：
构建机把代码快照 commit + push 到远端仓库，目标机直接 clone 并在本地
构建——不需要离线包：

```bash
# 目标机上:
git clone -b <部署分支> <仓库URL> ao-v2 && cd ao-v2
cp .env.deploy.example .env.deploy    # 按 5.3 表填写
# 只构建 AO 镜像，不直接启动整栈；随后完整执行 5.1、5.3–5.6。
bash scripts/deploy-compose.sh --env-file .env.deploy -- build app
```

首次构建在目标机上完成（M 系列 Mac 约 15–25 分钟，需要拉 node/postgres
基础镜像和 npm 包）。此后升级也不是直接 `up`：`git pull` 后先备份、构建，
再按 5.5 审查/执行同一份 schema SQL，最后才 `up -d --wait`。

**路径 B · 离线 bundle（目标机拉不了公网资源时的兜底）**——以下小节即
此路径：构建机产出离线包，目标机 `docker load` 后不带 `--build` 启动。

前置：Docker Desktop 在跑；当前工作区就是要部署的代码状态（`docker build`
用的是工作区文件，与 git 提交状态无关，但**建议先提交并推送存档**，保证
部署内容可追溯）。

一条命令完成 构建镜像 → 拉基础镜像 → 打包：

```bash
# Mac Studio (10.100.0.70) 生产的实际命令:
scripts/make-deploy-bundle.sh \
  --public-origin  http://10.100.0.70:3002 \
  --inngest-origin http://localhost:8288 \
  --mode shared \
  --shared-network raas-deploy-next_default \
  --shared-inngest-url http://raas-inngest:8288 \
  --callback-alias ao-v2-app \
  --arch arm64
```

两个 origin 填**操作员浏览器真正能访问的地址**：AO 发布在 `0.0.0.0:3002`
→ 用 LAN IP；而这台机器的共享 `inngest-server` 只绑 `127.0.0.1:8288` →
dashboard 只能在 Mac Studio 本机浏览器（ToDesk）打开，所以用 `localhost`。
（将来若把 inngest-server 改绑 `0.0.0.0`，重新打包换成 LAN IP 即可。）
它们是 Next.js build-time 值（`NEXT_PUBLIC_*`），烤进浏览器 bundle——将来
IP 换了必须重新打包，改 env 重启不生效。

产物：`ao-deploy-bundle-<tag>-<arch>.tar`（约 2–4 GB），内含：

```
images.tar.gz        # shared 默认两个镜像：agentic-operator + postgres
docker-compose.deploy.yml
docker-compose.shared-inngest.yml
docker-compose.reuse-postgres-volume.yml  # 高风险旧卷直挂，仅显式 opt-in
.env.deploy.draft    # 镜像 tag、公开地址已预填，只剩密钥/端点要改
IMAGES.env           # 本包镜像清单（记录用）
README-TARGET.md     # 目标机快速步骤（本节的精简版）
scripts/             # deploy-compose.sh · deploy-preflight.mjs · connectivity/survey scripts
```

参考数字（2026-07-16 在 Apple Silicon 构建机实测）：AO 镜像约 **2.1 GB**；
冷缓存构建 30–40 分钟（npm 全量拉包，网络抖动会自动重试），热缓存约
10 分钟。交叉构建（`--arch` 与构建机不同）走 QEMU 模拟，预期慢 3–5 倍。
shared 默认不携带 Inngest 镜像；只有 `--mode bundled` 才额外拉取并打包它。
镜像构建成功不等于生产验收；目标机仍须逐项完成第 6 节的四容器健康、数据库、
唯一 callback、6/6 函数和端到端事件证据。

两个常见构建失败及自救：`next build` 阶段报 TS 错误 = 工作区有改到一半
的代码（构建用的是工作区快照），改完重跑；`npm ci` 阶段网络重置 = 直接
重跑（缓存续传，且已配自动重试）。

## 4. 阶段二 · 传输

LAN 内首选 scp（目标机 macOS 先开启 系统设置 → 通用 → 共享 → 远程登录）：

```bash
scp ao-deploy-bundle-*.tar <用户名>@<目标机IP>:~/
```

没有 SSH 时用 ToDesk 的文件传输功能拖过去（几 GB 会比较慢）。然后在目标
机解压：

```bash
mkdir -p ~/ao-deploy && tar xf ~/ao-deploy-bundle-*.tar -C ~/ao-deploy && cd ~/ao-deploy
```

## 5. 阶段三 · 目标机：安装（原地升级）

以下全部在目标机 `~/ao-deploy` 目录执行。

### 5.1 保留老版本并做第一份只读备份

> ⚠️ 老部署的 compose 项目名如果恰好也叫 `agentic-operator`（勘察第 2 项
> 可见），**新部署必须换一个项目名**（下面 5.3 里设
> `COMPOSE_PROJECT_NAME=ao-v2`）。同名会让 compose 把老容器当本项目的
> 孤儿，`up` 时有被误删的风险。

默认策略是**迁移 AO PostgreSQL 历史数据到新卷，同时保持旧卷完全不动**。
此阶段老服务继续运行，只做 PostgreSQL 一致性逻辑备份：

```bash
mkdir -p backups

# 容器名、用户和数据库均以勘察输出为准。命令在旧容器内部读取已有 env，
# 不会把数据库密码打印到终端。
docker exec ao-postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "backups/steven-ao-precutover-$(date +%Y%m%d-%H%M%S).dump"

PRE_DUMP=$(ls -t backups/steven-ao-precutover-*.dump | head -1)
test -n "$PRE_DUMP" && test -s "$PRE_DUMP"
docker exec ao-postgres sh -c \
  'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "select '\''WorkflowRun'\'',count(*) from \"WorkflowRun\" union all
   select '\''RuleCheckAudit'\'',count(*) from \"RuleCheckAudit\" union all
   select '\''InngestRunArchive'\'',count(*) from inngest_run_archive;"' \
  > backups/steven-row-counts.txt
```

个别表在老 schema 不存在时，按真实表名调整计数 SQL，但至少记录三类事实：
核心运行记录、规则审计、Inngest 归档。此时**不要停、不要删**旧 app、旧
`ao-postgres` 或 `ao-postgres_ao-pgdata`。

共享模式下任何阶段都不要停 `raas-inngest`、RAAS 的业务 `postgres`、MinIO、
Allmeta。共享 Inngest 是切换窗口承接在途/新事件的唯一事件平面。

### 5.2 导入镜像

```bash
docker load -i images.tar.gz
docker images | grep -E 'agentic-operator|postgres|inngest'   # shared 包至少看到 AO + Postgres
```

### 5.3 填写 .env.deploy

```bash
cp .env.deploy.draft .env.deploy
vi .env.deploy        # 或 open -e .env.deploy 用文本编辑打开
```

镜像 tag 和两个公开地址已预填。剩下的变量按下表逐个替换（所有
`replace-*` 占位必须消灭，否则预检不过）。「老 env」指老部署仓库里的
`.env.production`——大部分外部凭证直接沿用它的值：

| 变量 | Mac Studio（10.100.0.70）填什么 | 说明 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `ao-v2` | 与老部署隔离（见 5.1 警告） |
| `DEPLOY_MODE` | `shared` | 生产默认；预检拒绝 shared/bundled 混用 |
| `COMPOSE_PROFILES` | 置空（`COMPOSE_PROFILES=`） | shared 模式服务集合里不能出现 bundled Inngest |
| `RAAS_SHARED_NETWORK` | 勘察得到的真实外部网络名 | 无默认值；app、archiver、monitor-sweeper 都加入此网络 |
| `AO_SHARED_NETWORK_ALIAS` | `ao-v2-app` | DNS-safe 单标签；必须与下一行 URL hostname 完全相同 |
| `INNGEST_BASE_URL` | `http://raas-inngest:8288`（容器名以勘察为准） | 必须指既有共享实例，不能写本项目的 `inngest` |
| `INNGEST_SERVE_ORIGIN` | `http://ao-v2-app:3002` | 共享 Inngest 反向回调 AO；hostname 必须等于 alias，端口固定 3002 |
| `AO_POSTGRES_PORT` | `5436` | 宿主 5433 已被占用、5434 是老 ao-postgres、5435 是 allmeta 的——避开 |
| `AO_POSTGRES_VOLUME_MODE` | `new` | 默认创建 `ao-v2-postgres-data`；不直挂唯一生产卷 |
| `DATABASE_SCHEMA_SYNC` | `0` | shared 生产预检强制为 0；只执行审查后固定的 SQL 文件 |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | 沿用老 env §9 的两个随机值 | 生产拒绝字面量 `dev` |
| `AO_POSTGRES_USER` / `AO_POSTGRES_DB` | 建议保持 `ao` / `ao` | 新卷初始化口径；restore 使用 `--no-owner` |
| `AO_POSTGRES_PASSWORD` | 新卷生成长随机串 | `openssl rand -hex 24`；同步 URL 编码到 `DATABASE_URL` |
| `DATABASE_URL` | 把密码同步进去，host 保持 `ao-postgres:5432` | **新栈自己的** Postgres 服务名。故意不叫 `postgres`——共享网络上已有同名容器（new-api 的库），同名别名会让 DNS 二义、写错库 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 沿用老 env §3（`https://new-api.jointpilot.com/v1` + key + `kimi-k2.6`） | 或换成内网网关 `http://host.docker.internal:3010/v1`，二选一 |
| `ALLMETA_BASE_URL` | `http://host.docker.internal:3500` | Allmeta 栈在目标机本机 Docker 里 |
| `ALLMETA_API_KEY` | 沿用老 env §6 的 `oskey_*` | 与 Allmeta Studio 一致 |
| `ALLMETA_DOMAIN` | `RAAS-v1` | 六函数验收用这个域 |
| `ROBOHIRE_API_BASE_URL` | `https://api.gohire.top` | **不带 /v1**（client 自己拼 `/api/v1`） |
| `ROBOHIRE_API_KEY` | 沿用老 env §4 的 `rh_*` | |
| `ROBOHIRE_TIMEOUT_MS` | `300000` | ⚠ 老 env 是 120000——那是坑：match 实测 ~195s 会被杀，必须用 300000 |
| `RAAS_POSTGRES_URL` | 沿用老 env §5a：`postgresql://postgres:<密码URL编码>@postgres:5432/raas` | `postgres` 容器**未发布宿主端口**，必须靠 shared overlay 按容器名访问（网络名见上行 `RAAS_SHARED_NETWORK`）；库名 `raas`；密码含 `@` 写成 `%40` |
| `RAAS_DEFAULT_EMPLOYEE_ID` | `0000199059`（老 env §5b） | 匹配结果归属兜底 |
| `MINIO_ENDPOINT` / `MINIO_PORT` | `host.docker.internal` / `9000` | 共享 MinIO 在目标机本机；endpoint 不带 scheme |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | 沿用老 env §8 | |
| `AGENT_EXECUTION_API_KEY` | 长随机串（老 env 没有，是新版本新增） | 保护对外管理/执行 API；正常部署不启用 factory，故不要求 factory token |

安全闸门保持模板默认，不要动：`STUB_AGENTS=0`、`RULE_CHECK_BYPASS=false`、
`AO_ENABLE_UNSAFE_DEV_ROUTES=0`、`RAAS_BRIDGE_ENABLED=0`。

**Agent 工厂不在部署范围内。** 工厂（生成 agent 的大脑 + 它的 UI）已经迁到独立
的 monorepo，这套部署**不提供**它：模板里 `FACTORY_ENABLED=0`、镜像用
`NEXT_PUBLIC_FACTORY_ENABLED=0` 构建，于是工厂页面和所有 `/api/factory-*`
路由一律 404，左侧导航也不出现入口；`skills-library` / `tools-library` 两个
volume 一并取消。因此**不需要**准备 `FACTORY_ADMIN_TOKEN`（预检只有在
`FACTORY_ENABLED=1` 时才要求它）。

这个开关**只关工厂自己的 HTTP 界面**，不碰任何运行链路 —— agent 注册上线
Inngest、事件触发、agent 运行、监控、告警、通知、rule-check、以及已部署 agent
的执行器全部照常工作。真要把工厂放回来：`FACTORY_ENABLED=1` + 用
`NEXT_PUBLIC_FACTORY_ENABLED=1` 重新构建镜像 + 配 `FACTORY_ADMIN_TOKEN`。

手机号身份语义不是部署开关：当前代码固定使用已确认的 11 位手机号归一/匹配
口径，部署时不得通过旧 `DEDUP_PHONE_PRIMARY` 或
`CANDIDATE_IDENTITY_ENABLED` 变量改变它。老 env 若仍有这两个键，迁移时删除；
不要把历史灰度开关复制进 `.env.deploy`。

### 5.4 连通自检 + 配置预检

```bash
# ① 五个外部依赖从这台机器是否可达（网络问题在起容器前暴露）
bash scripts/check-connectivity.sh --env-file .env.deploy

# ② 配置静态校验（借 AO 镜像里的 node 跑，目标机不用装 Node）
docker run --rm --entrypoint node -v "$PWD:/kit" -w /kit \
  "$(grep '^AO_IMAGE=' IMAGES.env | cut -d= -f2)" \
  scripts/deploy-preflight.mjs --env-file .env.deploy
```

两个都通过（`[deploy-check] OK`）再继续；报错信息会指出具体哪个变量有问题。
之后所有 Compose 操作都必须经过 `scripts/deploy-compose.sh`。它把
`.env.deploy` 作为唯一配置源，自动选择 shared/bundled 与 new/external overlay，
并清除宿主 shell 中可能覆盖项目名、卷、schema 和 Inngest 拓扑的同名变量。
不要把本指南中的包装命令改回裸 `docker compose --env-file`。

### 5.5 旧库只读 dump → 新卷 restore → 显式 schema 演练

本节只操作新卷 `ao-v2-postgres-data`。旧容器和旧卷仍在线、未修改，可随时
回滚。先只启动新 Postgres：

```bash
# 第一次演练必须证明目标卷尚不存在。若命中，先核实它是否是本迁移此前创建的
# ao-v2 演练卷；来源不明时立即 STOP，不能让 Compose 静默复用。
NEW_AO_PROJECT=$(sed -En \
  's/^[[:space:]]*(export[[:space:]]+)?COMPOSE_PROJECT_NAME[[:space:]]*=[[:space:]]*(.*)$/\2/p' \
  .env.deploy | tail -n 1 | tr -d "\"'" | xargs)
NEW_AO_VOLUME="${NEW_AO_PROJECT}-postgres-data"
test -n "$NEW_AO_PROJECT"
test -n "$NEW_AO_VOLUME"
if docker volume inspect "$NEW_AO_VOLUME" >/dev/null 2>&1; then
  echo "STOP: target volume already exists: $NEW_AO_VOLUME" >&2
  exit 1
fi

bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  up -d --wait ao-postgres

# 取 5.1 最新备份；先验证归档可读，再恢复到新卷。
DUMP=$(ls -t backups/steven-ao-precutover-*.dump | head -1)
test -n "$DUMP" && test -s "$DUMP"
docker run --rm -v "$PWD/backups:/backup:ro" \
  "$(grep '^POSTGRES_IMAGE=' IMAGES.env | cut -d= -f2)" \
  pg_restore --list "/backup/$(basename "$DUMP")" >/dev/null

bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T ao-postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
    --no-owner --no-privileges --exit-on-error' < "$DUMP"

# restore 后、schema 变更前，核对核心历史行数。
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T ao-postgres sh -c \
  'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "select '\''WorkflowRun'\'',count(*) from \"WorkflowRun\" union all
   select '\''RuleCheckAudit'\'',count(*) from \"RuleCheckAudit\" union all
   select '\''InngestRunArchive'\'',count(*) from inngest_run_archive;"' \
  | tee backups/ao-v2-row-counts-before-schema.txt
diff -u backups/steven-row-counts.txt backups/ao-v2-row-counts-before-schema.txt || {
  echo "STOP: restored row counts differ from Steven" >&2
  exit 1
}
```

`diff` 必须无业务行数差异才继续。先用镜像内的 Prisma 7 对**新卷当前 schema**
与 main datamodel 做只读 diff，并把完整 SQL 留档。Prisma 7 不再支持旧的
`--from-url` 参数；这里使用当前 CLI 已确认支持的
`--from-config-datasource`：

```bash
SCHEMA_DIFF="backups/main-schema-diff-$(date +%Y%m%d-%H%M%S).sql"
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  run --rm -T --entrypoint /app/node_modules/.bin/prisma app \
  migrate diff --from-config-datasource \
    --to-schema /app/prisma/schema.prisma --script > "$SCHEMA_DIFF"
test -s "$SCHEMA_DIFF"
sed -n '1,240p' "$SCHEMA_DIFF"

# 任一命中都是强制停点：不要执行任何 schema SQL，先设计并评审显式 migration。
if grep -Ein '(^|[^[:alnum:]_])(DROP|RENAME|TRUNCATE|INSERT|UPDATE|DELETE)([^[:alnum:]_]|$)|ALTER[[:space:]].*TYPE' "$SCHEMA_DIFF"; then
  echo "STOP: schema diff contains destructive/transforming SQL" >&2
  exit 1
fi
```

由负责人逐行确认 SQL 只有预期的 additive `CREATE` / 安全 `ALTER` 后，把已批
版本保存为固定文件。生产 apply **只把这一份已审文件**喂给新卷 PostgreSQL；
不另跑会重新计算变更的 `prisma db push`，因此审查对象与执行对象完全相同。
`psql -1` 把整份 DDL 放在单事务里，任一语句失败即整体回滚：

```bash
cp "$SCHEMA_DIFF" backups/main-schema-diff-approved.sql
shasum -a 256 backups/main-schema-diff-approved.sql \
  | tee backups/main-schema-diff-approved.sha256
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T ao-postgres sh -c \
  'psql -X -v ON_ERROR_STOP=1 -1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < backups/main-schema-diff-approved.sql || {
  echo "STOP: approved schema SQL rolled back" >&2
  exit 1
}

# 退出码必须为 0（空差异）；Prisma 的 2 表示仍有差异，不能继续。
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  run --rm -T --entrypoint /app/node_modules/.bin/prisma app \
  migrate diff --from-config-datasource \
    --to-schema /app/prisma/schema.prisma --exit-code || {
  echo "STOP: schema is not identical to the main datamodel" >&2
  exit 1
}

# 保存 schema 后计数；旧业务三表行数仍须相同，同时应出现 main 新表。
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T ao-postgres sh -c \
  'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "select '\''WorkflowRun'\'',count(*) from \"WorkflowRun\" union all
   select '\''RuleCheckAudit'\'',count(*) from \"RuleCheckAudit\" union all
   select '\''InngestRunArchive'\'',count(*) from inngest_run_archive;
   select to_regclass('\''notification'\''),to_regclass('\''log_event'\''),to_regclass('\''domain'\'');"' \
  | tee backups/ao-v2-row-counts-after-schema.txt
```

保持 `.env.deploy` 中 `DATABASE_SCHEMA_SYNC=0`：生产 web 启动不再偷偷改库；
以后每次升级都先备份、生成并审查 SQL，只事务执行该批准文件，再验证空差异。

### 5.6 切换、排空在途事件并启动

共享 Inngest 不能停。正式切换前先暂停 RAAS 新事件入口（或进入维护窗口），
在 Inngest UI 记录 `agentic-operator-main` 的 running/queued 数；只有
**running=0 且 queued=0** 才能停 Steven AO。queued 若在约定窗口内无法归零，
立即中止切换并恢复入口，由负责人决定继续等待、导出重放还是另做迁移；不能让
未解释的 queued run 在 callback 切换后直接落到 main。两个计数都归零后再执行
短暂停写窗口：

```bash
# 1. 停旧 AO 的接单/归档进程；旧 PostgreSQL 暂时保持运行以做最终 dump。
docker stop ao-main
# 若旧 archiver 是独立容器，也在此停止；名字以勘察报告为准。

# 2. 最终一致性 dump。停旧 app 后不再有 AO 写入。
FINAL_DUMP="backups/steven-ao-final-$(date +%Y%m%d-%H%M%S).dump"
docker exec ao-postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$FINAL_DUMP"
test -s "$FINAL_DUMP"
docker exec ao-postgres sh -c \
  'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "select '\''WorkflowRun'\'',count(*) from \"WorkflowRun\" union all
   select '\''RuleCheckAudit'\'',count(*) from \"RuleCheckAudit\" union all
   select '\''InngestRunArchive'\'',count(*) from inngest_run_archive;"' \
  > backups/steven-row-counts-final.txt

# 3. 5.5 的演练曾给新库增加 main 对象。只重放 --clean dump 不会删除 dump
#    里不存在的新对象，因此这里明确重建的仅是 ao-v2 新卷里的数据库；旧卷不动。
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T ao-postgres sh -c \
  'dropdb --if-exists --force --maintenance-db=postgres \
     -U "$POSTGRES_USER" "$POSTGRES_DB" && \
   createdb --maintenance-db=postgres -U "$POSTGRES_USER" "$POSTGRES_DB"'
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T ao-postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --no-owner --no-privileges --exit-on-error' < "$FINAL_DUMP"

# 最终业务计数必须与已经停写的 Steven 完全一致。
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T ao-postgres sh -c \
  'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "select '\''WorkflowRun'\'',count(*) from \"WorkflowRun\" union all
   select '\''RuleCheckAudit'\'',count(*) from \"RuleCheckAudit\" union all
   select '\''InngestRunArchive'\'',count(*) from inngest_run_archive;"' \
  | tee backups/ao-v2-row-counts-final.txt
diff -u backups/steven-row-counts-final.txt backups/ao-v2-row-counts-final.txt || {
  echo "STOP: final restored row counts differ from stopped Steven" >&2
  exit 1
}

# 最终 restore 后重新生成 SQL，并要求与 5.5 已人工批准的 diff 完全一致。
FINAL_SCHEMA_DIFF="backups/main-schema-diff-final-$(date +%Y%m%d-%H%M%S).sql"
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  run --rm -T --entrypoint /app/node_modules/.bin/prisma app \
  migrate diff --from-config-datasource \
    --to-schema /app/prisma/schema.prisma --script > "$FINAL_SCHEMA_DIFF"
test -s "$FINAL_SCHEMA_DIFF"
test -s backups/main-schema-diff-approved.sql
shasum -a 256 -c backups/main-schema-diff-approved.sha256
cmp -s backups/main-schema-diff-approved.sql "$FINAL_SCHEMA_DIFF" || {
  echo "STOP: final schema diff differs from the approved rehearsal" >&2
  diff -u backups/main-schema-diff-approved.sql "$FINAL_SCHEMA_DIFF" || true
  exit 1
}
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T ao-postgres sh -c \
  'psql -X -v ON_ERROR_STOP=1 -1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < backups/main-schema-diff-approved.sql || {
  echo "STOP: approved schema SQL rolled back during final apply" >&2
  exit 1
}
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  run --rm -T --entrypoint /app/node_modules/.bin/prisma app \
  migrate diff --from-config-datasource \
    --to-schema /app/prisma/schema.prisma --exit-code || {
  echo "STOP: final schema is not identical to the main datamodel" >&2
  exit 1
}

```

此时**不要启动 app、不要注册 callback、不要恢复 RAAS 事件入口**。Steven 的
历史 `mobile_normalized` 可能仍是 `86138...` 等旧格式，而 main 只查规范 11
位值；若先接流量，同一手机号会在回填完成前被误建成两个 Candidate。现在必须
完成 5.7 的 partner candidate dry-run、人工冲突治理和受控 apply。最终闸门报告
必须存在且下面三项计数都为 0：

```bash
test -s backups/candidate-mobile-backfill-post-apply.txt
grep -q '"conflict_groups": 0' backups/candidate-mobile-backfill-post-apply.txt
grep -q '"manual_review_rows": 0' backups/candidate-mobile-backfill-post-apply.txt
grep -q '"rows_requiring_change": 0' backups/candidate-mobile-backfill-post-apply.txt

# 5. 上述 partner 手机闸门通过后，才启动 shared 默认四服务；这里绝不出现 bundled inngest。
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  up -d --wait
```

main 镜像不像 Steven 旧 entrypoint 那样后台自动 PUT 注册。新 app healthy 后
必须主动把同一个 app id 的 callback 唯一切到新 alias：

```bash
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  exec -T app /app/node_modules/.bin/tsx /app/scripts/register-with-inngest.ts
```

在 Inngest UI 确认 `agentic-operator-main` 只有一个有效 callback，指向
`http://ao-v2-app:3002/api/inngest`，6/6 函数正常；再恢复 RAAS 新事件入口，
观察 queued 归零且没有重复 run。

隔离机器的模式 B 不是默认入口。只有明确需要时才把 `.env.deploy` 改成 bundled
专用变量（`DEPLOY_MODE=bundled`、`COMPOSE_PROFILES=bundled-inngest`、清空两个
shared network 值，并使用固定的容器内 Inngest URL）。仓库环境用
`npm run deploy:bundled:up`，离线目标机等价命令为：

```bash
bash scripts/deploy-compose.sh --env-file .env.deploy -- up -d --wait
```

注意**没有 `--build`**：目标机全部使用已导入的镜像。`--wait` 会等健康检查
通过；schema 已在前一步显式完成，web entrypoint 因
`DATABASE_SCHEMA_SYNC=0` 不再自动变更数据库。

macOS 目标机的两项系统设置（Docker 主机长期运行的前提）：

- Docker Desktop → Settings → General → 勾选 **Start Docker Desktop when
  you sign in**（`restart: unless-stopped` 只在 Docker 本身活着时有效）；
- 系统设置 → 能源：关闭睡眠（防止整机挂起后容器全停）。

### 5.7 独立闸门：RAAS partner candidate 手机号回填

这不是 AO 新卷迁移，但它是 5.6 中**注册 main callback、恢复事件入口之前的硬
闸门**。脚本改的是
`RAAS_POSTGRES_URL` 指向的 partner `candidate` 表；默认只读 dry-run，可先独立
执行并保存报告：

```bash
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  run --rm -T --no-deps --entrypoint /app/node_modules/.bin/tsx app \
  /app/scripts/backfill-candidate-mainland-mobile.ts \
  | tee backups/candidate-mobile-backfill-dry-run.txt
grep -q '"mode": "dry-run"' backups/candidate-mobile-backfill-dry-run.txt
```

dry-run 不写任何行。需要 apply 时另开维护窗口，并且四个条件缺一不可：

1. RAAS 数据所有者先暂停**所有 AO + RAAS candidate writers**（上传、解析、
   identity、双写/同步 worker 都包括），并提供“已无写入”的运行证据；只停 AO
   app 不够。
2. 停写后备份 partner 库，而不是 AO `ao-v2-postgres-data`。下面容器名/用户/
   库名与本指南现网示例一致，实际仍以勘察事实为准：

```bash
PARTNER_DUMP="backups/raas-partner-pre-mobile-backfill-$(date +%Y%m%d-%H%M%S).dump"
docker exec postgres pg_dump -U postgres -d raas -Fc > "$PARTNER_DUMP"
test -s "$PARTNER_DUMP"
```

3. 在 writers 全停状态再次运行上面的 dry-run；只有报告明确
   `"conflict_groups": 0` 且 `"manual_review_rows": 0` 才允许继续。任何冲突都
   先由业务负责人制定 candidate merge/保留方案；无效、国际、多号、占位或
   两列冲突的历史值必须先核对 Resume 原始解析证据并人工处置。脚本不会猜测
   合并，也不会把这些可能是唯一副本的联系方式自动清空。
4. 使用不可省略的显式 confirm token 执行，并在完成后再次 dry-run，要求
   `rows_requiring_change=0`、`conflict_groups=0`，再恢复 writers：

```bash
grep -q '"conflict_groups": 0' backups/candidate-mobile-backfill-dry-run.txt
grep -q '"manual_review_rows": 0' backups/candidate-mobile-backfill-dry-run.txt
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  run --rm -T --no-deps --entrypoint /app/node_modules/.bin/tsx app \
  /app/scripts/backfill-candidate-mainland-mobile.ts \
  --apply --confirm=BACKFILL_CANDIDATE_MAINLAND_MOBILE

bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  run --rm -T --no-deps --entrypoint /app/node_modules/.bin/tsx app \
  /app/scripts/backfill-candidate-mainland-mobile.ts \
  | tee backups/candidate-mobile-backfill-post-apply.txt
grep -q '"rows_requiring_change": 0' backups/candidate-mobile-backfill-post-apply.txt
grep -q '"conflict_groups": 0' backups/candidate-mobile-backfill-post-apply.txt
grep -q '"manual_review_rows": 0' backups/candidate-mobile-backfill-post-apply.txt
```

apply 事务还会取得 `candidate` 表的 `SHARE ROW EXCLUSIVE` 锁；任何未按要求
暂停的普通 INSERT/UPDATE/DELETE writer 都会被数据库阻断，锁在 30 秒内拿不到
则脚本失败并回滚。这个数据库护栏不能替代停写与备份，但能防止漏停进程悄悄
穿过回填窗口。

脚本不会建立 partner-wide `UNIQUE` index。即使回填成功，也只证明当前快照无
冲突；跨 AO/RAAS 多写入方的并发唯一性仍需双方共同完成 schema 约束、写路径
和上线顺序治理。此门未完成前，不能宣称“系统级手机号并发唯一”已经成立。
最终 dry-run 三项均为 0 后，返回 5.6 第 5 步启动服务、注册唯一 callback，再
恢复 RAAS 事件入口。

## 6. 阶段四 · 验收

逐层验证，每层通过再看下一层：

```bash
# ① shared 默认四个 AO 容器 running/healthy，且服务列表没有 inngest
bash scripts/deploy-compose.sh --env-file .env.deploy -- ps
bash scripts/deploy-compose.sh --env-file .env.deploy -- config --services
# 期望恰为：ao-postgres / app / archiver / monitor-sweeper

# ② AO 自身健康
curl -fsS "http://localhost:3002/api/health?check=live"
curl -fsS "http://localhost:3002/api/health?check=ready"   # 应含 ruleAuditSchema=ok

# ③ Inngest 健康
curl -fsS "http://localhost:8288/health"
```

**④ 六函数注册**：在目标机本机浏览器打开 `http://localhost:8288`
（Mac Studio 的共享 `inngest-server` 只绑 loopback，须在本机/ToDesk 里开）
→ Apps → 应看到 `agentic-operator-main` 同步无错误，函数列表包含六个核心
agent（createJd / resumeParser / candidateIdentity / ruleCheck /
matchResume / interviewInviter）。
共享模式升级后，老容器注册的旧条目（URL 指向老容器名）会变成
unreachable——确认新 callback 已按 5.6 显式注册后，再删除指向旧容器的条目。
函数缺失或 app unreachable，见第 10 节排查表首条。

**⑤ 端到端测试事件**：测试路由在生产默认关闭，验收时临时开一个窗口：

```bash
# 临时打开测试路由并重启 app（只影响 app 容器）
sed -i '' 's/^AO_ENABLE_UNSAFE_DEV_ROUTES=0/AO_ENABLE_UNSAFE_DEV_ROUTES=1/' .env.deploy
bash scripts/deploy-compose.sh --env-file .env.deploy -- up -d app

# 触发一条隔离的岗位需求事件 → createJdAgent 应真实跑起来
curl -X POST "http://localhost:3002/api/test/trigger-requirement"

# 在 http://<目标机IP>:8288 的 Runs 里看到 run 完成；
# 在 AO /monitor 页看到对应记录；等一个归档周期(默认30s)后 /events 可回读

# 验收完立刻关回去
sed -i '' 's/^AO_ENABLE_UNSAFE_DEV_ROUTES=1/AO_ENABLE_UNSAFE_DEV_ROUTES=0/' .env.deploy
bash scripts/deploy-compose.sh --env-file .env.deploy -- up -d app
```

**⑥ 持久化**：`docker compose ... restart` 后，第⑤步产生的监控/审计记录
仍能在页面查到。

`/api/health?check=ready` 只验证 Web + AO Postgres（避免 app 与 Inngest
互等成环）；Allmeta/RAAS/MinIO 等深度状态看 `/api/system/config` 与
`/api/dependency-health`。

## 7. 日常操作（目标机）

目标机没有 npm，直接用随离线包提供的 Compose 包装脚本（在
`~/ao-deploy` 下执行）：

```bash
# 从 .env.deploy 自动选择安全且一致的 Compose 文件组合。
aoc() { bash scripts/deploy-compose.sh --env-file .env.deploy -- "$@"; }
aoc ps                      # 状态
aoc logs -f --tail=200      # 全部日志
aoc logs -f app             # 单服务日志（app / archiver / monitor-sweeper / ao-postgres）
aoc restart app             # 重启单服务
aoc down                    # 停止并删容器，named volume 全保留
```

**不要**使用 `down -v`，除非明确要永久清除所有 AO 数据。容器 stdout 适合
运维排错；完整 agent JSONL 在 `<项目名>-logs` volume；Postgres `LogEvent`
是统一检索的主要持久化面。保留策略默认全部永久
（`*_RETENTION_DAYS=0`），只有显式调大才会清理历史。

## 8. 备份、恢复和迁机

至少每日备份 AO Postgres（在线执行，不停服）：

```bash
mkdir -p backups
aoc exec -T ao-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "backups/ao-$(date +%Y%m%d-%H%M%S).dump"
```

JSONL 日志冷备（短暂停写保证文件一致；volume 名前缀按你的
`COMPOSE_PROJECT_NAME`，下例为 `ao-v2`）：

```bash
aoc stop archiver app monitor-sweeper
docker run --rm -v ao-v2-logs:/source:ro -v "$PWD/backups:/backup" \
  "$(grep '^POSTGRES_IMAGE=' IMAGES.env | cut -d= -f2)" \
  tar czf /backup/ao-logs.tgz -C /source .
aoc start
```

（离线机器上没有 alpine 镜像，上面借 postgres 镜像自带的 tar 完成打包。）

shared Inngest 的实时库不属于 AO compose，不能用 `aoc down -v` 或 AO 脚本
备份；由共享平台所有者按其 PostgreSQL/Redis 持久化方案备份。AO Postgres 的
Inngest archive 表是已经归档历史的权威副本。

迁机：新机器先创建同名空 volume 并解入两个 tar 包，启动 `ao-postgres`
后用 `pg_restore --clean --if-exists` 恢复 dump，再起整套 compose。Postgres
归档是监控历史的权威副本——即使不迁 Inngest volume，已归档记录也不丢。

## 9. 离线升级与回滚

升级也复用同一套受控流程，不是三条命令直接覆盖：

```bash
# 构建机:打新包(新 tag),只传 images.tar.gz 也可以
scripts/make-deploy-bundle.sh --public-origin ... --inngest-origin ... \
  --mode shared --shared-network ... --shared-inngest-url ... \
  --callback-alias ao-v2-app --arch arm64 --tag v20260801

# 目标机:
docker load -i images.tar.gz
sed -i '' 's/^AO_IMAGE=.*/AO_IMAGE=agentic-operator:v20260801-arm64/' .env.deploy
# 先完成下面的备份与 5.5 schema 审批链；空差异验证通过后才执行：
aoc up -d --wait
```

- 升级前先做第 8 节三类备份。
- 暂停新事件入口，确认 running=0 且 queued=0，再停 app/archiver/sweeper；
  queued 无法清零时中止升级。
- 保持 `DATABASE_SCHEMA_SYNC=0`，严格复用 5.5 的“生成 SQL → 危险语句停点 →
  人工批准 → `psql -1` 执行同一文件 → Prisma 空差异”链路，再起 web。
- **回滚**：把 `.env.deploy` 里 `AO_IMAGE` 改回旧 tag → `aoc up -d --wait`。
  旧镜像还在目标机本地（除非手动清理过）。回滚应用**不回滚数据库**；若新
  版本做过 additive schema 变更，旧代码通常兼容多出来的列。
- 入口遇到破坏性 drift 会失败关闭；此时先备份并设计显式迁移，禁止为了
  启动而加 `--accept-data-loss`。

### 从 Steven 切 main 后的旧栈回滚

旧 `ao-postgres_ao-pgdata` 从未被 main 挂载或改写，是数据库回滚锚点。切换后
若必须回滚：

1. 重新暂停 RAAS 新事件入口，等待 main 的 running=0 且 queued=0；无法清零
   时中止回滚并制定重放/迁移方案，共享 Inngest 本身保持运行。
2. `aoc stop app archiver monitor-sweeper`，确保 main 不再写新卷。
3. 按旧 Steven compose 启动旧 `ao-postgres` 与 `ao-main`，不要让两个 AO app
   同时注册/消费。
4. 对旧 AO `/api/inngest` 执行注册 PUT，把唯一 callback 切回旧容器；确认
   6 个函数及 queued drain 后再恢复入口。
5. main 运行窗口中已经写入新卷的数据不会自动回灌旧卷；保留新卷和最终 dump，
   单独做差异对账，禁止双栈同时接单。

## 10. 故障排查表

| 症状 | 大概率原因 | 处理 |
| --- | --- | --- |
| Inngest Apps 页 `agentic-operator-main` unreachable / 函数 0 个 | app 未健康、shared callback alias/URL 不一致，或重启后尚未显式注册 | `aoc logs app`；确认 `INNGEST_SERVE_ORIGIN=http://<AO_SHARED_NETWORK_ALIAS>:3002`，再执行 5.6 的 `register-with-inngest.ts` 命令 |
| 事件发了 run 不跑 / 卡 queued | 共享 Inngest 无法通过 overlay 网络回调 AO，或 callback 仍指向 Steven | 核对 `RAAS_SHARED_NETWORK`、alias 和 Apps 页唯一 callback；容器间请求 `http://<alias>:3002/api/inngest`，修正后显式重注册 |
| resumeParser/matchResume 全部失败，报 fetch timeout | 目标机到 `api.gohire.top` 的公网出口不通 | `bash scripts/check-connectivity.sh` 复测；找网络管理员给该域名开出网 |
| match-resume 稳定在 ~120s 失败 | `ROBOHIRE_TIMEOUT_MS` 用了旧默认 120000 | 改 300000 后 `aoc up -d app` |
| 实体写入报 `ALLMETA_BASE_URL is not configured` / 连接拒绝 | Allmeta 栈没起，或容器内用了 `localhost:3500` | Allmeta 在宿主机时必须写 `http://host.docker.internal:3500`；确认 `docker ps` 里 Allmeta app 在跑 |
| agent 报 `relation ... does not exist`（partner 库） | RAAS 七张表未建 | 找 RAAS 方执行他们的 schema 迁移，AO 不代建 |
| 批准 SQL 的 `psql -1` 失败，或 Prisma 空差异检查返回 2 | SQL 不适用于当前恢复基线，或执行后仍有 drift | 保留失败输出并回滚该事务；重新生成/评审 migration，禁止 `--accept-data-loss` |
| 页面浏览器控制台请求打到 localhost / 打不开 Inngest dashboard 链接 | `NEXT_PUBLIC_*` 是 build-time 值，打包时 origin 填错 | 用正确的 `--public-origin/--inngest-origin` 重新打包镜像（改 env 重启无效） |
| `up` 时报端口被占 | 老部署没停干净 | 勘察脚本第 5 节看占用者；`docker stop` 对应容器或改 `AO_PORT` 等 |
| `up` 警告 orphan containers / 老容器被动到 | `COMPOSE_PROJECT_NAME` 与老部署撞名 | 换项目名（如 `ao-v2`）后重新 `up` |
| `up` 报 `network <RAAS_SHARED_NETWORK> ... not found` | 填写的共享网络名与生产事实不符 | 用勘察脚本或 `docker network ls` 锁定真名，更新 `.env.deploy`；不要依赖猜测的默认值 |
| Apps 页出现两个 `agentic-operator-main`，一个红 | 老容器的注册条目残留 | 在 Inngest UI 删除指向老容器 URL 的旧条目 |
| partner 事件（RESUME_DOWNLOADED 等）触发不了新 AO | 错用了模式 B 自带 Inngest，partner 事件在共享实例上 | 按第 1 节切回模式 S：`COMPOSE_PROFILES=` + 指向共享实例 + shared overlay |
| 重启 Docker Desktop 后什么都没起来 | Docker Desktop 未设开机自启 | 见 5.5 的 macOS 两项系统设置 |

## 11. 网络和安全

- AO 自有 Postgres 仅绑定宿主 loopback；本部署示例用 `127.0.0.1:5436` 避开
  Steven/Allmeta 已占端口，不要暴露公网。
- 生产默认使用既有共享 Inngest。只有隔离环境显式选 bundled 模式时，才启动
  compose 内带持久化的单机事件服务；公网生产应使用受保护的生产级事件服务
  并轮换真实 key。
- 3002/8288/8289 只对操作员和受信 partner 开放；公网入口前放 TLS 反代。
- `.env.deploy` 已被 `.gitignore` 排除，禁止提交真实凭证。
- `STUB_AGENTS`、`RULE_CHECK_BYPASS`、`AO_ENABLE_UNSAFE_DEV_ROUTES` 生产
  必须保持关闭（验收窗口临时开启后要关回去）。

## 附录 A · 目标机可上网时的在线流程

代码到目标机（git clone 或 tarball）后，在目标机直接：

```bash
cp .env.deploy.example .env.deploy   # 按 5.3 的表填写
node scripts/deploy-preflight.mjs --env-file .env.deploy   # 或用 docker run node:22 跑
bash scripts/deploy-compose.sh --env-file .env.deploy -- config --quiet

# 先构建 AO 镜像；随后按 5.5 恢复新卷、执行批准 SQL并验证空差异。
bash scripts/deploy-compose.sh --env-file .env.deploy -- build app

# 5.5 完成后才启动 shared 四服务。
bash scripts/deploy-compose.sh --env-file .env.deploy -- \
  up -d --wait
```

装过 npm 依赖时可用 `npm run deploy:check` / `deploy:config` 做预检；只有 5.5
批准 SQL和空差异证据都完成后，才可用 `deploy:up` / `deploy:ps` /
`deploy:logs` / `deploy:down`。`deploy:up` 会现场构建镜像（需要公网拉基础镜像
和 npm 包），但不会替代数据恢复或 schema 审批。其余验收、运维与主线相同。

## 附录 B · 直接复用 Steven PostgreSQL 物理卷（高风险、仅应急）

主线的逻辑 dump → 全新卷 restore 可验证、可回滚，优先使用。只有维护窗口很短、
已确认 PostgreSQL major 兼容且逻辑备份可用时，才允许显式复用旧物理卷：

1. 用勘察脚本锁定真实 volume 名、旧镜像 tag、`PG_VERSION`、数据库名/用户和
   `data_directory`；先完成第 5.1 的逻辑 dump。不能凭文档猜卷名。
2. 暂停 RAAS 新事件入口，等待 running=0 且 queued=0；queued 无法清零则中止。
   随后停止旧 app、archiver 和旧 PostgreSQL。`docker ps -a` 必须证明没有
   进程仍挂载该卷。
3. `.env.deploy` 设 `AO_POSTGRES_VOLUME_MODE=external`、
   `AO_EXISTING_POSTGRES_VOLUME=<勘察得到的精确卷名>`、
   `DATABASE_SCHEMA_SYNC=0`。先按 5.4 的同一方式重新运行**完整 external
   预检**；任一错误都不得继续。下面分支同时适用于离线包与在线仓库：

```bash
if [ -f IMAGES.env ]; then
  docker run --rm --entrypoint node -v "$PWD:/kit" -w /kit \
    "$(grep '^AO_IMAGE=' IMAGES.env | cut -d= -f2)" \
    scripts/deploy-preflight.mjs --env-file .env.deploy \
      --expect-mode shared --expect-volume-mode external
else
  node scripts/deploy-preflight.mjs --env-file .env.deploy \
    --expect-mode shared --expect-volume-mode external
fi

# 包装脚本会自动加入第三个显式 overlay，并再次硬拒绝 schema auto-sync。
bash scripts/deploy-compose.sh --env-file .env.deploy \
  --expect-mode shared --expect-volume-mode external -- config --quiet

# 只启动新版 PostgreSQL，并先核对 server major、data_directory 和核心行数。
bash scripts/deploy-compose.sh --env-file .env.deploy \
  --expect-mode shared --expect-volume-mode external -- \
  up -d --wait ao-postgres
```

4. 只有核对通过后，才按 5.5 生成/审查 SQL、用 `psql -1` 执行那一份批准文件
   并验证空差异，再启动 shared 四服务并按 5.6 注册 callback。任何 major 不
   兼容、volume ownership 异常或 destructive drift 都立即停止，回到逻辑
   dump → 新卷 restore 主线。

> 物理卷一旦被 main 的 PostgreSQL/schema 写入，就不再是未经修改的 Steven
> 回滚锚点。需要老栈回滚时只能依赖切换前逻辑备份或复制出的只读卷快照；绝不
> 允许新旧两个 PostgreSQL 同时挂载同一 volume。

## 附录 C · 老版本 SQLite 数据迁移（可选）

仅当明确需要保留老 AO 的历史数据时执行：

1. 从老容器/挂载里取出 SQLite 文件（勘察第 4 节确认路径，典型为
   `/app/data/ao.db`）：`docker cp ao-main:/app/data/ao.db ./data/ao.db`
2. 把 `ao.db` 放到新部署 app 容器可读的位置，并在临时 shell 里执行仓库
   自带的幂等迁移脚本（需要构建机协助或在目标机临时挂载源码）：
   `npm run db:migrate-from-sqlite`（读 `data/ao.db` 写 `DATABASE_URL`）。
3. 迁移脚本幂等，可重复执行；迁移完成后正常走第 6 节验收。

老版本与当前 schema 差异过大时以报错为准，届时单独设计迁移，不要强行
`--force-reset`。
