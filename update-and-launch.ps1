# Kite Code - Automated Silent Update and Launch Script
Write-Host "Stopping running Kite Code instances..." -ForegroundColor Cyan
Stop-Process -Name "*kite-code*" -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name like '%webview2%'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*dev.kite.code*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# Clean up stale WebView2 locks if present
$lockPath = "$env:LOCALAPPDATA\dev.kite.code\EBWebView\Default\LOCK"
if (Test-Path $lockPath) {
    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}

$ProjectRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$installer = Get-ChildItem -Path (Join-Path $ProjectRoot "src-tauri\target\release\bundle\nsis"), (Join-Path $ProjectRoot "dist") -Filter "*setup*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
    Write-Error "Installer not found. Run 'npm run build:installer' first."
    exit 1
}
$installerPath = $installer.FullName

Write-Host "Installing silently without user prompts (/S) from: $installerPath" -ForegroundColor Cyan
Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait

$candidateInstalled = @(
    "$env:LOCALAPPDATA\Programs\Kite Code\kite-code.exe",
    "$env:LOCALAPPDATA\Kite Code\kite-code.exe",
    "$env:ProgramFiles\Kite Code\kite-code.exe"
)
$installedApp = $candidateInstalled | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($installedApp) {
    Write-Host "Launching updated Kite Code: $installedApp" -ForegroundColor Green
    Start-Process -FilePath $installedApp
} else {
    $distBinary = Join-Path $ProjectRoot "src-tauri\target\release\kite-code.exe"
    Write-Host "Launching distribution binary: $distBinary" -ForegroundColor Green
    Start-Process -FilePath $distBinary
}
Write-Host "Done! Kite Code is running." -ForegroundColor Green
