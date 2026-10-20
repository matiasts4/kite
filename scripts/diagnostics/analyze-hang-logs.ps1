# analyze-hang-logs.ps1
# Correlaciona los congelamientos registrados en hangs.log con los logs internos de Kite Code (app.log).

param (
    [string]$HangsLog = "$PSScriptRoot\hangs.log",
    [int]$ContextSeconds = 5
)

Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host " [KITE CODE] ANALIZADOR Y CORRELACIONADOR DE CONGELAMIENTOS" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $HangsLog)) {
    Write-Host "No se encontro el archivo de registro '$HangsLog'." -ForegroundColor Yellow
    Write-Host "Asegurate de ejecutar primero 'monitor-hangs.ps1' para capturar congelamientos." -ForegroundColor Yellow
    exit 0
}

$hangEntries = Get-Content $HangsLog | Where-Object { $_ -match "\[CONGELAMIENTO DETECTADO\]|\[RECUPERADO\]" }

if (-not $hangEntries) {
    Write-Host "No se encontraron eventos de congelamiento en '$HangsLog'." -ForegroundColor Green
    Write-Host "La aplicacion se ha mantenido respondiendo normalmente durante la monitorizacion." -ForegroundColor Green
    exit 0
}

Write-Host "Se encontraron $($hangEntries.Count) eventos en '$HangsLog':" -ForegroundColor Yellow
Write-Host ""

$logProd = "$env:LOCALAPPDATA\Kite Code\app.log"
$logDev = "$env:LOCALAPPDATA\Kite Code Dev\app.log"

foreach ($entry in $hangEntries) {
    Write-Host "--------------------------------------------------------------------------" -ForegroundColor DarkCyan
    Write-Host $entry -ForegroundColor Yellow

    if ($entry -match "\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]") {
        $eventTimeStr = $Matches[1]
        $eventTime = [DateTime]::ParseExact($eventTimeStr, "yyyy-MM-dd HH:mm:ss.fff", $null)
        $startWindow = $eventTime.AddSeconds(-$ContextSeconds)
        $endWindow = $eventTime.AddSeconds($ContextSeconds)

        $startEpoch = [DateTimeOffset]::new($startWindow).ToUnixTimeMilliseconds()
        $endEpoch = [DateTimeOffset]::new($endWindow).ToUnixTimeMilliseconds()

        $targetLog = if ($entry -match "DEV") { $logDev } else { $logProd }
        $targetName = if ($entry -match "DEV") { "DEV" } else { "PROD" }

        Write-Host "  -> Correlacionando con app.log de $targetName (Ventana: -${ContextSeconds}s a +${ContextSeconds}s)..." -ForegroundColor Gray

        if (Test-Path $targetLog) {
            $relevantLines = Get-Content $targetLog | Where-Object {
                if ($_ -match "^\[(\d+)\]") {
                    $ts = [int64]$Matches[1]
                    return ($ts -ge $startEpoch -and $ts -le $endEpoch)
                }
                return $false
            }

            if ($relevantLines) {
                Write-Host "  [EVENTOS EN APP.LOG DURANTE EL CONGELAMIENTO]:" -ForegroundColor Magenta
                $relevantLines | Select-Object -First 20 | ForEach-Object {
                    Write-Host "    $_" -ForegroundColor DarkGray
                }
                if ($relevantLines.Count -gt 20) {
                    Write-Host "    ... y $($relevantLines.Count - 20) lineas mas." -ForegroundColor DarkGray
                }
            } else {
                Write-Host "  [ALERTA]: CERO eventos en app.log durante este intervalo." -ForegroundColor DarkYellow
                Write-Host "  Esto indica que el bucle de eventos de la aplicacion estuvo TOTALMENTE DETENIDO / DORMIDO." -ForegroundColor DarkYellow
            }
        }
    }
}

Write-Host ""
Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host " Analisis finalizado." -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Cyan
