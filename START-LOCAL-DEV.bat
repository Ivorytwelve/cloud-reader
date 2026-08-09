@echo off
setlocal
set "ROOT=%~dp0"

if not exist "%ROOT%cloud-worker\.dev.vars" (
  echo Missing cloud-worker\.dev.vars
  echo Copy cloud-worker\.dev.vars.example to cloud-worker\.dev.vars and fill AUTH_TOKEN and SIGNING_KEY first.
  pause
  exit /b 1
)

start "TTU Cloud Worker" cmd /k "cd /d "%ROOT%cloud-worker" && npx wrangler dev --port 8787"
start "TTU Reader" cmd /k "cd /d "%ROOT%" && pnpm dev"

echo Local reader and Worker are starting in separate windows.
echo In Cloud Library settings, use Worker URL: http://localhost:8787
endlocal
