<#
=============================================================
 OPS-ONLY SCRIPT — DO NOT RUN ON END-USER MACHINES
 This script modifies Windows host firewall rules.
 It MUST NOT be invoked by the application runtime or regular users.
 To proceed, you must set BOTH env vars:
   UICP_ALLOW_HOST_FW=1
   UICP_HOST_FW_I_UNDERSTAND=YES
 Otherwise, this script will exit without making changes.
=============================================================
#>

Param(
  [switch]$RegisterScheduledTask = $true
)

if ($env:UICP_ALLOW_HOST_FW -ne '1' -or $env:UICP_HOST_FW_I_UNDERSTAND -ne 'YES') {
  Write-Error '[uicp-fw] Refusing to modify host firewall. Set UICP_ALLOW_HOST_FW=1 and UICP_HOST_FW_I_UNDERSTAND=YES to proceed.'
  exit 3
}

$ErrorActionPreference = 'Stop'

function Ensure-LocalGroup($name) {
  try { if (-not (Get-LocalGroup -Name $name -ErrorAction Stop)) { } } catch { New-LocalGroup -Name $name | Out-Null }
}

# Ensure marker groups exist (optional usage by services)
Ensure-LocalGroup 'UICP_UI'
Ensure-LocalGroup 'UICP_JOB'

# Create base rules if not present
function Ensure-Rule {
  Param([string]$Name,[hashtable]$Params)
  $r = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
  if ($null -eq $r) { New-NetFirewallRule -DisplayName $Name @Params | Out-Null }
}

# Global blocks
Ensure-Rule 'UICP Block DoT 853' @{ Direction='Outbound'; Action='Block'; Protocol='TCP'; RemotePort=853 }
Ensure-Rule 'UICP Block DoQ 853' @{ Direction='Outbound'; Action='Block'; Protocol='UDP'; RemotePort=853 }

# DoH IPs baseline (v4)
$DoH = '1.1.1.1,1.0.0.1,8.8.8.8,8.8.4.4,9.9.9.9,149.112.112.112,76.76.2.0-76.76.2.255,76.76.10.0-76.76.10.255'
Ensure-Rule 'UICP Block DoH 443' @{ Direction='Outbound'; Action='Block'; Protocol='TCP'; RemotePort=443; RemoteAddress=$DoH }
Ensure-Rule 'UICP Block DoH 443 UDP' @{ Direction='Outbound'; Action='Block'; Protocol='UDP'; RemotePort=443; RemoteAddress=$DoH }

# Cloud metadata IPv4
Ensure-Rule 'UICP Block Metadata v4' @{ Direction='Outbound'; Action='Block'; RemoteAddress='169.254.169.254,169.254.170.2' }
Ensure-Rule 'UICP Block Metadata v6' @{ Direction='Outbound'; Action='Block'; RemoteAddress='fd00:ec2::254' }

# Noisy exfil ports (global)
Ensure-Rule 'UICP Block Exfil TCP' @{ Direction='Outbound'; Action='Block'; Protocol='TCP'; RemotePort='21,23,135,137-139,445,3389,5985,5986' }
Ensure-Rule 'UICP Block Exfil UDP' @{ Direction='Outbound'; Action='Block'; Protocol='UDP'; RemotePort='69,137-138,161-162,514' }

# UI allows (general web)
Ensure-Rule 'UICP UI HTTPS' @{ Direction='Outbound'; Action='Allow'; Protocol='TCP'; RemotePort=443 }
Ensure-Rule 'UICP UI HTTP'  @{ Direction='Outbound'; Action='Allow'; Protocol='TCP'; RemotePort=80 }
Ensure-Rule 'UICP UI QUIC'  @{ Direction='Outbound'; Action='Allow'; Protocol='UDP'; RemotePort=443 }

# DNS allows (addresses updated by updater)
Ensure-Rule 'UICP Allow DNS UDP' @{ Direction='Outbound'; Action='Allow'; Protocol='UDP'; RemotePort=53 }
Ensure-Rule 'UICP Allow DNS TCP' @{ Direction='Outbound'; Action='Allow'; Protocol='TCP'; RemotePort=53 }

# JOB tier specific blocks
# Block QUIC for jobs (if LocalUser exists)
$jobUser = Get-LocalUser -Name 'uicp-job' -ErrorAction SilentlyContinue
if ($null -ne $jobUser) {
  Ensure-Rule 'UICP JOB Block QUIC' @{ Direction='Outbound'; Action='Block'; Protocol='UDP'; RemotePort=443; LocalUser='uicp-job' }
  # Block private/link-local egress for jobs
  $priv4 = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16'
  Ensure-Rule 'UICP JOB Block Private v4' @{ Direction='Outbound'; Action='Block'; RemoteAddress=$priv4; LocalUser='uicp-job' }
}

# JOB allow lists (updated by updater)
if ($null -ne $jobUser) {
  Ensure-Rule 'UICP JOB Allow HTTPS' @{ Direction='Outbound'; Action='Allow'; Protocol='TCP'; RemotePort=443; LocalUser='uicp-job' }
  Ensure-Rule 'UICP JOB Allow HTTP'  @{ Direction='Outbound'; Action='Allow'; Protocol='TCP'; RemotePort=80;  LocalUser='uicp-job' }
  Ensure-Rule 'UICP JOB Allow SSH'   @{ Direction='Outbound'; Action='Allow'; Protocol='TCP'; RemotePort=22;  LocalUser='uicp-job' }
}

# Register hourly updater scheduled task
if ($RegisterScheduledTask) {
  $taskName = 'UICP Update Dynamic Lists'
  $script = Join-Path $PSScriptRoot 'Update-UICPDynamicLists.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 60) -RepetitionDuration ([TimeSpan]::MaxValue)
  try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -RunLevel Highest -Description 'Refresh UICP firewall dynamic lists hourly' | Out-Null
}

Write-Host 'UICP Windows base rules installed.'
