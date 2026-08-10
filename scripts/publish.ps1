# ============================================================
# AgentBus npm 一键发布（@xiebin1998/agentbus）
#
# 用法（仓库根目录）：
#   pwsh scripts/publish.ps1                 # 默认 patch：0.1.1 → 0.1.2
#   pwsh scripts/publish.ps1 -Bump minor     # 升 minor
#   pwsh scripts/publish.ps1 -SkipVersion    # 版本号不动（发布失败后重试时用）
#   pwsh scripts/publish.ps1 -SkipTests      # 跳过单测（不建议）
#
# 流程：前置检查 → 单测 → 升版本(git commit+tag) → 构建 → 交互读 OTP → 发布 → 验证传播
# OTP 支持两种：authenticator 的 6 位动态码（注意时钟同步）或 64 位恢复码（一次性，不受时钟影响）
# ============================================================
[CmdletBinding()]
param(
    [ValidateSet("patch", "minor", "major")]
    [string]$Bump = "patch",
    [switch]$SkipVersion,
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pkgDir = Join-Path $root "agentbus"
$pkgName = "@xiebin1998/agentbus"
Set-Location $pkgDir

# ── 0) 前置检查：main 分支 + 工作树干净（npm version 会自动 git commit+tag）──
$branch = (& git branch --show-current).Trim()
if ($branch -ne "main") { throw "当前在 $branch 分支，请切回 main 再发布" }
$dirty = & git status --porcelain
if ($dirty) { throw "工作树有未提交改动，先提交或 stash 再发布" }
if (-not $SkipVersion) {
    Write-Host "[0/6] 前置检查通过（main 分支、工作树干净）" -ForegroundColor Cyan
}

# ── 1) 单测 ──────────────────────────────────────────────
if (-not $SkipTests) {
    Write-Host "[1/6] 跑单测（vitest）..." -ForegroundColor Cyan
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw "单测失败，终止发布" }
} else {
    Write-Host "[1/6] 跳过单测（-SkipTests）" -ForegroundColor Yellow
}

# ── 2) 版本升级 ──────────────────────────────────────────
if (-not $SkipVersion) {
    Write-Host "[2/6] 升版本（$Bump，自动 git commit + tag）..." -ForegroundColor Cyan
    & npm.cmd version $Bump
    if ($LASTEXITCODE -ne 0) { throw "npm version 失败" }
} else {
    Write-Host "[2/6] 跳过版本升级（-SkipVersion）" -ForegroundColor Yellow
}
$ver = (Get-Content package.json -Raw | ConvertFrom-Json).version

# ── 3) 构建 ──────────────────────────────────────────────
Write-Host "[3/6] 构建（tsc → dist/）..." -ForegroundColor Cyan
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "构建失败" }

# ── 4) 读 OTP（动态码或恢复码）─────────────────────────────
Write-Host "[4/6] 请输入发布验证码：" -ForegroundColor Cyan
Write-Host "      - authenticator 6 位动态码：等码刚跳到新值时再输入"
Write-Host "      - 或 64 位恢复码（一次性，不受时钟偏差影响）"
$otp = (Read-Host "验证码").Trim()
if ($otp -notmatch '^\d{6}$' -and $otp -notmatch '^[0-9a-f]{64}$') {
    throw "验证码格式不对：应为 6 位数字或 64 位十六进制恢复码"
}

# ── 5) 发布 ──────────────────────────────────────────────
Write-Host "[5/6] 发布 $pkgName@$ver ..." -ForegroundColor Cyan
& npm.cmd publish --access public --otp $otp
if ($LASTEXITCODE -ne 0) {
    throw "发布失败。若为 EOTP（验证码过期）：重新生成动态码后执行 pwsh scripts/publish.ps1 -SkipVersion"
}

# ── 6) 验证注册表传播（新包/新版本可能有几分钟延迟）────────
Write-Host "[6/6] 等待注册表传播（最长 2.5 分钟）..." -ForegroundColor Cyan
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 15
    $visible = & npm.cmd view "$pkgName@$ver" version 2>$null
    if ($LASTEXITCODE -eq 0 -and $visible) {
        Write-Host "发布成功并已可见：$pkgName@$visible" -ForegroundColor Green
        Write-Host "安装验证：npm i -g $pkgName"
        return
    }
}
Write-Host "已发布但注册表尚未传播完成，稍后自查：npm view $pkgName" -ForegroundColor Yellow
