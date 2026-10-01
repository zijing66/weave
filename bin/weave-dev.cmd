@echo off
rem weave dev CLI - runs the TypeScript sources directly, no build step.
rem
rem Lives in <repo>\bin, so the repo root is one level up. Paths resolve from
rem %~dp0, which keeps the caller's working directory intact: "weave-dev init"
rem still targets *your* project, not the weave checkout.
rem
rem One-shot by design. "tsx watch" stays alive after the script exits, which
rem would hang commands like "weave-dev status"; use weave-dev-watch.cmd when
rem you want reload-on-change.
rem
rem   weave-dev status
rem   weave-dev init --no-interactive
rem   weave-dev statusline preview
setlocal

rem Canonical repo root - %~dp0 is <repo>\bin\, and ".." keeps a literal ".."
rem in every path it is concatenated into, so normalize it once here.
for %%I in ("%~dp0..") do set "WEAVE_ROOT=%%~fI\"
set "WEAVE_TSX=%WEAVE_ROOT%node_modules\tsx\dist\cli.mjs"
set "WEAVE_ENTRY=%WEAVE_ROOT%packages\weave-cli\src\main.ts"

if not exist "%WEAVE_TSX%" (
  echo weave-dev: dependencies are not installed 1>&2
  echo   run "pnpm install" in %WEAVE_ROOT% 1>&2
  exit /b 1
)

rem --conditions=development makes the workspace packages resolve to their
rem src/ instead of dist/, so no build is needed.
node "%WEAVE_TSX%" --conditions=development "%WEAVE_ENTRY%" %*
exit /b %ERRORLEVEL%
