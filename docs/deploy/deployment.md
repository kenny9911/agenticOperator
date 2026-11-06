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

`docker-compose.deploy.yml` 编排五个服务，数据全部落在 named volume 里，
重建容器不丢监控、事件、日志和运行记录：

| 服务 | 作用 | 持久化 volume |
| --- | --- | --- |
| `app` | Next.js UI、API、Agent/Inngest 回调（端口 3002） | `<项目名>-logs`（完整 JSONL agent 日志） |
| `postgres` | AO 运营数据、LogEvent、通知、事件/run/step 归档 | `<项目名>-postgres-data` |
| `inngest`（可选） | 事件调度与实时运行（端口 8288/8289，显式 `--persist`） | `<项目名>-inngest-data` |
| `archiver` | Inngest events/runs/steps 补偿归档到 Postgres | 写 `postgres` |
| `monitor-sweeper` | SLA、健康、错误率、成本和保留策略扫描 | 写 `postgres` |

### Inngest 两种模式（部署前必须选定）

架构铁律：**AO 和 RAAS partner 共用同一个 Inngest 实例**（partner 侧的
RESUME_DOWNLOADED 等事件直接进这个实例触发 AO 函数）。因此：

- **模式 S · 共享 Inngest（Mac Studio 生产现状，本指南主线）**——机器上已
  有共享实例（Mac Studio 上叫 `inngest-server`，带自己的 postgres/redis
  持久化），AO **不再**自带 Inngest：
  `.env.deploy` 里 `COMPOSE_PROFILES=`（置空，bundled 服务不启动），
  `INNGEST_BASE_URL` / `INNGEST_SERVE_ORIGIN` 指向共享实例，并叠加
  `docker-compose.shared-inngest.yml` 加入 RAAS 的 Docker 网络。
  **如果错误地自带一套新 Inngest，partner 事件到不了 AO，六函数链路直接
  断掉。**
- **模式 B · 自带 Inngest（全新独立机器）**——机器上没有任何共享实例：
  保持 `COMPOSE_PROFILES=bundled-inngest`（模板默认），compose 启动第三行
  的 `inngest` 服务，四个 URL 全走默认，无需 overlay 文件。

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
   3002）、env 指向哪套 MinIO/Postgres、容器里有没有 `/app/data` 下的
   SQLite 旧数据（决定要不要做数据迁移）。
3. **共享 Inngest 事实**（决定第 1 节的模式）：`docker ps` 里有没有
   `raas-inngest` 之类的共享事件引擎；共享网络真名用
   `docker network ls | grep -i raas` 确认（默认假设
   `raas-deploy-next_default`，不一致则在 `.env.deploy` 设
   `RAAS_SHARED_NETWORK=<真名>`）。
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
# 预检/连通自检同第 5 节；启动命令在 5.5 的基础上加 --build:
docker compose --env-file .env.deploy \
  -f docker-compose.deploy.yml -f docker-compose.shared-inngest.yml up -d --build --wait
```

首次构建在目标机上完成（M 系列 Mac 约 15–25 分钟，需要拉 node/postgres
基础镜像和 npm 包）。此后升级 = `git pull` + 重新 `up -d --build --wait`。

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
images.tar.gz        # 三个镜像：agentic-operator + postgres + inngest
docker-compose.deploy.yml
.env.deploy.draft    # 镜像 tag、公开地址已预填，只剩密钥/端点要改
IMAGES.env           # 本包镜像清单（记录用）
README-TARGET.md     # 目标机快速步骤（本节的精简版）
scripts/             # deploy-preflight.mjs · check-connectivity.sh · survey-old-deployment.sh
```

参考数字（2026-07-16 在 Apple Silicon 构建机实测）：AO 镜像约 **2.1 GB**；
冷缓存构建 30–40 分钟（npm 全量拉包，网络抖动会自动重试），热缓存约
10 分钟。交叉构建（`--arch` 与构建机不同）走 QEMU 模拟，预期慢 3–5 倍。
整套 compose 已在构建机完整烟测通过：五容器 healthy、`/api/health` 全绿、
6/6 RAAS-v1 函数注册成功。

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

### 5.1 停掉老版本（如果有）

> ⚠️ 老部署的 compose 项目名如果恰好也叫 `agentic-operator`（勘察第 2 项
> 可见），**新部署必须换一个项目名**（下面 5.3 里设
> `COMPOSE_PROJECT_NAME=ao-v2`）。同名会让 compose 把老容器当本项目的
> 孤儿，`up` 时有被误删的风险。

