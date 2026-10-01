@echo off
rem weave dev CLI with reload-on-change - the equivalent of "pnpm dev".
rem
rem tsx watch keeps the process alive between runs, so this suits long-lived
rem sessions (a TUI, or repeated commands while editing). For a single command
rem that should exit, use weave-dev.cmd instead.
rem
rem   weave-dev-watch statusline preview
setlocal

for %%I in ("%~dp0..") do set "WEAVE_ROOT=%%~fI\"
set "WEAVE_TSX=%WEAVE_ROOT%node_modules\tsx\dist\cli.mjs"
set "WEAVE_ENTRY=%WEAVE_ROOT%packages\weave-cli\src\main.ts"

if not exist "%WEAVE_TSX%" (
  echo weave-dev-watch: dependencies are not installed 1>&2
  echo   run "pnpm install" in %WEAVE_ROOT% 1>&2
  exit /b 1
)

node "%WEAVE_TSX%" watch --conditions=development "%WEAVE_ENTRY%" %*
exit /b %ERRORLEVEL%
