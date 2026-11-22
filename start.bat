@echo off
setlocal
cd /d "%~dp0"

set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Python 3 nao foi encontrado.
    echo Instale em https://www.python.org/downloads/ e marque "Add Python to PATH".
    echo.
    pause
    exit /b 1
  )
  set "PY=py -3"
)

echo Iniciando Xadrez Voz...
%PY% server.py %*

if errorlevel 1 (
  echo.
  echo O servidor encerrou com erro. Veja as mensagens acima.
  pause
)
