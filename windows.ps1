# Lead Claimer for Windows: installs (or updates) the bot and starts it. Run this one line in PowerShell:
#   irm https://raw.githubusercontent.com/alfiejohnson72-web/Ai-store-builder/claude/intelligent-turing-0qpxxz/windows.ps1 | iex
# Running the same line again later downloads the newest bot and starts it. Your keys (.env) are kept.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Repo = 'alfiejohnson72-web/Ai-store-builder'
$Branch = 'claude/intelligent-turing-0qpxxz'
$Dir = Join-Path $HOME 'LeadClaimer'
$Files = @('package.json', 'src/index.js', 'src/setup.js')

function Say($text, $color = 'White') { Write-Host $text -ForegroundColor $color }
function Stop-Here($text) { Say "`n$text`n" 'Red'; throw 'Lead Claimer setup stopped (see the message above).' }

Say "`n=== Lead Claimer for Windows ===`n" 'Cyan'

# 1. Node.js 22 or newer
function Get-NodeMajor {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try { return [int](& node -p "process.versions.node.split('.')[0]") } catch { return 0 }
}
if ((Get-NodeMajor) -lt 22) {
  Say 'Installing Node.js (needed to run the bot). Click Yes if Windows asks...' 'Yellow'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements | Out-Host
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if ((Get-NodeMajor) -lt 22) {
    Start-Process 'https://nodejs.org/en/download'
    Stop-Here "Node.js 22 or newer is needed. I opened nodejs.org: download the Windows installer (LTS), install it, CLOSE this window, open a NEW PowerShell window and run the same line again."
  }
}
Say "OK  Node.js $(& node --version)" 'Green'

# 2. Download the newest bot (by exact commit, so GitHub's cache can't hand out an old copy)
$Ref = $Branch
try {
  $Ref = (Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'lead-claimer' } "https://api.github.com/repos/$Repo/commits/$Branch").sha
} catch {}
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'src') | Out-Null
foreach ($f in $Files) {
  $dest = Join-Path $Dir $f
  $tmp = "$dest.download"
  $ok = $false
  foreach ($wait in 2, 4, 8, 16) {
    try {
      Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$Repo/$Ref/$f" -OutFile $tmp
      if ((Get-Item $tmp).Length -gt 100) { $ok = $true; break }
    } catch {}
    Start-Sleep -Seconds $wait
  }
  if (-not $ok) {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if (Test-Path $dest) { Say "Could not download $f (internet?). Using the copy already on this PC." 'Yellow'; continue }
    Stop-Here "Could not download $f. Check the internet connection and run the same line again."
  }
  Move-Item -Force $tmp $dest
}
& node --check (Join-Path $Dir 'src/index.js')
if ($LASTEXITCODE -ne 0) { Stop-Here 'The downloaded bot file is damaged. Run the same line again in a minute.' }
Say "OK  Bot downloaded to $Dir (version $($Ref.Substring(0, [Math]::Min(7, $Ref.Length))))" 'Green'

# 3. Keep the PC awake while the bot runs (the screen may still turn off; that's fine)
try {
  Add-Type -Namespace LeadClaimer -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
} catch {}
try { [LeadClaimer.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null } catch {}  # stay awake until the bot stops

# 4. First time: guided setup asks for the 3 Slack keys and starts the bot. After that: start the bot.
Say "`nOnly run the bot on ONE computer at a time. If it is running on the Mac, stop it there (Control+C).`n" 'Yellow'
Push-Location $Dir
try {
  if (-not (Test-Path (Join-Path $Dir '.env'))) {
    & node src/setup.js
  } else {
    Say "Starting the bot. Keep this window open. Press Ctrl+C to stop it.`n" 'Cyan'
    & node --env-file=.env src/index.js
  }
} finally {
  Pop-Location
  try { [LeadClaimer.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null } catch {}  # allow sleep again
}
