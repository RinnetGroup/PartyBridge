[CmdletBinding(SupportsShouldProcess)]
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$runtimeDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\node'))
$runtime = [System.IO.Path]::GetFullPath((Join-Path $runtimeDirectory 'node.exe'))
if ([System.IO.Path]::GetDirectoryName($runtime) -ne $runtimeDirectory -or !(Test-Path -LiteralPath $runtime -PathType Leaf)) { throw 'Bundled PartyBridge runtime not found.' }
$signature = Get-AuthenticodeSignature -LiteralPath $runtime
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(OpenJS Foundation|Node.js Foundation)') { throw 'The Node runtime does not have the expected valid publisher signature.' }
$manifest = Get-Content -LiteralPath (Join-Path $runtimeDirectory 'runtime.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'The bundled runtime does not match its build manifest.' }
$hasher = [Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($runtime.ToLowerInvariant()))).Replace('-', '').Substring(0,16) } finally { $hasher.Dispose() }
$ruleName = 'PartyBridge-Release-Voice-UDP-' + $digest
$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    $application = $existing | Get-NetFirewallApplicationFilter
    $ports = $existing | Get-NetFirewallPortFilter
    if ($application.Program -ne $runtime -or $ports.Protocol -ne 'UDP' -or $existing.Direction -ne 'Inbound' -or $existing.Action -ne 'Allow') { throw 'A different firewall rule uses this name. No rule was changed.' }
}
if ($Remove) {
    if ($existing -and $PSCmdlet.ShouldProcess($runtime, 'Remove PartyBridge voice UDP rule')) { $existing | Remove-NetFirewallRule }
    exit 0
}
if (!$existing -and $PSCmdlet.ShouldProcess($runtime, 'Allow inbound UDP for PartyBridge voice on Private and Public networks')) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'PartyBridge voice (UDP)' -Group 'PartyBridge Release' -Program $runtime -Direction Inbound -Action Allow -Protocol UDP -Profile Private,Public -Enabled True | Out-Null
} elseif ($existing -and $existing.Enabled -ne 'True' -and $PSCmdlet.ShouldProcess($runtime, 'Enable existing PartyBridge voice UDP rule')) {
    $existing | Enable-NetFirewallRule
}
