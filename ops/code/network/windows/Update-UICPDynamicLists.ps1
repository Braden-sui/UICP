<#
=============================================================
 OPS-ONLY SCRIPT — DO NOT RUN ON END-USER MACHINES
 This script updates Windows firewall dynamic lists.
 It MUST NOT be invoked by the application runtime or regular users.
 To proceed, you must set BOTH env vars:
   UICP_ALLOW_HOST_FW=1
   UICP_HOST_FW_I_UNDERSTAND=YES
 Otherwise, this script will exit without making changes.
=============================================================
#>

Param(
  [string[]]$ExtraJobDomains
)

if ($env:UICP_ALLOW_HOST_FW -ne '1' -or $env:UICP_HOST_FW_I_UNDERSTAND -ne 'YES') {
  Write-Error '[uicp-fw] Refusing to modify host firewall. Set UICP_ALLOW_HOST_FW=1 and UICP_HOST_FW_I_UNDERSTAND=YES to proceed.'
  exit 3
}

$ErrorActionPreference = 'Stop'

function Resolve-Domains {
  Param([string[]]$Domains)
  $v4 = New-Object System.Collections.Generic.HashSet[string]
  $v6 = New-Object System.Collections.Generic.HashSet[string]
  foreach ($d in $Domains | Sort-Object -Unique) {
    try {
      (Resolve-DnsName -Name $d -Type A -ErrorAction Stop) | Where-Object {$_.IPAddress} | ForEach-Object { [void]$v4.Add($_.IPAddress) }
    } catch {}
    try {
      (Resolve-DnsName -Name $d -Type AAAA -ErrorAction Stop) | Where-Object {$_.IPAddress} | ForEach-Object { [void]$v6.Add($_.IPAddress) }
    } catch {}
    # Follow CNAMEs once
    try {
      (Resolve-DnsName -Name $d -Type CNAME -ErrorAction Stop) | Where-Object {$_.NameHost} | ForEach-Object {
        $c = $_.NameHost
        try { (Resolve-DnsName -Name $c -Type A -ErrorAction Stop) | ForEach-Object { [void]$v4.Add($_.IPAddress) } } catch {}
        try { (Resolve-DnsName -Name $c -Type AAAA -ErrorAction Stop) | ForEach-Object { [void]$v6.Add($_.IPAddress) } } catch {}
      }
    } catch {}
  }
  return [PSCustomObject]@{ v4 = $v4.ToArray(); v6 = $v6.ToArray() }
}

function Get-SystemResolvers {
  $res = @()
  try { $res += (Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses }) -as [string[]] } catch {}
  try { $res += (Get-DnsClientServerAddress -AddressFamily IPv6 | ForEach-Object { $_.ServerAddresses }) -as [string[]] } catch {}
  return ($res | Where-Object { $_ } | Sort-Object -Unique)
}

# Seeds
$SeedsGit = @('github.com','api.github.com','uploads.github.com','raw.githubusercontent.com','objects.githubusercontent.com','pkg-containers.githubusercontent.com','gitlab.com','gitlab.io','registry.gitlab.com')
$SeedsNpm = @('registry.npmjs.org','registry.yarnpkg.com')
$SeedsArtifacts = @('s3.amazonaws.com','storage.googleapis.com')
$SeedsAuth = @('accounts.google.com','oauth2.googleapis.com','login.microsoftonline.com','sts.windows.net')
$SeedsTelemetry = @('api.segment.io','events.growthbook.io')
$SeedsJob = @() + $SeedsGit + $SeedsNpm + $SeedsArtifacts + $SeedsAuth + $SeedsTelemetry + ($ExtraJobDomains | Where-Object { $_ })

$DoH = '1.1.1.1,1.0.0.1,8.8.8.8,8.8.4.4,9.9.9.9,149.112.112.112,76.76.2.0-76.76.2.255,76.76.10.0-76.76.10.255'

$Resolvers = Get-SystemResolvers

# Update DNS allow rules to restrict to resolvers
if ($Resolvers.Count -gt 0) {
  $dnsList = ($Resolvers -join ',')
  Get-NetFirewallRule -DisplayName 'UICP Allow DNS UDP' -ErrorAction SilentlyContinue | Set-NetFirewallRule -RemoteAddress $dnsList | Out-Null
  Get-NetFirewallRule -DisplayName 'UICP Allow DNS TCP' -ErrorAction SilentlyContinue | Set-NetFirewallRule -RemoteAddress $dnsList | Out-Null
}

# Update DoH block list
Get-NetFirewallRule -DisplayName 'UICP Block DoH 443' -ErrorAction SilentlyContinue | Set-NetFirewallRule -RemoteAddress $DoH | Out-Null

# Compute Job IPs
$jobIPs = Resolve-Domains -Domains $SeedsJob
$jobV4 = $jobIPs.v4
$jobV6 = $jobIPs.v6
$jobAll = @($jobV4 + $jobV6)
if ($jobAll.Count -gt 0) {
  $addrList = ($jobAll -join ',')
  Get-NetFirewallRule -DisplayName 'UICP JOB Allow HTTPS' -ErrorAction SilentlyContinue | Set-NetFirewallRule -RemoteAddress $addrList | Out-Null
  Get-NetFirewallRule -DisplayName 'UICP JOB Allow HTTP'  -ErrorAction SilentlyContinue | Set-NetFirewallRule -RemoteAddress $addrList | Out-Null
}

# FQDN-specific job rules (defense-in-depth)
$jobUserParam = @{}
try { if (Get-LocalUser -Name 'uicp-job' -ErrorAction Stop) { $jobUserParam = @{ LocalUser = 'uicp-job' } } } catch {}
foreach ($d in ($SeedsJob | Sort-Object -Unique)) {
  $nameHttps = "UICP JOB Allow HTTPS FQDN - $d"
  $nameHttp  = "UICP JOB Allow HTTP FQDN - $d"
  if (-not (Get-NetFirewallRule -DisplayName $nameHttps -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $nameHttps -Direction Outbound -Action Allow -Protocol TCP -RemotePort 443 -RemoteFqdn $d @jobUserParam | Out-Null
  }
  if (-not (Get-NetFirewallRule -DisplayName $nameHttp -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $nameHttp -Direction Outbound -Action Allow -Protocol TCP -RemotePort 80 -RemoteFqdn $d @jobUserParam | Out-Null
  }
}

Write-Host "UICP Windows dynamic lists updated. Resolvers: $($Resolvers -join ', ') Job IPs: $($jobAll.Count)"
