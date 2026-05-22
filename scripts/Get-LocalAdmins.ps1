<#
.SYNOPSIS
    Coletor de membros do grupo "Administrators" local — adminsearch.

.DESCRIPTION
    Auto-contido para deploy via ScreenConnect (ConnectWise).
    1. Enumera membros do grupo BUILTIN\Administrators (SID well-known S-1-5-32-544).
    2. Coleta contexto da maquina (FQDN, serial BIOS, UUID chassi, SO, IPs, ultimo user).
    3. POSTa JSON em https://<servidor>/api/v1/ingest com Bearer token.
    4. Opcionalmente instala uma Scheduled Task que reexecuta diariamente.

    Nao expande grupos de AD — o servidor faz isso via LDAP.

.PARAMETER IngestUrl
    URL completa do endpoint de ingestao (ex.: https://adminsearch.madeiramadeira.com.br/api/v1/ingest)

.PARAMETER IngestToken
    Bearer token configurado em INGEST_TOKEN no .env do servidor.

.PARAMETER Source
    Identifica de onde o script foi disparado. Valores aceitos:
      screenconnect | scheduled-task | manual

.PARAMETER InstallTask
    Copia o script para %ProgramData%\adminsearch\agent.ps1 e registra a Scheduled
    Task "MM-AdminSearch-Daily" (diaria 06:00 + AtStartup).

.PARAMETER Uninstall
    Remove a Scheduled Task e os arquivos em %ProgramData%\adminsearch.

.NOTES
    Execute como Administrador. Distribua via ScreenConnect Backstage.
    Versao do agent: 1.0.0
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$IngestUrl,

    [Parameter(Mandatory = $true)]
    [string]$IngestToken,

    [ValidateSet('screenconnect', 'scheduled-task', 'manual')]
    [string]$Source = 'manual',

    [switch]$InstallTask,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '1.0.0'

# ============================================================
# 1. Verificacao de Administrador
# ============================================================
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Este script precisa ser executado como Administrador."
    exit 1
}

# ============================================================
# 2. TLS 1.2 + carregar CA interna (substitua o bloco PEM)
# ============================================================
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

# !! TODO: cole o conteudo do CA interno no bloco abaixo.
# Mesmo modelo do scripts/ocs.ps1 (Root CA + Sub CA da MadeiraMadeira).
$InternalCaPem = @'
-----BEGIN CERTIFICATE-----
SUBSTITUA_AQUI_PELO_CONTEUDO_DO_ROOT_CA
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
SUBSTITUA_AQUI_PELO_CONTEUDO_DO_SUB_CA
-----END CERTIFICATE-----
'@

function Import-InternalCAs {
    param([string]$Pem)
    try {
        $blocks = [regex]::Matches($Pem, '-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----')
        foreach ($b in $blocks) {
            $bytes = [System.Convert]::FromBase64String(
                ($b.Value -replace '-----BEGIN CERTIFICATE-----', '' -replace '-----END CERTIFICATE-----', '' -replace '\s', '')
            )
            $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)
            $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
                'Root', [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
            $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
            if (-not $store.Certificates.Contains($cert)) {
                $store.Add($cert)
            }
            $store.Close()
        }
    } catch {
        Write-Warning "Falha ao importar CA interna: $($_.Exception.Message). O POST pode falhar se o cert do servidor for emitido por ela."
    }
}

if ($InternalCaPem -notmatch 'SUBSTITUA_AQUI') {
    Import-InternalCAs -Pem $InternalCaPem
}

# ============================================================
# 3. Caminhos e logging
# ============================================================
$AppDir   = Join-Path $env:ProgramData 'adminsearch'
$LogFile  = Join-Path $AppDir 'last-run.log'
$ScriptDest = Join-Path $AppDir 'agent.ps1'

if (-not (Test-Path $AppDir)) {
    New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
    $line = "[$stamp] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    # Rotacao bobinha
    if ((Get-Item $LogFile -ErrorAction SilentlyContinue).Length -gt 1MB) {
        $rotated = "$LogFile.1"
        if (Test-Path $rotated) { Remove-Item $rotated -Force }
        Rename-Item -Path $LogFile -NewName 'last-run.log.1' -Force
    }
}

# ============================================================
# 4. Modo Uninstall
# ============================================================
if ($Uninstall) {
    Write-Log "Removendo Scheduled Task e arquivos..."
    Unregister-ScheduledTask -TaskName 'MM-AdminSearch-Daily' -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Path $AppDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Log "Uninstall completo."
    exit 0
}

