$log='C:\Coding\Worktrees\wt-e2e-1000\api-mem.log'
Remove-Item $log -ErrorAction SilentlyContinue
for ($i=0; $i -lt 200; $i++) {
  try { $p = Get-Process -Id 16764 -ErrorAction Stop; "$(Get-Date -Format HH:mm:ss) WS=$([math]::Round($p.WS/1MB))MB PM=$([math]::Round($p.PM/1MB))MB" | Add-Content $log }
  catch { "$(Get-Date -Format HH:mm:ss) API-PROCESS-GONE" | Add-Content $log; break }
  Start-Sleep -Seconds 15
}
