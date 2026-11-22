@echo off
rem Starts the demo page server and opens the tenancy clause in Chrome, ready to record Glider with the camera on.
rem Close this window (or press Ctrl+C) to stop the server.
cd /d "%~dp0.."
start "" "http://localhost:8378/tenancy-agreement"
node showcase\serve-demo.mjs
