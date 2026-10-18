' Kite Code - Invisible Launcher (Zero console windows)
Set WshShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
psScript = scriptDir & "\scripts\launch-desktop-app.ps1"
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"
WshShell.Run cmd, 0, False
Set WshShell = Nothing
