# monitor-hangs.ps1
# Monitor externo en tiempo real para detectar y medir congelamientos (UI hangs) en Kite Code.
# IMPORTANTE: Ejecutar en una ventana EXTERNA de PowerShell (fuera de la aplicacion).

param (
    [int]$IntervalMs = 400,
    [int]$HangThresholdMs = 1000,
    [string]$LogFile = "$PSScriptRoot\hangs.log"
)

# Compilar helper C# para medir respuesta en WinSta0\Default
$csharpSource = @"
using System;
using System.Collections.Generic;
using System.Threading;
using System.Runtime.InteropServices;
using System.Text;

public class KiteHangDetector {
    public delegate bool EnumDesktopWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, int dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumDesktopWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsHungAppWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint Msg,
        IntPtr wParam,
        IntPtr lParam,
        uint fuFlags,
        uint uTimeout,
        out IntPtr lpdwResult
    );

    public struct WindowTarget {
        public IntPtr Hwnd;
        public uint Pid;
        public string Title;
        public string ClassName;
        public bool Visible;
    }

    public static List<WindowTarget> GetKiteWindows() {
        var targets = new List<WindowTarget>();
        IntPtr hDesktop = OpenDesktop("Default", 0, false, 0x01FF);
        if (hDesktop != IntPtr.Zero) {
            EnumDesktopWindows(hDesktop, (hWnd, lParam) => {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                var sbTitle = new StringBuilder(256);
                GetWindowText(hWnd, sbTitle, 256);
                string title = sbTitle.ToString();

                var sbClass = new StringBuilder(256);
                GetClassName(hWnd, sbClass, 256);
                string className = sbClass.ToString();

                bool visible = IsWindowVisible(hWnd);

                if (title.IndexOf("Kite Code", StringComparison.OrdinalIgnoreCase) >= 0) {
                    targets.Add(new WindowTarget {
                        Hwnd = hWnd,
                        Pid = pid,
                        Title = title,
                        ClassName = className,
                        Visible = visible
                    });
                }
                return true;
            }, IntPtr.Zero);
            CloseDesktop(hDesktop);
        }
        return targets;
    }

    public static void ProbeWindow(IntPtr hWnd, uint timeoutMs, out bool isHung, out double elapsedMs, out bool timedOut) {
        bool localHung = false;
        double localElapsed = 0;
        bool localTimedOut = false;

        var t = new Thread(() => {
            IntPtr hDesktop = OpenDesktop("Default", 0, false, 0x01FF);
            if (hDesktop != IntPtr.Zero) {
                SetThreadDesktop(hDesktop);
            }
            localHung = IsHungAppWindow(hWnd);
            IntPtr res;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            IntPtr ret = SendMessageTimeout(hWnd, 0x0000 /* WM_NULL */, IntPtr.Zero, IntPtr.Zero, 0 /* SMTO_NORMAL */, timeoutMs, out res);
            sw.Stop();
            localElapsed = sw.Elapsed.TotalMilliseconds;
            localTimedOut = (ret == IntPtr.Zero);
        });
        t.Start();
        t.Join();

        isHung = localHung;
        elapsedMs = localElapsed;
        timedOut = localTimedOut;
    }
}
"@

Add-Type -TypeDefinition $csharpSource -Language CSharp -ErrorAction SilentlyContinue

Clear-Host
Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host " [KITE CODE] MONITOR DE CONGELAMIENTOS Y RESPUESTA DE UI (WINDOWS)" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host " - Frecuencia de muestreo: $IntervalMs ms" -ForegroundColor Gray
Write-Host " - Umbral de congelamiento: $HangThresholdMs ms" -ForegroundColor Gray
Write-Host " - Archivo de registro: $LogFile" -ForegroundColor Gray
Write-Host " - Presiona Ctrl + C para detener el monitor." -ForegroundColor Yellow
Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host ""

$header = "[{0:yyyy-MM-dd HH:mm:ss.fff}] === INICIO DE SESION DE MONITOREO ===" -f (Get-Date)
Add-Content -Path $LogFile -Value $header -Encoding UTF8

$windowStates = @{}

function Get-ProcessModeName($proc) {
    if (-not $proc) { return "Desconocido" }
    if ($proc.Path -like "*\target\debug\*") { return "DEV (target\debug)" }
    if ($proc.Path -like "*\Kite Code\kite-code.exe*") { return "PROD (instalado)" }
    return "OTRO ($($proc.Name))"
}

function Snapshot-Details($pidNum) {
    $proc = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
    $wsMb = if ($proc) { [math]::Round($proc.WorkingSet64 / 1MB, 1) } else { 0 }
    $threads = if ($proc) { $proc.Threads.Count } else { 0 }
    $cpuSec = if ($proc) { [math]::Round($proc.TotalProcessorTime.TotalSeconds, 1) } else { 0 }
    
    # Renderers hijos de WebView2
    $renderers = Get-CimInstance Win32_Process -Filter "ParentProcessId = $pidNum" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*webview*" }
    $renderersCount = if ($renderers) { ($renderers | Measure-Object).Count } else { 0 }
    
    return "RAM: ${wsMb}MB | CPU: ${cpuSec}s | Hilos: $threads | WebViews Hijos: $renderersCount"
}

