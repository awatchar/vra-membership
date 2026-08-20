[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$failures = [System.Collections.Generic.List[string]]::new()

$requiredFiles = @(
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.env.example',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  'docs/security-privacy.md'
)

foreach ($path in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $failures.Add("Missing required file: $path")
  }
}

$trackedFiles = @(git ls-files)
if ($LASTEXITCODE -ne 0) {
  throw 'git ls-files failed.'
}

$forbiddenTrackedPathPatterns = @(
  '(^|/)apiendpoint-apikey\.md$',
  '(^|/)\.dev\.vars($|\.)',
  '(^|/)\.secrets?/',
  '(^|/)\.env($|\.)'
)

foreach ($path in $trackedFiles) {
  if ($path -eq '.env.example') {
    continue
  }

  foreach ($pattern in $forbiddenTrackedPathPatterns) {
    if ($path -match $pattern) {
      $failures.Add("Forbidden secret-bearing path is tracked: $path")
      break
    }
  }
}

$textExtensions = @(
  '.cjs', '.css', '.html', '.js', '.json', '.jsonc', '.jsx', '.md',
  '.mjs', '.ps1', '.sh', '.sql', '.ts', '.tsx', '.txt', '.yaml', '.yml'
)
# Looks for a secret-shaped name assigned a secret-shaped literal.
#
# The value must contain a digit or one of + / = somewhere in its first run of
# secret-like characters. Without that condition the pattern also matched
# ordinary code such as `const accessToken = generateAccessToken()`, where the
# right-hand side is an identifier rather than a literal. Real keys and tokens
# are not made of letters alone, so requiring one non-letter keeps the check
# useful while dropping that class of false positive.
#
# This is defence in depth, not the only line: GitHub secret scanning and push
# protection are both enabled on this repository.
$secretAssignmentPattern = '(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|webhook[_-]?secret)\s*[:=]\s*["'']?(?=[A-Za-z0-9_+/=-]{16,})[A-Za-z0-9_-]*[0-9+/=]'

foreach ($path in $trackedFiles) {
  $extension = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
  if ($textExtensions -notcontains $extension) {
    continue
  }

  $content = Get-Content -LiteralPath $path -Raw
  if ($content -match '(?m)^(<<<<<<<|=======|>>>>>>>)') {
    $failures.Add("Unresolved merge-conflict marker found in: $path")
  }
  if ($path -ne 'scripts/validate-repository.ps1' -and $content -match $secretAssignmentPattern) {
    $failures.Add("Possible hard-coded secret assignment found in: $path")
  }
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ -ErrorAction Continue }
  exit 1
}

Write-Host "Repository baseline passed ($($trackedFiles.Count) tracked files checked)."
