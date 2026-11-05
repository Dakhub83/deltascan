@echo off
rem Starts DeltaScan without an editor: double-click this file, or run "start-deltascan mock" for simulated data.
rem The landing page and the dashboard are both served at http://localhost:4000. Close this window to stop.
setlocal
cd /d "%~dp0"
title DeltaScan

where node >nul 2>nul || (
  echo Node.js 22 or newer is required: https://nodejs.org
  pause & exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install || (pause & exit /b 1)
)

rem Rebuild the site only when its source is newer than the last build.
node -e "const fs=require('fs'),p=require('path');const t=(d)=>{let m=0;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);m=Math.max(m,e.isDirectory()?t(f):fs.statSync(f).mtimeMs)}return m};const out='apps/web/dist/index.html';const src=Math.max(t('apps/web/src'),t('apps/web/public'),t('packages/shared/src'),fs.statSync('apps/web/index.html').mtimeMs,fs.statSync('apps/web/app/index.html').mtimeMs);process.exit(fs.existsSync(out)&&fs.statSync(out).mtimeMs>=src?0:1)"
if errorlevel 1 (
  echo Building the site, about 30 seconds...
  call npm run build || (pause & exit /b 1)
)

set SERVE_WEB=true
if /i "%~1"=="mock" (
  set DATA_PROVIDER=mock
  set DB_PATH=./data/mock.db
)
if not defined SERVER_PORT set SERVER_PORT=4000

rem Something else on the port (often "npm run dev" left running in an editor) would answer instead of us.
node -e "require('net').connect(%SERVER_PORT%,'127.0.0.1').on('connect',()=>process.exit(1)).on('error',()=>process.exit(0))"
if errorlevel 1 (
  echo Port %SERVER_PORT% is already in use, probably by "npm run dev" or another DeltaScan window.
  echo Stop that first, then run this again.
  pause & exit /b 1
)

echo.
echo DeltaScan: http://localhost:%SERVER_PORT%/  (dashboard: /app/)
echo Close this window to stop the server.
echo.
rem Opens the browser once the server answers, so the first page isn't an error.
if not defined NO_BROWSER start "" /b node -e "const u='http://localhost:%SERVER_PORT%/';const go=(n)=>fetch(u).then(()=>require('child_process').exec('start \"\" '+u)).catch(()=>n>0&&setTimeout(()=>go(n-1),1000));go(60)"
call npm start
pause
