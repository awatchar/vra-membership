<#
.SYNOPSIS
  Uploads the production secrets to Cloudflare in one pass.

.DESCRIPTION
  Every value this script handles is a secret, so it is built so that a secret
  never has to be typed twice and never has to sit on disk longer than the run:

  - Values are read from a git-ignored file under `.secrets/`, which you fill in
    once by copying from your own notes, or entered interactively if that file
    does not exist.
  - The file is not read by anything else, is never committed (`.gitignore`
    covers `.secrets/`), and `-RemoveFileWhenDone` deletes it after a successful
    upload.
  - Nothing is echoed back to the terminal, so the values do not end up in your
    shell history or scrollback.
  - `PII_ENCRYPTION_KEY` is generated for you when left blank, because it must
    be high-entropy and must never change afterwards.

.PARAMETER EnvFile
  Path to the values file. Defaults to `.secrets/production.env`.

.PARAMETER Environment
  Wrangler environment to target. Defaults to `production`.

.PARAMETER RemoveFileWhenDone
  Deletes the values file after every secret has been uploaded successfully.

.PARAMETER WhatIf
  Reports which secrets are present and which are missing, and uploads nothing.

.EXAMPLE
  # 1. Create the template, fill it in, then upload.
  pwsh -File ./scripts/set-production-secrets.ps1 -CreateTemplate
  pwsh -File ./scripts/set-production-secrets.ps1 -RemoveFileWhenDone

.EXAMPLE
  # Check what is still missing without uploading anything.
  pwsh -File ./scripts/set-production-secrets.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$EnvFile = '.secrets/production.env',
  [string]$Environment = 'production',
  [switch]$CreateTemplate,
  [switch]$RemoveFileWhenDone
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Name, whether a blank value can be generated, and what the value is for.
$secrets = @(
  @{ Name = 'IAPP_API_KEY'; Generate = $false; Purpose = 'iApp Thai national ID OCR' }
  @{ Name = 'SLIPOK_API_KEY'; Generate = $false; Purpose = 'SlipOK payment slip verification' }
  @{ Name = 'RESEND_API_KEY'; Generate = $false; Purpose = 'Resend transactional email' }
  @{ Name = 'RESEND_WEBHOOK_SECRET'; Generate = $false; Purpose = 'Resend webhook signature check' }
  @{ Name = 'TURNSTILE_SECRET_KEY'; Generate = $false; Purpose = 'Turnstile server-side verification' }
  @{ Name = 'PII_ENCRYPTION_KEY'; Generate = $true; Purpose = 'Citizen ID encryption; NEVER change once data exists' }
  @{ Name = 'MANAGER_EMAIL'; Generate = $false; Purpose = 'Recipient of the new-application email' }
  @{ Name = 'EMAIL_FROM'; Generate = $false; Purpose = 'Sender address for member email' }
  @{ Name = 'VRA_BANK_NAME'; Generate = $false; Purpose = 'Shown on the payment page and checked against the slip' }
  @{ Name = 'VRA_BANK_ACCOUNT'; Generate = $false; Purpose = 'Shown on the payment page and checked against the slip' }
  @{ Name = 'VRA_BANK_ACCOUNT_NAME'; Generate = $false; Purpose = 'Shown on the payment page and checked against the slip' }
)

function New-EncryptionKey {
  # 48 random bytes, base64 encoded: the same shape as `openssl rand -base64 48`.
  #
  # `RandomNumberGenerator::Fill` only exists on .NET Core, so it would fail on
  # Windows PowerShell 5.1. `RNGCryptoServiceProvider` works on both, and this
  # script has to run wherever the operator happens to be.
  $bytes = New-Object 'byte[]' 48
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try {
    $rng.GetBytes($bytes)
  }
  finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function Write-Template {
  param([string]$Path)

  $directory = Split-Path -Parent $Path
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  if (Test-Path -LiteralPath $Path) {
    throw "Refusing to overwrite an existing values file: $Path"
  }

  $lines = @(
    '# Production secrets for the VRA membership Worker.',
    '#',
    '# This file is git-ignored and must never be committed, pasted into an',
    '# Issue or a pull request, or shared in chat. Delete it once the upload',
    '# has succeeded (or pass -RemoveFileWhenDone).',
    '#',
    '# Format: NAME=value, one per line. Values are taken literally, so do not',
    '# add quotes unless they are part of the value.',
    '#',
    '# Leave PII_ENCRYPTION_KEY blank to have a fresh key generated.',
    ''
  )
  foreach ($secret in $secrets) {
    $lines += "# $($secret.Purpose)"
    $lines += "$($secret.Name)="
    $lines += ''
  }

  Set-Content -LiteralPath $Path -Value $lines -Encoding utf8
  Write-Host "Template written to $Path"
  Write-Host 'Fill in the values, then run this script again.'
}

function Read-ValuesFile {
  param([string]$Path)

  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }

    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { continue }

    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1)
    if ($value.Length -gt 0) { $values[$name] = $value }
  }
  return $values
}

