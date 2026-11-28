# Kite Code - Automated Silent Update and Launch Script
Write-Host "Stopping running Kite Code instances..." -ForegroundColor Cyan
Stop-Process -Name "*kite-code*" -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name like '%webview2%'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*dev.kite.code*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# Clean up stale WebView2 locks if present
foreach ($lockPath in @(
    "$env:LOCALAPPDATA\dev.kite.code\EBWebView\Default\LOCK",
    "$env:LOCALAPPDATA\dev.kite.code\EBWebView\EBWebView\Default\LOCK"
)) {
    if (Test-Path -LiteralPath $lockPath) {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}

function Start-OnInteractiveDesktop {
    param (
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    $workDir = Split-Path -Parent $FilePath

    # Sandboxed agent shells sometimes set TEMP=C:\WINDOWS\TEMP, which breaks Add-Type compilation.
    if ([string]::IsNullOrWhiteSpace($env:TEMP) -or -not (Test-Path -LiteralPath $env:TEMP) -or ($env:TEMP -like "*\Windows\Temp*")) {
        $writableTemp = Join-Path $env:LOCALAPPDATA "Temp"
        if (-not (Test-Path -LiteralPath $writableTemp)) {
            New-Item -ItemType Directory -Force -Path $writableTemp | Out-Null
        }
        $env:TEMP = $writableTemp
        $env:TMP = $writableTemp
    }

    if (-not ("KiteDesktopLauncher" -as [type])) {
        $launcherSource = @"
using System;
using System.Runtime.InteropServices;

public class KiteDesktopLauncher {
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

    public static int Launch(string appPath, string workingDir) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = @"WinSta0\Default";
        string cmdLine = string.Format("\"{0}\"", appPath);
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
                0x00000200, // CREATE_NEW_PROCESS_GROUP
                IntPtr.Zero,
                workingDir,
                ref si,
                out pi
            );
        }

        if (!success) {
            int err = Marshal.GetLastWin32Error();
            throw new Exception("CreateProcess on WinSta0\\Default failed with error " + err);
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }
}
"@
        try {
            Add-Type -TypeDefinition $launcherSource -ErrorAction Stop
        } catch {
            Write-Warning "Failed to compile desktop launcher helper ($($_.Exception.Message)); falling back to Start-Process."
            Start-Process -FilePath $FilePath -WorkingDirectory $workDir
            return
        }
    }

    [void][KiteDesktopLauncher]::Launch($FilePath, $workDir)
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
    Start-OnInteractiveDesktop -FilePath $installedApp
} else {
    $distBinary = Join-Path $ProjectRoot "src-tauri\target\release\kite-code.exe"
    Write-Host "Launching distribution binary: $distBinary" -ForegroundColor Green
    Start-OnInteractiveDesktop -FilePath $distBinary
}
Write-Host "Done! Kite Code is running." -ForegroundColor Green
