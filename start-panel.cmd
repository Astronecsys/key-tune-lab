@echo off
setlocal
cd /d "%~dp0"

set "PANEL_PYTHON=%~dp0.panel-env\python.exe"
if exist "%PANEL_PYTHON%" goto run_panel

set "CONDA_EXE=%ProgramData%\miniforge3\Scripts\conda.exe"
if exist "%CONDA_EXE%" goto create_environment
for %%C in (conda.exe) do set "CONDA_EXE=%%~$PATH:C"
if defined CONDA_EXE goto create_environment

echo [KEY//TUNE LAB] Could not find Conda.
echo Install Miniforge, then run start-panel.cmd again.
pause
exit /b 1

:create_environment
echo [KEY//TUNE LAB] First start: creating the panel-only environment...
"%CONDA_EXE%" env create --prefix "%~dp0.panel-env" --file "%~dp0environment-panel.yml"
if errorlevel 1 (
  echo Environment setup failed. See the error above.
  pause
  exit /b 1
)
set "PANEL_PYTHON=%~dp0.panel-env\python.exe"

:run_panel
echo [KEY//TUNE LAB] Starting http://127.0.0.1:8765/
"%PANEL_PYTHON%" -m music_lab.panel %*