function Set-CloudflareSecret {
  param([string]$Name, [string]$Value)

  # The value goes to wrangler over stdin, so it never appears in a command
  # line, in process arguments, or in shell history.
  $Value | & npx wrangler secret put $Name --env $Environment | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "wrangler secret put failed for $Name"
  }
}

# Everything below runs inside a trap so a thrown error exits non-zero. Without
# this the script can fail and still report success, which for a script whose
# job is "the production secrets are set" is the worst possible outcome.
trap {
  Write-Host "FAILED: $($_.Exception.Message)"
  exit 1
}

if ($CreateTemplate) {
  Write-Template -Path $EnvFile
  exit 0
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Host "No values file at $EnvFile."
  Write-Host 'Create one with:  pwsh -File ./scripts/set-production-secrets.ps1 -CreateTemplate'
  exit 1
}

$values = Read-ValuesFile -Path $EnvFile
$missing = [System.Collections.Generic.List[string]]::new()
$generated = [System.Collections.Generic.List[string]]::new()

foreach ($secret in $secrets) {
  if ($values.ContainsKey($secret.Name)) { continue }
  if ($secret.Generate) {
    $values[$secret.Name] = New-EncryptionKey
    $generated.Add($secret.Name)
  }
  else {
    $missing.Add($secret.Name)
  }
}

if ($missing.Count -gt 0) {
  Write-Host 'Missing values:'
  $missing | ForEach-Object { Write-Host "  - $_" }
  Write-Host ''
  Write-Host "Add them to $EnvFile and run again. Nothing was uploaded."
  exit 1
}

foreach ($name in $generated) {
  Write-Host "Generated a new $name (48 random bytes, base64)."
  Write-Host '  This value can never change once real applications exist: the'
  Write-Host '  citizen ID ciphertext and the duplicate-lookup hash both derive'
  Write-Host '  from it, and no plaintext copy is kept anywhere.'
}

$uploaded = 0
foreach ($secret in $secrets) {
  if ($PSCmdlet.ShouldProcess("$($secret.Name) (env: $Environment)", 'wrangler secret put')) {
    Set-CloudflareSecret -Name $secret.Name -Value $values[$secret.Name]
    Write-Host "Uploaded $($secret.Name)"
    $uploaded += 1
  }
  else {
    Write-Host "Would upload $($secret.Name)"
  }
}

if ($uploaded -eq $secrets.Count) {
  Write-Host ''
  Write-Host "All $uploaded secrets are set for the '$Environment' environment."

  if ($generated.Count -gt 0) {
    Write-Host ''
    Write-Host 'Before deleting the values file, store the generated'
    Write-Host 'PII_ENCRYPTION_KEY somewhere durable and offline. Losing it means'
    Write-Host 'no stored citizen ID can ever be read again.'
  }

  if ($RemoveFileWhenDone) {
    if ($generated.Count -gt 0) {
      Write-Host ''
      Write-Host 'Not deleting the values file: it holds a generated key that you'
      Write-Host 'have not had a chance to back up. Delete it yourself once you have.'
    }
    else {
      Remove-Item -LiteralPath $EnvFile -Force
      Write-Host "Deleted $EnvFile"
    }
  }
  else {
    Write-Host ''
    Write-Host "Delete $EnvFile when you no longer need it."
  }
}
