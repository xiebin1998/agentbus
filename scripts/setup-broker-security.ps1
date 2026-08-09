# TASK-25 安全基线：初始化 broker 认证与 TLS 证书
# -------------------------------------------------
# 产物：
#   mosquitto/config/passwd    —— mosquitto 密码文件（mosquitto_passwd 生成）
#   mosquitto/certs/ca.crt|ca.key|server.crt|server.key —— 自签 CA + 服务端证书
#
# 用法：
#   pwsh scripts/setup-broker-security.ps1                  # 默认用户 agentbus，随机密码
#   pwsh scripts/setup-broker-security.ps1 -User u -Password p
#
# 依赖：openssl 在 PATH 中（Git for Windows 自带）；docker 可用（跑 mosquitto_passwd）。
# 完成后需重启 broker 容器：docker compose up -d mqtt-broker

param(
    [string]$User = "agentbus",
    [string]$Password = "",
    [int]$Days = 3650
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$certDir = Join-Path $root "mosquitto\certs"
$cfgDir = Join-Path $root "mosquitto\config"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

# ── 1) openssl 可用性（PATH 优先；其次从 Git 安装目录推导） ────────────────
$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        $candidate = Join-Path (Split-Path (Split-Path $gitCmd.Source)) "usr\bin\openssl.exe"
        if (Test-Path $candidate) {
            $env:PATH = "$(Split-Path $candidate);$env:PATH"
            $openssl = Get-Command openssl
        }
    }
}
if (-not $openssl) {
    Write-Error "未找到 openssl。请安装 Git for Windows（自带 openssl）后确保其在 PATH 中。"
    exit 1
}

# ── 2) 自签 CA + 服务端证书（CN=localhost，SAN 覆盖本机常见地址） ─────────
Push-Location $certDir
try {
    Write-Host "[1/3] 生成自签 CA..."
    openssl req -new -x509 -days $Days -keyout ca.key -out ca.crt `
        -subj "/O=AgentBus/CN=AgentBus-Dev-CA" -nodes 2>$null
    if ($LASTEXITCODE -ne 0) { throw "CA 生成失败" }

    Write-Host "[2/3] 生成服务端证书（CN=localhost）..."
    openssl genrsa -out server.key 2048 2>$null
    openssl req -new -key server.key -out server.csr `
        -subj "/O=AgentBus/CN=localhost" 2>$null
    Set-Content -Path san.cnf -Value "subjectAltName=DNS:localhost,DNS:mqtt-broker,IP:127.0.0.1" -NoNewline
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial `
        -out server.crt -days $Days -extfile san.cnf 2>$null
    if ($LASTEXITCODE -ne 0) { throw "服务端证书生成失败" }
    Remove-Item server.csr, san.cnf -ErrorAction SilentlyContinue
} finally {
    Pop-Location
}

# ── 3) 密码文件（官方镜像一次性容器内跑 mosquitto_passwd） ────────────────
if (-not $Password) {
    $Password = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
}
Write-Host "[3/3] 生成密码文件（用户: $User）..."
docker run --rm -v "${cfgDir}:/mosquitto/config" eclipse-mosquitto:2 `
    mosquitto_passwd -c -b /mosquitto/config/passwd $User $Password
if ($LASTEXITCODE -ne 0) { throw "mosquitto_passwd 失败" }
# Windows bind mount 下产物属 root:0600，容器内 mosquitto 用户读不到 → 放宽权限
docker run --rm -v "${cfgDir}:/mosquitto/config" eclipse-mosquitto:2 `
    chmod 644 /mosquitto/config/passwd

Write-Host ""
Write-Host "完成。请同步以下凭证到 .env / daemon config.json：" -ForegroundColor Green
Write-Host "  MQTT_USERNAME=$User"
Write-Host "  MQTT_PASSWORD=$Password"
Write-Host "  MQTT_USE_TLS=true  (8883)"
Write-Host "  MQTT_CA_CERTS=<repo>/mosquitto/certs/ca.crt   (hub/daemon 自签信任锚)"
Write-Host "hub SSE/控制台鉴权：设置 MCP_API_TOKEN=<任意强随机串>"
Write-Host "然后重启 broker：docker compose up -d mqtt-broker"
