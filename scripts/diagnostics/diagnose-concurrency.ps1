# diagnose-concurrency.ps1
# Diagnostico de concurrencia y recursos compartidos entre Kite Code (PROD) y Kite Code (DEV).

Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host " [KITE CODE] DIAGNOSTICO DE CONCURRENCIA: DEV vs PROD" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Procesos activos de Kite Code
Write-Host "[1] PROCESOS ACTIVOS DE KITE CODE" -ForegroundColor Yellow
$kiteProcs = Get-Process kite-code -ErrorAction SilentlyContinue
if (-not $kiteProcs) {
    Write-Host "  No se encontraron procesos kite-code activos." -ForegroundColor Red
} else {
    $kiteProcs | ForEach-Object {
        $p = $_
        $mode = if ($p.Path -like "*\target\debug\*") { "DEV (target\debug)" }
                elseif ($p.Path -like "*\Kite Code\kite-code.exe*") { "PROD (instalado)" }
                else { "CLI / MCP ($($p.Path))" }
        
        $wsMb = [math]::Round($p.WorkingSet64 / 1MB, 1)
        $cpuSec = [math]::Round($p.TotalProcessorTime.TotalSeconds, 1)
        $threads = $p.Threads.Count

        Write-Host "  - PID $($p.Id) | Modo: $mode" -ForegroundColor Cyan
        Write-Host "    Ruta: $($p.Path)" -ForegroundColor Gray
        Write-Host "    RAM Working Set: ${wsMb} MB | CPU acumulada: ${cpuSec} s | Hilos: $threads" -ForegroundColor Gray
    }
}
Write-Host ""

# 2. Descendientes de WebView2 (Renderers, GPU, Utility)
Write-Host "[2] ARBOL DE PROCESOS WEBVIEW2 (MICROSOFT EDGE WEBVIEW2)" -ForegroundColor Yellow
$webviews = Get-CimInstance Win32_Process -Filter "Name LIKE '%msedgewebview2%'" -ErrorAction SilentlyContinue
if ($webviews) {
    $webviews | ForEach-Object {
        $wv = $_
        $proc = Get-Process -Id $wv.ProcessId -ErrorAction SilentlyContinue
        $parentProc = Get-Process -Id $wv.ParentProcessId -ErrorAction SilentlyContinue
        $parentName = if ($parentProc) { "$($parentProc.ProcessName) ($($parentProc.Id))" } else { "PID $($wv.ParentProcessId)" }
        
        $type = if ($wv.CommandLine -match "--type=([a-zA-Z0-9_-]+)") { $Matches[1] } else { "browser/main" }
        $wsMb = if ($proc) { [math]::Round($proc.WorkingSet64 / 1MB, 1) } else { 0 }
        $cpuSec = if ($proc) { [math]::Round($proc.TotalProcessorTime.TotalSeconds, 1) } else { 0 }

        # Identificar si pertenece a Dev o Prod
        $appOwner = if ($wv.CommandLine -match "dev\.kite\.code\.dev") { "DEV" }
                    elseif ($wv.CommandLine -match "dev\.kite\.code") { "PROD" }
                    else { "OTRO" }

        Write-Host "  - PID $($wv.ProcessId) [$appOwner] Tipo: $type | Padre: $parentName" -ForegroundColor Cyan
        Write-Host "    RAM: ${wsMb} MB | CPU: ${cpuSec} s" -ForegroundColor Gray
    }
}
Write-Host ""

# 3. Puertos de red y servicios locales
Write-Host "[3] AUDITORIA DE PUERTOS DE RED LOCALES" -ForegroundColor Yellow
$ports = @(
    @{ Name = "Frontend Vite (DevUrl)"; Port = 1420 },
    @{ Name = "Servidor de Actualizaciones (Feed Server)"; Port = 9101 }
)

foreach ($pt in $ports) {
    $pNum = $pt.Port
    $pName = $pt.Name
    $conn = Get-NetTCPConnection -LocalPort $pNum -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        $ownerProc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        $ownerStr = if ($ownerProc) { "$($ownerProc.ProcessName) (PID $($ownerProc.Id))" } else { "PID $($conn.OwningProcess)" }
        Write-Host "  - Puerto $pNum ($pName): EN ESCUCHA | Propietario: $ownerStr | Estado: $($conn.State)" -ForegroundColor Green
    } else {
        Write-Host "  - Puerto $pNum ($pName): LIBRE / CERRADO" -ForegroundColor Gray
    }
}
Write-Host ""

# 4. Aislamiento de Carpetas de Datos y Bloqueos (Locks)
Write-Host "[4] VERIFICACION DE DIRECTORIOS Y ARCHIVOS LOCK" -ForegroundColor Yellow

$dirsToCheck = @(
    @{ Name = "WebView2 Prod User Data"; Path = "$env:LOCALAPPDATA\dev.kite.code\EBWebView" },
    @{ Name = "WebView2 Dev User Data";  Path = "$env:LOCALAPPDATA\dev.kite.code.dev\EBWebView" },
    @{ Name = "Roaming AppData Prod";    Path = "$env:APPDATA\Kite Code" },
    @{ Name = "Roaming AppData Dev";     Path = "$env:APPDATA\Kite Code Dev" },
    @{ Name = "LocalAppData Prod Logs";  Path = "$env:LOCALAPPDATA\Kite Code" },
    @{ Name = "LocalAppData Dev Logs";   Path = "$env:LOCALAPPDATA\Kite Code Dev" }
)

foreach ($d in $dirsToCheck) {
    $p = $d.Path
    $n = $d.Name
    $exists = Test-Path $p
    if ($exists) {
        $locks = Get-ChildItem -Path $p -Recurse -Filter "*LOCK*" -ErrorAction SilentlyContinue
        $lockCount = if ($locks) { ($locks | Measure-Object).Count } else { 0 }
        Write-Host "  - ${n}: OK (Existe) | Archivos Lock detectados: $lockCount" -ForegroundColor Green
        if ($locks) {
            foreach ($l in $locks) {
                Write-Host "    -> Lock: $($l.FullName)" -ForegroundColor DarkGray
            }
        }
    } else {
        Write-Host "  - ${n}: No existe aun" -ForegroundColor Gray
    }
}
Write-Host ""

# 5. Tamano de los archivos de log
Write-Host "[5] ARCHIVOS DE REGISTRO INTERNOS (app.log)" -ForegroundColor Yellow
$logProd = "$env:LOCALAPPDATA\Kite Code\app.log"
$logDev = "$env:LOCALAPPDATA\Kite Code Dev\app.log"

if (Test-Path $logProd) {
    $sizeMb = [math]::Round((Get-Item $logProd).Length / 1MB, 2)
    Write-Host "  - PROD app.log: ${sizeMb} MB ($logProd)" -ForegroundColor Cyan
} else {
    Write-Host "  - PROD app.log: No existe" -ForegroundColor Gray
}

if (Test-Path $logDev) {
    $sizeMb = [math]::Round((Get-Item $logDev).Length / 1MB, 2)
    Write-Host "  - DEV app.log:  ${sizeMb} MB ($logDev)" -ForegroundColor Cyan
} else {
    Write-Host "  - DEV app.log:  No existe" -ForegroundColor Gray
}
Write-Host ""
Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host " Diagnostico de concurrencia completado." -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Cyan
