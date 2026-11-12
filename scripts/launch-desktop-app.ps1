# Kite Code - Launch on User Desktop (WinSta0\Default)
param (
    [switch]$Wait = $false,
    [switch]$Rebuild = $false,
    [switch]$NativeDeck = $false,
    [switch]$KillDaemon = $false
)

$ErrorActionPreference = "Stop"

$ProjectRoot = if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path } else { (Get-Location).Path }
$SrcTauriDir = Join-Path $ProjectRoot "src-tauri"
$DistDir = Join-Path $ProjectRoot "dist"
$SrcDir = Join-Path $ProjectRoot "src"

# Prefer E:\Temp when that drive is present so Rust has room to compile.
# Add-Type also writes its generated source there, so a missing drive must not replace TEMP.
$originalTemp = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath().TrimEnd('\') }
$originalTmp = if ($env:TMP) { $env:TMP } else { $originalTemp }
if (Test-Path -LiteralPath "E:\") {
    $buildTemp = "E:\Temp"
    New-Item -ItemType Directory -Force -Path $buildTemp | Out-Null
    $env:TEMP = $buildTemp
    $env:TMP = $buildTemp
} else {
    if (-not (Test-Path -LiteralPath $originalTemp)) {
        New-Item -ItemType Directory -Force -Path $originalTemp | Out-Null
    }
    $env:TEMP = $originalTemp
    $env:TMP = $originalTmp
}
$env:WEBVIEW2_USER_DATA_FOLDER = "$env:LOCALAPPDATA\dev.kite.code.dev\EBWebView"

# 1. Clean up old DEV GUI processes and locks (preserves installed production app and live kite-core --daemon)
Write-Host "[1/4] Limpiando instancias GUI de desarrollo previas y bloqueos WebView2..." -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name = 'kite-code.exe' OR Name = 'kite-gpui.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $isDevPath = $_.ExecutablePath -and (($_.ExecutablePath -like "*\target\debug\*") -or ($_.ExecutablePath -like "*\crates\kite-gpui\target\*"))
    $isDaemon = $_.CommandLine -and ($_.CommandLine -like "*--daemon*")
    $isDevPath -and ($KillDaemon -or (-not $isDaemon))
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Also terminate orphaned dev WebView2 processes to release EBWebView files
Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and ($_.CommandLine -like "*dev.kite.code.dev*")
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Milliseconds 600

$devLockPath = "$env:LOCALAPPDATA\dev.kite.code.dev\EBWebView\Default\LOCK"
if (Test-Path $devLockPath) {
    Remove-Item $devLockPath -Force -ErrorAction SilentlyContinue
}
$devEbLockPath = "$env:LOCALAPPDATA\dev.kite.code.dev\EBWebView\EBWebView\Default\LOCK"
if (Test-Path $devEbLockPath) {
    Remove-Item $devEbLockPath -Force -ErrorAction SilentlyContinue
}

$KiteViteUrl = "http://127.0.0.1:1420/"

function Test-KiteVite {
    try {
        $resp = Invoke-WebRequest -Uri $KiteViteUrl -UseBasicParsing -TimeoutSec 2
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Stop-KiteVitePort {
    Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

function Start-KiteViteProcess {
    $viteJs = Join-Path $ProjectRoot "node_modules\vite\bin\vite.js"
    if (-not (Test-Path -LiteralPath $viteJs)) {
        Write-Error "No se encontró Vite en $viteJs. Ejecuta npm install."
        exit 1
    }
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Error "node.exe no está en PATH; no se puede iniciar Vite."
        exit 1
    }
    if (-not $script:desktopLauncherReady) {
        Write-Error "DesktopManager no está listo; Vite no sobreviviría al cierre de npm."
        exit 1
    }
    Write-Host "Iniciando servidor Vite (sin consola, independiente de npm)..." -ForegroundColor Yellow
    $viteArgs = '"{0}" --host 127.0.0.1 --port 1420' -f $viteJs
    $vitePid = [DesktopManager]::LaunchHidden($nodeCmd.Source, $viteArgs, $ProjectRoot)
    Write-Host "Vite lanzado con PID $vitePid." -ForegroundColor Yellow
}

function Wait-KiteVite {
    param([int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-KiteVite) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Ensure-KiteVite {
    if ($Rebuild) {
        Stop-KiteVitePort
        Start-Sleep -Milliseconds 300
    } elseif (Test-KiteVite) {
        Write-Host "Servidor Vite ya activo en $KiteViteUrl" -ForegroundColor Green
        return
    }
    if (-not (Test-KiteVite)) {
        Stop-KiteVitePort
        Start-Sleep -Milliseconds 300
        Start-KiteViteProcess
        if (-not (Wait-KiteVite -TimeoutSec 30)) {
            Write-Error "No se pudo conectar al servidor Vite en $KiteViteUrl."
            exit 1
        }
    }
    Write-Host "Servidor Vite listo en $KiteViteUrl" -ForegroundColor Green
}

# 2. Compile C# launcher first — Vite must break away from npm's job or :1420 dies when npm exits.
Write-Host "[2/4] Preparando lanzador para el escritorio interactivo (WinSta0\Default)..." -ForegroundColor Cyan
$csharpSource = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class DesktopManager {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    public delegate bool EnumDesktopWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, int dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumDesktopWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumDesktopWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    public static int Launch(string appPath, string workingDir) {
        return LaunchWithArgs(appPath, null, workingDir);
    }

    public static int LaunchWithArgs(string appPath, string args, string workingDir) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = @"WinSta0\Default";
        string cmdLine = string.IsNullOrEmpty(args) ? null : string.Format("\"{0}\" {1}", appPath, args);

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool success = CreateProcess(
            appPath,
            cmdLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            0x01000200, // CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP
            IntPtr.Zero,
            workingDir,
            ref si,
            out pi
        );

        if (!success) {
            success = CreateProcess(
                appPath,
                cmdLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                0x00000200,
                IntPtr.Zero,
                workingDir,
                ref si,
                out pi
            );
        }

        if (!success) {
            int err = Marshal.GetLastWin32Error();
            throw new Exception("Error al crear proceso en Default Desktop: " + err);
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }

    public static int LaunchHidden(string appPath, string args, string workingDir) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = @"WinSta0\Default";
        si.dwFlags = 0x00000001; // STARTF_USESHOWWINDOW
        si.wShowWindow = 0; // SW_HIDE
        string cmdLine = string.IsNullOrEmpty(args) ? null : string.Format("\"{0}\" {1}", appPath, args);

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool success = CreateProcess(
            appPath,
            cmdLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            0x09000208, // BREAKAWAY_FROM_JOB | NEW_PROCESS_GROUP | CREATE_NO_WINDOW | DETACHED_PROCESS
            IntPtr.Zero,
            workingDir,
            ref si,
            out pi
        );

        if (!success) {
            success = CreateProcess(
                appPath,
                cmdLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                0x08000208, // NEW_PROCESS_GROUP | CREATE_NO_WINDOW | DETACHED_PROCESS
                IntPtr.Zero,
                workingDir,
                ref si,
                out pi
            );
        }

        if (!success) {
            int err = Marshal.GetLastWin32Error();
            throw new Exception("Error al crear proceso oculto: " + err);
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }

    public static List<string> CheckAndFocus(uint targetPid) {
        var list = new List<string>();
        EnumDesktopWindowsProc callback = (hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetPid) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                string title = sb.ToString();
                if (!string.IsNullOrEmpty(title) && !title.Contains("IME") && IsWindowVisible(hWnd)) {
                    ShowWindow(hWnd, 9); // SW_RESTORE
                    SetForegroundWindow(hWnd);
                }
                list.Add(string.Format("HWND: 0x{0:X}, Visible: {1}, Title: '{2}'", hWnd.ToInt64(), IsWindowVisible(hWnd), sb));
            }
            return true;
        };

        IntPtr h = OpenDesktop("Default", 0, false, 0x0041);
        if (h != IntPtr.Zero) {
            EnumDesktopWindows(h, callback, IntPtr.Zero);
            CloseDesktop(h);
        }
        if (list.Count == 0) {
            EnumWindows(callback, IntPtr.Zero);
        }
        return list;
    }
}
"@
$script:desktopLauncherReady = $false
try {
    Add-Type -TypeDefinition $csharpSource -ErrorAction Stop
    $script:desktopLauncherReady = $true
} catch {
    Write-Host "No se pudo preparar el lanzador de escritorio ($($_.Exception.Message)). Se usará Start-Process." -ForegroundColor Yellow
}

# 3. Vite must answer on 127.0.0.1:1420 before the WebView opens (skipped for -NativeDeck)
if (-not $NativeDeck) {
    Write-Host "[3/4] Verificando servidor frontend en $KiteViteUrl ..." -ForegroundColor Cyan
    Ensure-KiteVite
} else {
    Write-Host "[3/4] Modo NativeDeck activo (sin Vite ni WebView2 en el camino base)..." -ForegroundColor Green
}

# 3b. Verify Rust backend freshness for real-time dev mode (or select NativeDeck binary)
$launchArgs = $null
if ($NativeDeck) {
    $gpuiRelease = Join-Path $ProjectRoot "crates\kite-gpui\target\release\kite-gpui.exe"
    $gpuiDebug = Join-Path $ProjectRoot "crates\kite-gpui\target\debug\kite-gpui.exe"
    if ($Rebuild -or ((-not (Test-Path $gpuiRelease)) -and (-not (Test-Path $gpuiDebug)))) {
        Write-Host "Compilando Native GPU Terminal Deck (crates/kite-gpui --features gpu)..." -ForegroundColor Yellow
        cargo build --release --features gpu --manifest-path (Join-Path $ProjectRoot "crates\kite-gpui\Cargo.toml") --offline
    }
    $binary = if (Test-Path $gpuiRelease) { $gpuiRelease } else { $gpuiDebug }
    $launchArgs = "--window"
    Write-Host "Native Deck listo: $binary $launchArgs" -ForegroundColor Green
} else {
    $binary = Join-Path $SrcTauriDir "target\debug\kite-code.exe"
    $devMarker = Join-Path $SrcTauriDir "target\debug\.dev-mode"
    $needsBuild = $false

    if ($Rebuild -or (-not (Test-Path $binary)) -or (-not (Test-Path $devMarker))) {
        $needsBuild = $true
    } else {
        $binTime = (Get-Item $binary).LastWriteTime
        $newerSrc = Get-ChildItem (Join-Path $SrcTauriDir "src") -Recurse -Filter "*.rs" | Where-Object { $_.LastWriteTime -gt $binTime }
        $cargoToml = Join-Path $SrcTauriDir "Cargo.toml"
        $cargoTomlNewer = if (Test-Path $cargoToml) { (Get-Item $cargoToml).LastWriteTime -gt $binTime } else { $false }
        if ($newerSrc -or $cargoTomlNewer) {
            $needsBuild = $true
        }
    }

    if ($needsBuild) {
        Write-Host "Liberando ejecutable debug previo (incluyendo --daemon si estaba activo) para re-enlazar Rust..." -ForegroundColor Yellow
        Get-Process -Name "*kite*" -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and ($_.Path -like "*\target\debug\*")
        } | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300

        Write-Host "Compilando backend en modo desarrollo en tiempo real (Vite devUrl activo, sin custom-protocol)..." -ForegroundColor Yellow
        Push-Location $SrcTauriDir
        cargo build --bin kite-code --bin kite --no-default-features
        Pop-Location
        if (-not (Test-Path $binary)) {
            Write-Error "No se pudo compilar el ejecutable $binary."
            exit 1
        }
        Set-Content -Path $devMarker -Value "dev-hmr" -Force
    } else {
        Write-Host "Backend listo (Vite HMR activo, kite-core --daemon preservado)." -ForegroundColor Green
    }
}

if (-not $NativeDeck) {
    Write-Host "Reconfirmando Vite antes de abrir la ventana..." -ForegroundColor Cyan
    Ensure-KiteVite
}

Write-Host "[4/4] Lanzando $binary $launchArgs en la pantalla del usuario (WinSta0\Default)..." -ForegroundColor Cyan
$appPid = 0
try {
    if (-not $desktopLauncherReady) {
        throw "DesktopManager no está cargado"
    }
    $appPid = [DesktopManager]::LaunchWithArgs($binary, $launchArgs, $ProjectRoot)
    Write-Host "Proceso lanzado con PID: $appPid en WinSta0\Default." -ForegroundColor Green
} catch {
    Write-Host "DesktopManager::LaunchWithArgs ($($_.Exception.Message)) -> usando Start-Process..." -ForegroundColor Yellow
    if ($launchArgs) {
        $proc = Start-Process -FilePath $binary -ArgumentList $launchArgs -WorkingDirectory $ProjectRoot -PassThru
    } else {
        $proc = Start-Process -FilePath $binary -WorkingDirectory $ProjectRoot -PassThru
    }
    $appPid = $proc.Id
}

# Wait a moment and check for the window with polling
$found = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if ($appPid -le 0) {
        $devProc = Get-Process -Name "kite-code" -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and ($_.Path -like "*\target\debug\*")
        } | Select-Object -First 1
        if ($devProc) { $appPid = $devProc.Id }
    }
    if ($appPid -gt 0 -and $desktopLauncherReady) {
        $windows = [DesktopManager]::CheckAndFocus($appPid)
        if ($windows.Count -gt 0) {
            Write-Host "¡Ventana detectada y enfocada en pantalla (PID: $appPid)!" -ForegroundColor Green
            $windows | ForEach-Object { Write-Host " - $_" -ForegroundColor Green }
            $found = $true
            break
        }
    } elseif ($appPid -gt 0) {
        $alive = Get-Process -Id $appPid -ErrorAction SilentlyContinue
        if ($alive) {
            Write-Host "Proceso lanzado (PID: $appPid)." -ForegroundColor Green
            $found = $true
            break
        }
    }
}

if (-not $found) {
    Write-Host "Proceso activo (PID: $appPid). Si la ventana tarda en responder, revisa el Administrador de Tareas." -ForegroundColor Yellow
}

# Only keep terminal open if explicitly requested with -Wait
if ($Wait) {
    $proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "Manteniendo el proceso vivo..." -ForegroundColor Green
        $proc.WaitForExit()
        Write-Host "La ventana de Kite Code se ha cerrado." -ForegroundColor Yellow
    }
}
