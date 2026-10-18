# Kite Code - Launch on User Desktop (WinSta0\Default)
param (
    [switch]$Wait = $false,
    [switch]$Rebuild = $false
)

$ErrorActionPreference = "Stop"

$ProjectRoot = if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path } else { (Get-Location).Path }
$SrcTauriDir = Join-Path $ProjectRoot "src-tauri"
$DistDir = Join-Path $ProjectRoot "dist"
$SrcDir = Join-Path $ProjectRoot "src"

# Configure temporary build directory on drive E: to guarantee ample space during compilation
$env:TEMP = "E:\Temp"
$env:TMP = "E:\Temp"

# 1. Clean up old DEV processes and locks (preserves installed production app)
Write-Host "[1/4] Limpiando instancias de desarrollo previas y bloqueos WebView2..." -ForegroundColor Cyan
Get-Process -Name "*kite*" -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and ($_.Path -like "*\target\debug\*")
} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

$devLockPath = "$env:LOCALAPPDATA\dev.kite.code.dev\EBWebView\Default\LOCK"
if (Test-Path $devLockPath) {
    Remove-Item $devLockPath -Force -ErrorAction SilentlyContinue
}
$prodLockPath = "$env:LOCALAPPDATA\dev.kite.code\EBWebView\Default\LOCK"
if (Test-Path $prodLockPath) {
    Remove-Item $prodLockPath -Force -ErrorAction SilentlyContinue
}

# 2. Check if Vite is running on port 1420, if not start it
Write-Host "[2/4] Verificando servidor frontend en http://127.0.0.1:1420..." -ForegroundColor Cyan
$viteRunning = $false
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:1420" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($resp.StatusCode -eq 200) { $viteRunning = $true }
} catch {}

if (-not $viteRunning) {
    Write-Host "Iniciando servidor Vite..." -ForegroundColor Yellow
    $viteProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev" -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
    
    # Wait for Vite to be ready
    $retries = 20
    while ($retries -gt 0) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:1420" -UseBasicParsing -TimeoutSec 1 -ErrorAction SilentlyContinue
            if ($resp.StatusCode -eq 200) {
                $viteRunning = $true
                break
            }
        } catch {}
        $retries--
    }
    if (-not $viteRunning) {
        Write-Error "No se pudo conectar al servidor Vite en http://127.0.0.1:1420."
        exit 1
    }
    Write-Host "Servidor Vite listo en http://127.0.0.1:1420." -ForegroundColor Green
} else {
    Write-Host "Servidor Vite ya activo." -ForegroundColor Green
}

# 3. Compile C# InteractiveLauncher for WinSta0\Default
Write-Host "[3/4] Preparando lanzador para el escritorio interactivo (WinSta0\Default)..." -ForegroundColor Cyan
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
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = @"WinSta0\Default";

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool success = CreateProcess(
            appPath,
            null,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            0x00000200,
            IntPtr.Zero,
            workingDir,
            ref si,
            out pi
        );

        if (!success) {
            int err = Marshal.GetLastWin32Error();
            throw new Exception("Error al crear proceso en Default Desktop: " + err);
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }

    public static List<string> CheckAndFocus(uint targetPid) {
        var list = new List<string>();
        IntPtr h = OpenDesktop("Default", 0, false, 0x01FF);
        if (h != IntPtr.Zero) {
            EnumDesktopWindows(h, (hWnd, lParam) => {
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
            }, IntPtr.Zero);
            CloseDesktop(h);
        }
        return list;
    }
}
"@
Add-Type -TypeDefinition $csharpSource -ErrorAction SilentlyContinue

# 3b. Verify Rust backend freshness for real-time dev mode
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
    Write-Host "Compilando backend en modo desarrollo en tiempo real (Vite devUrl activo, sin custom-protocol)..." -ForegroundColor Yellow
    Push-Location $SrcTauriDir
    cargo build --bin kite-code --no-default-features
    Pop-Location
    if (-not (Test-Path $binary)) {
        Write-Error "No se pudo compilar el ejecutable $binary."
        exit 1
    }
    Set-Content -Path $devMarker -Value "dev-hmr" -Force
} else {
    Write-Host "Backend listo (Vite HMR activo, sin necesidad de recompilar Rust)." -ForegroundColor Green
}

Write-Host "[4/4] Lanzando $binary en la pantalla del usuario (WinSta0\Default)..." -ForegroundColor Cyan
Start-Process "explorer.exe" -ArgumentList $binary

# Wait a moment and check for the window with polling
$found = $false
$appPid = 0
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 600
    $devProc = Get-Process -Name "kite-code" -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and ($_.Path -like "*\target\debug\*")
    } | Select-Object -First 1
    if ($devProc) {
        $appPid = $devProc.Id
        $windows = [DesktopManager]::CheckAndFocus($appPid)
        if ($windows.Count -gt 0) {
            Write-Host "¡Ventana detectada y enfocada en pantalla (PID: $appPid)!" -ForegroundColor Green
            $windows | ForEach-Object { Write-Host " - $_" -ForegroundColor Green }
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
