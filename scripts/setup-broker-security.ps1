# TASK-25 安全基线：初始化 broker TLS 证书
# -------------------------------------------------
# 四期：文件式 passwd/ACL 已退役（改由 dynsec 插件运行时管理），
# 本脚本仅生成证书。
# 产物：
#   mosquitto/certs/ca.crt|ca.key|server.crt|server.key —— 自签 CA + 服务端证书
#
# 用法：
#   pwsh scripts/setup-broker-security.ps1
#
# 依赖：openssl 在 PATH 中（Git for Windows 自带）。
# 完成后需重启 broker 容器：docker compose up -d mqtt-broker

param(
    [int]$Days = 3650
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$certDir = Join-Path $root "mosquitto\certs"
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
    Write-Host "[1/2] 生成自签 CA..."
    openssl req -new -x509 -days $Days -keyout ca.key -out ca.crt `
        -subj "/O=AgentBus/CN=AgentBus-Dev-CA" -nodes 2>$null
    if ($LASTEXITCODE -ne 0) { throw "CA 生成失败" }

    Write-Host "[2/2] 生成服务端证书（CN=localhost）..."
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

Write-Host ""
Write-Host "完成。证书已就绪（mosquitto/certs/）。" -ForegroundColor Green
Write-Host "四期提示：broker 用户/ACL 由 dynsec 插件管理，在 .env 配置："
Write-Host "  DYNSEC_ADMIN_USER / DYNSEC_ADMIN_PASSWORD（broker 管理通道 + hub 连接凭证）"
Write-Host "  AGENTBUS_ADMIN_USER / AGENTBUS_ADMIN_PASSWORD（控制台首个超管）"
Write-Host "hub SSE/MCP 通道鉴权：设置 MCP_API_TOKEN=<任意强随机串>"
Write-Host "然后重启 broker：docker compose up -d mqtt-broker"