try {
    while ($true) {
        $now = Get-Date
        $nowStr = $now.ToString("yyyy-MM-dd HH:mm:ss.fff")
        
        $allTargets = [KiteHangDetector]::GetKiteWindows()
        $targets = @()
        if ($allTargets) {
            foreach ($t in $allTargets) {
                $p = Get-Process -Id $t.Pid -ErrorAction SilentlyContinue
                if ($p -and ($p.ProcessName -match "kite-code") -and ($t.Visible -or $t.Title -match "Kite Code")) {
                    $targets += $t
                }
            }
        }

        if (-not $targets -or $targets.Count -eq 0) {
            $timeNow = $now.ToString("HH:mm:ss")
            Write-Host -NoNewline "`r[$timeNow] Buscando ventanas activas de Kite Code (Prod/Dev)...        "
            Start-Sleep -Milliseconds 1000
            continue
        }

        foreach ($target in $targets) {
            $hwndKey = "0x{0:X}" -f $target.Hwnd.ToInt64()
            $proc = Get-Process -Id $target.Pid -ErrorAction SilentlyContinue
            $mode = Get-ProcessModeName $proc

            $isHung = $false
            $latencyMs = 0.0
            $timedOut = $false
            [KiteHangDetector]::ProbeWindow($target.Hwnd, [uint32]$HangThresholdMs, [ref]$isHung, [ref]$latencyMs, [ref]$timedOut)

            $isFrozen = $isHung -or $timedOut -or ($latencyMs -ge $HangThresholdMs)

            if (-not $windowStates.ContainsKey($hwndKey)) {
                $windowStates[$hwndKey] = @{
                    IsFrozen = $false
                    FreezeStart = $null
                    ReportedMode = $mode
                }
            }

            $state = $windowStates[$hwndKey]

            if ($isFrozen) {
                if (-not $state.IsFrozen) {
                    # INICIO DEL CONGELAMIENTO
                    $state.IsFrozen = $true
                    $state.FreezeStart = $now
                    $diag = Snapshot-Details $target.Pid
                    $latStr = $latencyMs.ToString("F0")
                    $targetPid = $target.Pid

                    $alertMsg = "[$nowStr] [CONGELAMIENTO DETECTADO] Ventana: $hwndKey ($mode, PID $targetPid) | Latencia: ${latStr}ms | IsHung: $isHung | $diag"
                    
                    Write-Host "`n==========================================================================" -ForegroundColor Red
                    Write-Host " >> $alertMsg" -ForegroundColor Red
                    Write-Host "==========================================================================" -ForegroundColor Red
                    Add-Content -Path $LogFile -Value $alertMsg -Encoding UTF8
                } else {
                    $durSoFar = ($now - $state.FreezeStart).TotalSeconds
                    $durStr = $durSoFar.ToString("F1")
                    $timeNow = $now.ToString("HH:mm:ss")
                    Write-Host -NoNewline "`r[$timeNow] CONGELADO ($mode, PID $($target.Pid)): ${durStr}s transcurridos...        " -ForegroundColor DarkRed
                }
            } else {
                if ($state.IsFrozen) {
                    # CONGELAMIENTO RECUPERADO
                    $totalDurationSec = ($now - $state.FreezeStart).TotalSeconds
                    $durTotalStr = $totalDurationSec.ToString("F2")
                    $state.IsFrozen = $false
                    $state.FreezeStart = $null
                    $diag = Snapshot-Details $target.Pid
                    $latStr = $latencyMs.ToString("F1")
                    $targetPid = $target.Pid

                    $recoveryMsg = "[$nowStr] [RECUPERADO] Ventana: $hwndKey ($mode, PID $targetPid) | DURACION CONGELAMIENTO: ${durTotalStr} seg | Latencia actual: ${latStr}ms | $diag"
                    Write-Host "`n--------------------------------------------------------------------------" -ForegroundColor Green
                    Write-Host " >> $recoveryMsg" -ForegroundColor Green
                    Write-Host "--------------------------------------------------------------------------`n" -ForegroundColor Green
                    Add-Content -Path $LogFile -Value $recoveryMsg -Encoding UTF8
                } else {
                    # ESTADO NORMAL
                    $displayLatency = if ($latencyMs -lt 1) { "<1ms" } else { "{0:F1}ms" -f $latencyMs }
                    $targetPid = $target.Pid
                    $timeNow = $now.ToString("HH:mm:ss")
                    Write-Host -NoNewline "`r[$timeNow] OK: $mode (PID $targetPid) | Latencia UI: $displayLatency | HWND: $hwndKey    "
                }
            }
        }

        Start-Sleep -Milliseconds $IntervalMs
    }
} finally {
    Write-Host "`n`n[MONITOR] Sesion finalizada por el usuario." -ForegroundColor Yellow
    Add-Content -Path $LogFile -Value "[{0:yyyy-MM-dd HH:mm:ss.fff}] === SESION FINALIZADA ===" -f (Get-Date) -Encoding UTF8
}
