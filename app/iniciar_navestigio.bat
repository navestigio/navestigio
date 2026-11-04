@echo off
setlocal
rem No buscar ejecutables en la carpeta actual: evita que un python.exe o py.bat ajeno (por ejemplo, en Descargas) se ejecute.
set "NoDefaultCurrentDirectoryInExePath=1"
title Navestigio
cd /d "%~dp0"
rem Sirve Navestigio en http://127.0.0.1:8765 (con favicon e instalable). Sin Python, abre el HTML directo.
where py >nul 2>nul && ((py "%~dp0servir_navestigio.py" || pause) & goto :eof)
where python >nul 2>nul && ((python "%~dp0servir_navestigio.py" || pause) & goto :eof)
echo No se encontro Python: se abre navestigio.html directamente.
start "" "%~dp0navestigio.html"