```bash
# 先看老 AO 到底有哪些容器（名字以勘察为准）:
docker ps --format '{{.Names}}' | grep -iE '^ao-|agentic'
# 只 stop 不 rm —— 老容器和它的数据原样保留，可随时回滚
docker stop ao-main                    # 老 AO 应用
docker stop ao-postgres 2>/dev/null    # 老 AO 自己的 Postgres（若存在）
```

**共享模式下千万不要停** `raas-inngest`、RAAS 的 `postgres`、MinIO、
Allmeta——它们是新部署继续要用的共享服务。

老 AO 的历史数据**默认不迁移**——新版本用自己的 Postgres 从零开始积累，
老数据留在老容器/volume 里可随时回看。确实需要旧数据时，见附录 B。

### 5.2 导入镜像

```bash
docker load -i images.tar.gz
docker images | grep -E 'agentic-operator|postgres|inngest'   # 应看到三个
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
| `COMPOSE_PROFILES` | 置空（`COMPOSE_PROFILES=`） | 共享模式不起 bundled inngest（第 1 节模式 S） |
| `INNGEST_BASE_URL` | `http://host.docker.internal:8288` | 共享实例 `inngest-server` 只发布在宿主 loopback（127.0.0.1:8288），容器经宿主桥访问（老部署同款写法） |
| `INNGEST_SERVE_ORIGIN` | `http://host.docker.internal:3002` | Inngest 回调经宿主桥打到新 app 发布的 3002 端口 |
| `AO_POSTGRES_PORT` | `5436` | 宿主 5433 已被占用、5434 是老 ao-postgres、5435 是 allmeta 的——避开 |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | 沿用老 env §9 的两个随机值 | 生产拒绝字面量 `dev` |
| `AO_POSTGRES_PASSWORD` | 生成一个长随机串 | `openssl rand -hex 24` |
| `DATABASE_URL` | 把密码同步进去，host 保持 `ao-postgres:5432` | **新栈自己的** Postgres 服务名。故意不叫 `postgres`——共享网络上已有同名容器（new-api 的库），同名别名会让 DNS 二义、写错库 |
| `RAAS_SHARED_NETWORK` | `new-api_new-api-network` | 实勘结论：partner `raas` 库所在的 `postgres` 容器挂在 new-api 的网络上（不是 raas-deploy-next_default） |
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
| `AGENT_EXECUTION_API_KEY` / `FACTORY_ADMIN_TOKEN` | 两个长随机串（老 env 没有这两项，是新版本新增） | 保护对外管理/执行 API |

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

候选人身份/去重/锁定的四个行为开关**首次部署一律保持模板默认**（
`LOCK_CHECK_ENABLED=0`、`CANDIDATE_LOCK_PG_WRITE=0`、`LOCK_CHECK_ENFORCE=0`、
`DEDUP_PHONE_PRIMARY=0`；`CANDIDATE_IDENTITY_ENABLED=1` 是默认开）。它们决定
"谁算同一个人"和"锁定候选人要不要被抑制"，跑通验收后再逐个灰度。其中
`DEDUP_PHONE_PRIMARY=1` 是**单向门**——它改变落库的身份主键，开之前必须先
在 partner 库回填 `mobile_normalized`。

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

### 5.5 启动

模式 S（共享 Inngest，Mac Studio 主线）——叠加 shared overlay 加入 RAAS
网络：

```bash
docker compose --env-file .env.deploy \
  -f docker-compose.deploy.yml -f docker-compose.shared-inngest.yml up -d --wait
```

模式 B（自带 Inngest 的独立机器）只用主文件：

```bash
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --wait
```

注意**没有 `--build`**：目标机全部使用已导入的镜像。`--wait` 会等健康检查
通过，首次启动含 schema 初始化，约 1–3 分钟。入口脚本只执行非破坏性的
`prisma db push`（无 `--accept-data-loss` / `--force-reset`）；遇到破坏性
schema drift 会**失败停机**要求人工处理，这是有意设计。

macOS 目标机的两项系统设置（Docker 主机长期运行的前提）：

- Docker Desktop → Settings → General → 勾选 **Start Docker Desktop when
  you sign in**（`restart: unless-stopped` 只在 Docker 本身活着时有效）；
- 系统设置 → 能源：关闭睡眠（防止整机挂起后容器全停）。

## 6. 阶段四 · 验收

逐层验证，每层通过再看下一层：

```bash
# ① 五个容器全部 running/healthy
docker compose --env-file .env.deploy -f docker-compose.deploy.yml ps

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
unreachable——在 Inngest UI 里删除旧条目即可，新条目由新容器自动注册。
函数缺失或 app unreachable，见第 10 节排查表首条。

**⑤ 端到端测试事件**：测试路由在生产默认关闭，验收时临时开一个窗口：

```bash
# 临时打开测试路由并重启 app（只影响 app 容器）
sed -i '' 's/^AO_ENABLE_UNSAFE_DEV_ROUTES=0/AO_ENABLE_UNSAFE_DEV_ROUTES=1/' .env.deploy
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d app

