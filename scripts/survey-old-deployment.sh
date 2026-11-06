#!/usr/bin/env bash
# Read-only survey of an existing machine before deploying/upgrading AO.
# Paste-run on the TARGET machine; prints a report and saves a copy to
# ~/ao-deploy-survey.txt so it can be copied back to the build machine.
# Secrets in container env output are masked. Nothing is modified.
set -u

OLD_AO_DIR="${1:-/Users/ai-eas-coe/agentic-operator}"

mask() {
  sed -E \
    -e 's/^([A-Za-z_]*(KEY|PASSWORD|SECRET|TOKEN)[A-Za-z_]*)=.*/\1=***masked***/' \
    -e 's#(://[^:/@]+):[^@]+@#\1:***@#g'
}

{
echo "########## AO 部署前勘察 $(date '+%Y-%m-%d %H:%M') ##########"

echo ""
echo "===== 1. 系统 ====="
uname -m
sw_vers 2>/dev/null || cat /etc/os-release 2>/dev/null | head -2
docker --version
docker compose version 2>/dev/null

echo ""
echo "===== 2. 全部容器（含已停止）====="
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'

echo ""
echo "===== 2b. Docker 网络（找共享 RAAS 网络真名）====="
docker network ls
echo "-- raas-inngest / raas postgres 所在网络与发布端口 --"
for c in raas-inngest postgres raas-postgres; do
  docker inspect "$c" --format "$c → 网络: {{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}} · 端口: {{range \$p,\$b := .NetworkSettings.Ports}}{{\$p}}→{{if \$b}}{{(index \$b 0).HostPort}}{{end}} {{end}}" 2>/dev/null
done

echo ""
echo "===== 3. 老版本 AO 项目目录 ====="
if [ -d "$OLD_AO_DIR" ]; then
  ls -la "$OLD_AO_DIR" | head -40
  git -C "$OLD_AO_DIR" log -1 --format='最后提交: %h %ad %s' 2>/dev/null
  ls "$OLD_AO_DIR"/docker-compose*.yml "$OLD_AO_DIR"/Dockerfile 2>/dev/null
else
  echo "目录不存在: $OLD_AO_DIR"
fi

echo ""
echo "===== 4. 老 AO 容器详情（自动识别）====="
AO_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -m1 -E '^ao-main$|agentic' || true)
if [ -n "$AO_CONTAINER" ]; then
  echo "容器: $AO_CONTAINER"
  docker inspect "$AO_CONTAINER" --format '镜像: {{.Config.Image}} · 状态: {{.State.Status}} · 启动于: {{.State.StartedAt}}'
  echo "-- 挂载 --"
  docker inspect "$AO_CONTAINER" --format '{{range .Mounts}}{{.Type}}  {{.Source}}  ->  {{.Destination}}{{"\n"}}{{end}}'
  echo "-- 环境变量（已脱敏）--"
  docker inspect "$AO_CONTAINER" --format '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' | mask | sort
  echo "-- 容器里有没有 SQLite 数据 --"
  docker exec "$AO_CONTAINER" sh -c 'ls -la /app/data 2>/dev/null | head -10' 2>/dev/null || echo "(容器未运行或无 /app/data)"
else
  echo "没找到名字含 ao-main / agentic 的容器"
fi

echo ""
echo "===== 5. 关键端口占用 ====="
lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR==1 || /:(3002|3003|8288|8289|5433|5435|9000|9003|3500|4500|7474|7475|7687|7688)\>/' \
  || netstat -an 2>/dev/null | grep LISTEN | grep -E '(3002|8288|8289|5433|5435|9000|3500)'

echo ""
echo "===== 6. 外部依赖连通性（从这台机器测）====="
probe_http() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 6 --max-time 12 "$2" 2>/dev/null || true)
  if [ -n "$code" ] && [ "$code" != "000" ]; then echo "  ✓ $1 HTTP $code ($2)"; else echo "  ✗ $1 连接失败 ($2)"; fi
}
probe_tcp() {
  curl -s --connect-timeout 6 "telnet://$2:$3" </dev/null >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 56 ]; then echo "  ✓ $1 TCP 可达 ($2:$3)"; else echo "  ✗ $1 TCP 不通 ($2:$3)"; fi
}
probe_http "LLM 网关       " "http://10.100.0.70:3010/v1/models"
probe_http "Allmeta 本机   " "http://localhost:3500"
probe_http "RoboHire 公网  " "https://api.gohire.top"
probe_tcp  "RAAS Postgres  " "192.168.1.112" "5432"
probe_tcp  "RAAS MinIO     " "192.168.1.112" "9000"
probe_http "GitHub(参考)   " "https://github.com"
probe_http "DockerHub(参考)" "https://registry-1.docker.io/v2/"

echo ""
echo "===== 7. 磁盘与 Docker 资源 ====="
df -h / | tail -1
docker system df 2>/dev/null

echo ""
echo "===== 8. Docker volumes ====="
docker volume ls --format '{{.Name}}' | head -40

echo ""
echo "########## 勘察结束（副本已存 ~/ao-deploy-survey.txt）##########"
} 2>&1 | tee ~/ao-deploy-survey.txt
