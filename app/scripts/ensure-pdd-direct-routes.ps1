param([switch]$RemoveManagedRoutes)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$config=Get-Content -LiteralPath (Join-Path $projectRoot 'config\pdd-direct-routing.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$statePath='D:\pdd-native\data\pdd-direct-route-state.json'
$managed=@()
if(Test-Path -LiteralPath $statePath){$managed=@((Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json).managedRoutes)}
if($RemoveManagedRoutes){
 foreach($r in $managed){
  $existing=Get-NetRoute -DestinationPrefix $r.prefix -InterfaceIndex $r.interfaceIndex -NextHop $r.nextHop -PolicyStore ActiveStore -ErrorAction SilentlyContinue
  if($existing){$existing | Remove-NetRoute -Confirm:$false}
 }
 @{updatedAt=(Get-Date).ToUniversalTime().ToString('o');managedRoutes=@();enabled=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
 return
}
if(-not $config.enabled -and -not $config.proxyEndpoint){return}
$physical=Get-NetAdapter | Where-Object {$_.ifIndex -eq $config.interfaceIndex} | Select-Object -First 1
if(-not $physical -or $physical.Status -ne 'Up' -or $physical.InterfaceDescription -match 'TAP|TUN'){throw 'Configured native interface is not an active physical adapter'}
$gateway=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -InterfaceIndex $config.interfaceIndex -ErrorAction Stop | Where-Object {$_.NextHop -eq $config.nextHop}
if(-not $gateway){throw 'Configured native gateway no longer matches the physical adapter'}
$now=(Get-Date).ToUniversalTime()
$resolution=@()
$routingDomains=@()
if($config.enabled){$routingDomains=@($config.domains)}
if($config.proxyEndpoint){
 $proxyIp=$null
 if(-not [Net.IPAddress]::TryParse([string]$config.proxyEndpoint,[ref]$proxyIp) -or $proxyIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork){throw 'Proxy endpoint must be an IPv4 address'}
 $resolution+=@{domain='proxy-endpoint';ip=$proxyIp.ToString()}
}
foreach($domain in $routingDomains){
 if($domain -notmatch '^(?:[a-z0-9.-]+\.(?:pinduoduo\.com|pinduoduo\.net)|mms-static\.pddpic\.com)$'){throw "Unexpected PDD route domain: $domain"}
 $ips=@(Resolve-DnsName -Name $domain -Type A -ErrorAction Stop | Where-Object {$_.Type -eq 'A'} | Select-Object -ExpandProperty IPAddress -Unique)
 if(-not $ips.Count){throw "No IPv4 addresses resolved for $domain"}
 foreach($ip in $ips){$resolution+=@{domain=$domain;ip=$ip}}
}
foreach($ip in @($resolution.ip | Sort-Object -Unique)){
 $prefix="$ip/32"
 $entry=$managed | Where-Object {$_.prefix -eq $prefix -and $_.interfaceIndex -eq $config.interfaceIndex -and $_.nextHop -eq $config.nextHop} | Select-Object -First 1
 $existing=@(Get-NetRoute -DestinationPrefix $prefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue)
 if(-not $existing.Count){
  New-NetRoute -DestinationPrefix $prefix -InterfaceIndex $config.interfaceIndex -NextHop $config.nextHop -RouteMetric 1 -PolicyStore ActiveStore | Out-Null
  if(-not $entry){$entry=[pscustomobject]@{prefix=$prefix;interfaceIndex=$config.interfaceIndex;nextHop=$config.nextHop;lastSeenAt=$now.ToString('o')};$managed+=$entry}
 } elseif(-not ($existing | Where-Object {$_.InterfaceIndex -eq $config.interfaceIndex -and $_.NextHop -eq $config.nextHop})){
  throw "Conflicting existing host route: $prefix"
 }
 if($entry){$entry.lastSeenAt=$now.ToString('o')}
}
$keep=@()
foreach($entry in $managed){
 if([DateTime]::Parse($entry.lastSeenAt).ToUniversalTime() -lt $now.AddDays(-1)){
  Get-NetRoute -DestinationPrefix $entry.prefix -InterfaceIndex $entry.interfaceIndex -NextHop $entry.nextHop -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false
 } else {$keep+=$entry}
}
@{enabled=$true;directDomainRoutingEnabled=[bool]$config.enabled;updatedAt=$now.ToString('o');domains=$routingDomains;resolved=$resolution;managedRoutes=$keep} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Output "PDD routing ready: $($keep.Count) managed host routes"
