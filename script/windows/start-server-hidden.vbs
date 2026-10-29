Option Explicit

Dim shell, fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run """" & dir & "\start-server.bat"" --silent --no-browser", 0, False
