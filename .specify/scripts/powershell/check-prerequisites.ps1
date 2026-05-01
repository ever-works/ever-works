# Check that the host has everything Spec Kit needs.
# Usage: .\.specify\scripts\powershell\check-prerequisites.ps1

$ok = $true

function Test-Cmd {
    param([string]$Cmd, [string]$Hint)
    $found = Get-Command $Cmd -ErrorAction SilentlyContinue
    if ($found) {
        $version = (& $Cmd --version 2>&1 | Select-Object -First 1)
        Write-Host ("  [ok]    {0,-12} {1}" -f $Cmd, $version)
    }
    else {
        Write-Host ("  [MISS]  {0,-12} {1}" -f $Cmd, $Hint) -ForegroundColor Yellow
        $script:ok = $false
    }
}

Write-Host "Checking Spec Kit prerequisites..."
Test-Cmd "pnpm" "install pnpm 10+ via corepack: corepack enable; corepack prepare pnpm@10 --activate"
Test-Cmd "node" "install Node.js 20+"
Test-Cmd "git"  "install Git"

if ($ok) {
    Write-Host ""
    Write-Host "All prerequisites present."
}
else {
    Write-Host ""
    Write-Error "Some prerequisites missing -- see hints above."
    exit 1
}
