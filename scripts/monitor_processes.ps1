# monitor_processes.ps1 - Auditor en tiempo real de creacion de procesos
# Registra cada proceso creado con marca de tiempo, PID, PID padre, arbol genealogico y linea de comandos completa.

param (
    [string]$LogFile = "$PSScriptRoot\terminal_monitor.log"
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " [MONITOR DE PROCESOS] Auditor en tiempo real v2 iniciado" -ForegroundColor Green
Write-Host " Archivo de log: $LogFile" -ForegroundColor Cyan
Write-Host " Presiona Ctrl+C para detener." -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$initMessage = "[{0:yyyy-MM-dd HH:mm:ss.fff}] === INICIO DE SESION DE AUDITORIA DE PROCESOS (v2) ===" -f (Get-Date)
Add-Content -Path $LogFile -Value $initMessage -Encoding UTF8

# Diccionario en memoria para rastrear genealogia de procesos (PID -> Info)
$known = @{}

# Precargar procesos activos actualmente para que los padres ya existan en memoria
try {
    Get-CimInstance Win32_Process | ForEach-Object {
        $procId = [int]$_.ProcessId
        $known[$procId] = @{
            Name = [string]$_.Name
            CommandLine = [string]$_.CommandLine
            ParentPid = [int]$_.ParentProcessId
        }
    }
    Write-Host "[INIT] Precargados $($known.Count) procesos activos en memoria." -ForegroundColor Gray
} catch {
    Write-Host "[WARN] No se pudieron precargar procesos existentes: $_" -ForegroundColor DarkGray
}

$query = "SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'"
$watcher = New-Object System.Management.ManagementEventWatcher($query)

try {
    while ($true) {
        $event = $watcher.WaitForNextEvent()
        $target = $event.TargetInstance
        $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
        
        $pidNum = [int]$target.ProcessId
        $ppidNum = [int]$target.ParentProcessId
        $name = [string]$target.Name
        $cmdLine = [string]$target.CommandLine

        # Guardar en cache conocido
        $known[$pidNum] = @{
            Name = $name
            CommandLine = $cmdLine
            ParentPid = $ppidNum
        }
        
        # Determinar nombre del padre
        $parentName = "Desconocido"
        $parentCmd = ""
        if ($known.ContainsKey($ppidNum)) {
            $parentInfo = $known[$ppidNum]
            $parentName = [string]$parentInfo.Name
            $parentCmd = [string]$parentInfo.CommandLine
        } else {
            try {
                $parentProc = Get-Process -Id $ppidNum -ErrorAction SilentlyContinue
                if ($parentProc) {
                    $parentName = $parentProc.ProcessName
                }
            } catch {}
        }

        # Determinar abuelo si existe en memoria
        $ancestorChain = "[PADRE: $ppidNum ($parentName)]"
        if ($known.ContainsKey($ppidNum)) {
            $pInfo = $known[$ppidNum]
            $gppid = [int]$pInfo.ParentPid
            if ($gppid -gt 0 -and $known.ContainsKey($gppid)) {
                $gpInfo = $known[$gppid]
                $gpName = [string]$gpInfo.Name
                $ancestorChain = $ancestorChain + " <- [ABUELO: $gppid ($gpName)]"
                $ggppid = [int]$gpInfo.ParentPid
                if ($ggppid -gt 0 -and $known.ContainsKey($ggppid)) {
                    $ggpInfo = $known[$ggppid]
                    $ggpName = [string]$ggpInfo.Name
                    $ancestorChain = $ancestorChain + " <- [BISABUELO: $ggppid ($ggpName)]"
                }
            }
        }

        $entry = "[$now] [PID: $pidNum] $ancestorChain $name | COMANDO: $cmdLine"
        
        # Detectar si es una consola, terminal o proceso relacionado con kite/antigravity/powershell
        $isTerminalOrConsole = $name -match "(?i)(powershell\.exe|pwsh\.exe|WindowsTerminal\.exe|OpenConsole\.exe|conhost\.exe|cmd\.exe)"
        $isAgentOrApp = ($name -match "(?i)(agy\.exe|kite-code\.exe|node\.exe|tasklist\.exe|netstat\.exe|curl\.exe)") -or
                        ($cmdLine -match "(?i)(context-mode|codegraph|quota|terminal|antigravity)")

        if ($isTerminalOrConsole) {
            Write-Host "[$now] *** TERMINAL/CONSOLA DETECTADA ***" -ForegroundColor Magenta
            Write-Host "  Proceso: $name (PID $pidNum)" -ForegroundColor Yellow
            Write-Host "  Arbol:   $ancestorChain" -ForegroundColor Cyan
            Write-Host "  Comando: $cmdLine" -ForegroundColor White
            if ($parentCmd) {
                Write-Host "  Cmd Padre: $parentCmd" -ForegroundColor DarkGray
            }
            Add-Content -Path $LogFile -Value "[VENTANA/TERMINAL] $entry" -Encoding UTF8
            if ($parentCmd) {
                Add-Content -Path $LogFile -Value "                   |-- [CMD PADRE]: $parentCmd" -Encoding UTF8
            }
        } elseif ($isAgentOrApp) {
            Write-Host "[$now] AGENTE/APP: $name (PID $pidNum, $ancestorChain)" -ForegroundColor DarkYellow
            Add-Content -Path $LogFile -Value "[ALERTA] $entry" -Encoding UTF8
        } else {
            Add-Content -Path $LogFile -Value "         $entry" -Encoding UTF8
        }
    }
} finally {
    $watcher.Stop()
    $watcher.Dispose()
    Write-Host "`n[MONITOR] Auditoria detenida." -ForegroundColor Red
}