# 触发一条隔离的岗位需求事件 → createJdAgent 应真实跑起来
curl -X POST "http://localhost:3002/api/test/trigger-requirement"

# 在 http://<目标机IP>:8288 的 Runs 里看到 run 完成；
# 在 AO /monitor 页看到对应记录；等一个归档周期(默认30s)后 /events 可回读

# 验收完立刻关回去
sed -i '' 's/^AO_ENABLE_UNSAFE_DEV_ROUTES=1/AO_ENABLE_UNSAFE_DEV_ROUTES=0/' .env.deploy
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d app
```

**⑥ 持久化**：`docker compose ... restart` 后，第⑤步产生的监控/审计记录
仍能在页面查到。

`/api/health?check=ready` 只验证 Web + AO Postgres（避免 app 与 Inngest
互等成环）；Allmeta/RAAS/MinIO 等深度状态看 `/api/system/config` 与
`/api/dependency-health`。

## 7. 日常操作（目标机）

目标机没有 npm，直接用 docker compose（在 `~/ao-deploy` 下执行）：

```bash
# 共享模式(Mac Studio)带 overlay;模式 B 去掉第二个 -f
alias aoc='docker compose --env-file .env.deploy -f docker-compose.deploy.yml -f docker-compose.shared-inngest.yml'
aoc ps                      # 状态
aoc logs -f --tail=200      # 全部日志
aoc logs -f app             # 单服务日志（app / inngest / archiver / monitor-sweeper / postgres）
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

Inngest 实时库和 JSONL 日志的冷备（短暂停写保证文件一致；volume 名前缀
按你的 `COMPOSE_PROJECT_NAME`，下例为 `ao-v2`）：

```bash
aoc stop inngest archiver app monitor-sweeper
docker run --rm -v ao-v2-inngest-data:/source:ro -v "$PWD/backups:/backup" \
  "$(grep '^POSTGRES_IMAGE=' IMAGES.env | cut -d= -f2)" \
  tar czf /backup/inngest-data.tgz -C /source .
docker run --rm -v ao-v2-logs:/source:ro -v "$PWD/backups:/backup" \
  "$(grep '^POSTGRES_IMAGE=' IMAGES.env | cut -d= -f2)" \
  tar czf /backup/ao-logs.tgz -C /source .
aoc start
```

（离线机器上没有 alpine 镜像，上面借 postgres 镜像自带的 tar 完成打包。）

迁机：新机器先创建同名空 volume 并解入两个 tar 包，启动 `ao-postgres`
后用 `pg_restore --clean --if-exists` 恢复 dump，再起整套 compose。Postgres
归档是监控历史的权威副本——即使不迁 Inngest volume，已归档记录也不丢。

## 9. 离线升级与回滚

升级 = 重复 阶段一/二 + 目标机三条命令：

```bash
# 构建机:打新包(新 tag),只传 images.tar.gz 也可以
scripts/make-deploy-bundle.sh --public-origin ... --inngest-origin ... --arch arm64 --tag v20260801

# 目标机:
docker load -i images.tar.gz
sed -i '' 's/^AO_IMAGE=.*/AO_IMAGE=agentic-operator:v20260801-arm64/' .env.deploy
aoc up -d --wait
```

- 升级前先做第 8 节三类备份。
- **回滚**：把 `.env.deploy` 里 `AO_IMAGE` 改回旧 tag → `aoc up -d --wait`。
  旧镜像还在目标机本地（除非手动清理过）。回滚应用**不回滚数据库**；若新
  版本做过 additive schema 变更，旧代码通常兼容多出来的列。
- 入口遇到破坏性 drift 会失败关闭；此时先备份并设计显式迁移，禁止为了
  启动而加 `--accept-data-loss`。

## 10. 故障排查表

