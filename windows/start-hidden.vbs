' Lanza el watcher sin consola desde la carpeta del proyecto.
' Ajusta NODE_EXE o la ruta por defecto si node.exe no está en %ProgramFiles%\nodejs.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodeExe = sh.ExpandEnvironmentStrings("%NODE_EXE%")
If nodeExe = "%NODE_EXE%" Then nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
sh.CurrentDirectory = projectDir
sh.Run """" & nodeExe & """ """ & projectDir & "\src\index.mjs""", 0, False
