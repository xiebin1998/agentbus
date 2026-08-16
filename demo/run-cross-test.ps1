# Cross-test runner script
# Uses local demo directory instead of desktop

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "AgentBus Cross-Agent Testing" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Change to project directory
Set-Location "D:\workSpase\Python\agentbus"

# Run cross-test with modified DEMO_BASE
$env:DEMO_BASE = "D:\workSpase\Python\agentbus\demo"

Write-Host "Starting cross-test..." -ForegroundColor Green
node agentbus/scripts/cross-test.mjs

Write-Host ""
Write-Host "Test completed!" -ForegroundColor Green