| 症状 | 大概率原因 | 处理 |
| --- | --- | --- |
| Inngest Apps 页 `agentic-operator-main` unreachable / 函数 0 个 | app 未健康或回调地址不对（compose 内固定为 `http://app:3002`，一般不会错）；app 刚重启还没重新注册 | `aoc logs app` 看启动报错；`aoc restart app` 触发重新注册；确认 `aoc ps` 里 app healthy |
| 事件发了 run 不跑 / 卡 queued | Inngest 回调不通（跨机部署改过 `INNGEST_SERVE_ORIGIN`） | compose 内不要覆盖该变量；自定义部署时必须是 Inngest 能回调到 app 的地址 |
| resumeParser/matchResume 全部失败，报 fetch timeout | 目标机到 `api.gohire.top` 的公网出口不通 | `bash scripts/check-connectivity.sh` 复测；找网络管理员给该域名开出网 |
| match-resume 稳定在 ~120s 失败 | `ROBOHIRE_TIMEOUT_MS` 用了旧默认 120000 | 改 300000 后 `aoc up -d app` |
| 实体写入报 `ALLMETA_BASE_URL is not configured` / 连接拒绝 | Allmeta 栈没起，或容器内用了 `localhost:3500` | Allmeta 在宿主机时必须写 `http://host.docker.internal:3500`；确认 `docker ps` 里 Allmeta app 在跑 |
| agent 报 `relation ... does not exist`（partner 库） | RAAS 七张表未建 | 找 RAAS 方执行他们的 schema 迁移，AO 不代建 |
| 启动时 `prisma db push` 失败停机 | 破坏性 schema drift（有意 fail-closed） | 备份后人工处理迁移；不要加 `--accept-data-loss` |
| 页面浏览器控制台请求打到 localhost / 打不开 Inngest dashboard 链接 | `NEXT_PUBLIC_*` 是 build-time 值，打包时 origin 填错 | 用正确的 `--public-origin/--inngest-origin` 重新打包镜像（改 env 重启无效） |
| `up` 时报端口被占 | 老部署没停干净 | 勘察脚本第 5 节看占用者；`docker stop` 对应容器或改 `AO_PORT` 等 |
| `up` 警告 orphan containers / 老容器被动到 | `COMPOSE_PROJECT_NAME` 与老部署撞名 | 换项目名（如 `ao-v2`）后重新 `up` |
| `up` 报 `network raas-deploy-next_default ... not found` | 共享网络真名不同 | `docker network ls` 找含 raas 的真名，`.env.deploy` 设 `RAAS_SHARED_NETWORK=<真名>` |
| Apps 页出现两个 `agentic-operator-main`，一个红 | 老容器的注册条目残留 | 在 Inngest UI 删除指向老容器 URL 的旧条目 |
| partner 事件（RESUME_DOWNLOADED 等）触发不了新 AO | 错用了模式 B 自带 Inngest，partner 事件在共享实例上 | 按第 1 节切回模式 S：`COMPOSE_PROFILES=` + 指向共享实例 + shared overlay |
| 重启 Docker Desktop 后什么都没起来 | Docker Desktop 未设开机自启 | 见 5.5 的 macOS 两项系统设置 |

## 11. 网络和安全

- AO 自有 Postgres 默认只绑定 `127.0.0.1:5433`，不要暴露公网。
- 内置 Inngest 是带持久化的单机 dev server，适用于可信 LAN/交付环境；
  公网生产应改接 Inngest Cloud 或受保护的生产级事件服务并换真 key。
- 3002/8288/8289 只对操作员和受信 partner 开放；公网入口前放 TLS 反代。
- `.env.deploy` 已被 `.gitignore` 排除，禁止提交真实凭证。
- `STUB_AGENTS`、`RULE_CHECK_BYPASS`、`AO_ENABLE_UNSAFE_DEV_ROUTES` 生产
  必须保持关闭（验收窗口临时开启后要关回去）。

## 附录 A · 目标机可上网时的在线流程

代码到目标机（git clone 或 tarball）后，在目标机直接：

```bash
cp .env.deploy.example .env.deploy   # 按 5.3 的表填写
node scripts/deploy-preflight.mjs --env-file .env.deploy   # 或用 docker run node:22 跑
docker compose --env-file .env.deploy -f docker-compose.deploy.yml config --quiet
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --build --wait
```

装过 npm 依赖的话，等价快捷方式：`npm run deploy:check` / `deploy:up` /
`deploy:ps` / `deploy:logs` / `deploy:down`。`up --build` 会在目标机现场
构建镜像（需要公网拉基础镜像和 npm 包）。其余验收、运维与主线相同。

## 附录 B · 老版本 SQLite 数据迁移（可选）

仅当明确需要保留老 AO 的历史数据时执行：

1. 从老容器/挂载里取出 SQLite 文件（勘察第 4 节确认路径，典型为
   `/app/data/ao.db`）：`docker cp ao-main:/app/data/ao.db ./data/ao.db`
2. 把 `ao.db` 放到新部署 app 容器可读的位置，并在临时 shell 里执行仓库
   自带的幂等迁移脚本（需要构建机协助或在目标机临时挂载源码）：
   `npm run db:migrate-from-sqlite`（读 `data/ao.db` 写 `DATABASE_URL`）。
3. 迁移脚本幂等，可重复执行；迁移完成后正常走第 6 节验收。

老版本与当前 schema 差异过大时以报错为准，届时单独设计迁移，不要强行
`--force-reset`。