# ============================================================
# 5. Modo InstallTask (sem executar coleta)
# ============================================================
if ($InstallTask) {
    Write-Log "Instalando Scheduled Task MM-AdminSearch-Daily..."
    Copy-Item -Path $MyInvocation.MyCommand.Path -Destination $ScriptDest -Force

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
        "-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File `"$ScriptDest`" " +
        "-IngestUrl `"$IngestUrl`" -IngestToken `"$IngestToken`" -Source scheduled-task"
    )

    $triggerDaily = New-ScheduledTaskTrigger -Daily -At 6:00am
    $triggerBoot = New-ScheduledTaskTrigger -AtStartup
    $triggerBoot.Delay = 'PT5M'

    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest -LogonType ServiceAccount
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

    Register-ScheduledTask -TaskName 'MM-AdminSearch-Daily' `
        -Action $action `
        -Trigger @($triggerDaily, $triggerBoot) `
        -Principal $principal `
        -Settings $settings `
        -Description 'adminsearch — coleta diaria do grupo Administrators local' `
        -Force | Out-Null

    Write-Log "Scheduled Task registrada. Roda em 06:00 e a cada boot (com delay 5min)."
    # Dispara uma primeira coleta agora tambem
}

# ============================================================
# 6. Coleta de contexto da maquina
# ============================================================
function Get-MachineContext {
    $cs   = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $os   = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
    $csp  = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue

    $fqdn = try { [System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName } catch { $env:COMPUTERNAME }
    $domain = if ($cs -and $cs.PartOfDomain) { $cs.Domain } else { $null }

    # IPs
    $ipv4 = @()
    try {
        $ipv4 = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                 Where-Object { $_.IPAddress -and $_.IPAddress -notmatch '^169\.254\.' -and $_.IPAddress -ne '127.0.0.1' } |
                 Select-Object -ExpandProperty IPAddress -Unique) -as [string[]]
        if (-not $ipv4) { $ipv4 = @() }
    } catch { $ipv4 = @() }

    # MAC primario (NIC com gateway)
    $primaryMac = $null
    try {
        $primaryNic = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
                      Sort-Object -Property RouteMetric | Select-Object -First 1
        if ($primaryNic) {
            $adapter = Get-NetAdapter -InterfaceIndex $primaryNic.InterfaceIndex -ErrorAction SilentlyContinue
            if ($adapter) { $primaryMac = $adapter.MacAddress }
        }
    } catch { $primaryMac = $null }

    # Ultimo usuario logado
    $lastUser = $null
    try {
        $lastUser = $cs.UserName
        if (-not $lastUser) {
            $q = (quser 2>$null) | Select-Object -Skip 1 | Select-Object -First 1
            if ($q) { $lastUser = ($q -split '\s+')[0] }
        }
    } catch { $lastUser = $null }

    $lastBootIso = if ($os -and $os.LastBootUpTime) { $os.LastBootUpTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") } else { $null }

    return [PSCustomObject]@{
        dnsHostName    = $fqdn
        netBiosName    = $env:COMPUTERNAME
        domain         = $domain
        biosSerial     = if ($bios) { $bios.SerialNumber } else { $null }
        chassisUuid    = if ($csp) { $csp.UUID } else { $null }
        primaryMac     = $primaryMac
        osCaption      = if ($os) { $os.Caption } else { $null }
        osVersion      = if ($os) { $os.Version } else { $null }
        osBuild        = if ($os) { $os.BuildNumber } else { $null }
        lastBootAt     = $lastBootIso
        lastLoggedUser = $lastUser
        ipAddresses    = $ipv4
    }
}

# ============================================================
# 7. Enumera membros do grupo Administrators local
# ============================================================
function Get-LocalAdminMembers {
    $members = @()

    # SID well-known do grupo Administrators local
    $adminSid = 'S-1-5-32-544'

    try {
        $group = [ADSI]"WinNT://./$adminSid,group"
    } catch {
        Write-Log "ADSI falhou em S-1-5-32-544; tentando Get-LocalGroupMember. Erro: $($_.Exception.Message)" 'WARN'
        # Fallback (Win10+ tem Get-LocalGroupMember; pode falhar em servidores antigos)
        try {
            $fallback = Get-LocalGroupMember -SID $adminSid -ErrorAction Stop
            foreach ($m in $fallback) {
                $members += [PSCustomObject]@{
                    sid         = $m.SID.Value
                    name        = $m.Name
                    objectClass = if ($m.ObjectClass -eq 'Group') { 'Group' } elseif ($m.ObjectClass -eq 'User') { 'User' } else { 'Unknown' }
                    resolved    = $true
                }
            }
            return $members
        } catch {
            Write-Log "Fallback Get-LocalGroupMember tambem falhou: $($_.Exception.Message)" 'ERROR'
            throw
        }
    }

    foreach ($member in $group.Invoke('Members')) {
        $sidStr  = $null
        $name    = $null
        $class   = 'Unknown'
        $resolved = $false

        try {
            # SID via byte[] -> SecurityIdentifier
            $sidBytes = $member.GetType().InvokeMember('objectSid', 'GetProperty', $null, $member, $null)
            if ($sidBytes -is [byte[]]) {
                $sid = New-Object System.Security.Principal.SecurityIdentifier($sidBytes, 0)
                $sidStr = $sid.Value
            }
        } catch {
            $sidStr = $null
        }

        try {
            $name = $member.GetType().InvokeMember('Name', 'GetProperty', $null, $member, $null)
        } catch {
            $name = $null
        }

        try {
            $rawClass = $member.GetType().InvokeMember('Class', 'GetProperty', $null, $member, $null)
            if ($rawClass) {
                if ($rawClass -ieq 'User') { $class = 'User' }
                elseif ($rawClass -ieq 'Group') { $class = 'Group' }
                else { $class = 'Unknown' }
            }
        } catch {
            $class = 'Unknown'
        }

        # Resolve nome bonito a partir do SID (caso o ADSI nao retornou direito)
        if ($sidStr) {
            try {
                $sid = New-Object System.Security.Principal.SecurityIdentifier($sidStr)
                $nt  = $sid.Translate([System.Security.Principal.NTAccount])
                if ($nt -and $nt.Value) {
                    $name = $nt.Value
                    $resolved = $true
                }
            } catch {
                $resolved = $false
                if (-not $name) { $name = 'Conta orfa' }
            }
        }

        if (-not $sidStr) {
            Write-Log "Membro sem SID detectavel; nome=$name" 'WARN'
            continue
        }

        $members += [PSCustomObject]@{
            sid         = $sidStr
            name        = $name
            objectClass = $class
            resolved    = $resolved
        }
    }

    return $members
}

# ============================================================
# 8. Monta payload e envia
# ============================================================
function Send-Payload {
    param([Parameter(Mandatory)][PSCustomObject]$Payload)

    $body = $Payload | ConvertTo-Json -Depth 6 -Compress

    $maxAttempts = 3
    $delays = @(0, 5, 30)

    for ($i = 0; $i -lt $maxAttempts; $i++) {
        if ($delays[$i] -gt 0) { Start-Sleep -Seconds $delays[$i] }
        try {
            $resp = Invoke-RestMethod -Method POST -Uri $IngestUrl `
                -Headers @{ Authorization = "Bearer $IngestToken" } `
                -ContentType 'application/json; charset=utf-8' `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
                -TimeoutSec 30
            Write-Log "POST ok: scanId=$($Payload.scanId) machineId=$($resp.machineId) duplicate=$($resp.duplicate)"
            return $resp
        } catch {
            $msg = $_.Exception.Message
            Write-Log "Tentativa $($i+1)/$maxAttempts falhou: $msg" 'WARN'
            if ($i -eq $maxAttempts - 1) {
                Write-Log "Falha definitiva ao postar: $msg" 'ERROR'
                throw
            }
        }
    }
}

# ============================================================
# 9. Execucao principal
# ============================================================
Write-Log "Iniciando coleta (source=$Source, agent=$AgentVersion)"

try {
    $machine  = Get-MachineContext
    $members  = Get-LocalAdminMembers

    Write-Log "Maquina: $($machine.dnsHostName) | dominio: $($machine.domain) | membros: $($members.Count)"

    $payload = [ordered]@{
        scanId       = [guid]::NewGuid().ToString()
        agentVersion = $AgentVersion
        source       = $Source
        collectedAt  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        machine      = $machine
        members      = $members
    }

    Send-Payload -Payload $payload | Out-Null
    Write-Log "Coleta concluida com sucesso."
    exit 0
} catch {
    Write-Log "Erro fatal: $($_.Exception.Message)" 'ERROR'
    exit 2
}
