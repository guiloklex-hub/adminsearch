<#
.SYNOPSIS
    Coletor de membros do grupo "Administrators" local - adminsearch.

.DESCRIPTION
    Auto-contido para deploy via ScreenConnect (ConnectWise).
    1. Enumera membros do grupo BUILTIN\Administrators (SID well-known S-1-5-32-544).
    2. Coleta contexto da maquina (FQDN, serial BIOS, UUID chassi, SO, IPs, ultimo user).
    3. POSTa JSON em https://<servidor>/api/v1/ingest com Bearer token.
    4. Opcionalmente instala uma Scheduled Task que reexecuta diariamente.

    Nao expande grupos de AD - o servidor faz isso via LDAP.

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
$AgentVersion = '1.1.0'

# Endpoint derivado para resultados de remediacao (mesma origem do IngestUrl)
$RemediationResultUrl = $IngestUrl -replace '/ingest$', '/remediation/result'

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
        -Description 'adminsearch - coleta diaria do grupo Administrators local' `
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

# RIDs de grupos built-in do dominio. Quando o SID termina com um destes, e'
# garantido que e' um GRUPO do AD, nao um usuario. O Get-LocalGroupMember
# tem bug historico que retorna ObjectClass='User' para grupos de dominio
# em varios cenarios — esta lista forca a classificacao correta.
$Script:DomainGroupRids = @{
    512 = 'Domain Admins'
    513 = 'Domain Users'
    516 = 'Domain Controllers'
    518 = 'Schema Admins'
    519 = 'Enterprise Admins'
    520 = 'Group Policy Creator Owners'
}

# Sanitiza nome retornado por COM/ADSI: descarta hashtables vazias, objetos
# sem propriedades enumeraveis (ConvertTo-Json serializa como '{}'), arrays,
# strings vazias e o proprio SID. O servidor decide nome final via LDAP.
function ConvertTo-CleanName {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Array]) { return $null }
    if ($Value -is [System.Collections.IDictionary]) { return $null }
    if ($Value -is [System.__ComObject]) {
        # Tenta puxar ToString; muitas vezes vira "System.__ComObject" — descarta.
        $str = try { [string]$Value } catch { $null }
        if (-not $str -or $str -match '^System\.') { return $null }
    }
    $str = [string]$Value
    $str = $str.Trim()
    if ($str -eq '') { return $null }
    if ($str -eq '{}' -or $str -eq '[]') { return $null }
    if ($str -match '^S-\d+-\d+(-\d+)*$') { return $null }
    return $str
}

# Resolve um SID para "DOMAIN\Name" via Win32 LSA (cobre principals de
# dominio que o Get-LocalGroupMember/ADSI nao consegue resolver localmente).
function Resolve-SidToNtAccount {
    param([string]$Sid)
    if (-not $Sid) { return $null }
    try {
        $sidObj = New-Object System.Security.Principal.SecurityIdentifier($Sid)
        $nt = $sidObj.Translate([System.Security.Principal.NTAccount])
        if ($nt -and $nt.Value) { return [string]$nt.Value }
    } catch {
        # Conta orfa / DC fora de alcance — silencioso, o servidor lida.
    }
    return $null
}

# Detecta heuristicamente se um principal e' grupo, dadas pistas locais
# (Class crua do PS/ADSI) + SID + nome resolvido. Retorna 'Group', 'User'
# ou 'Unknown'. Os RIDs built-in do dominio sobrescrevem qualquer pista
# errada que venha do Get-LocalGroupMember.
function Get-PrincipalClass {
    param(
        [string]$Sid,
        $RawClass,
        [string]$ResolvedName
    )

    # 1. RID well-known de grupo do dominio — autoritativo.
    if ($Sid -match '^S-1-5-21-\d+-\d+-\d+-(\d+)$') {
        $rid = [int]$matches[1]
        if ($Script:DomainGroupRids.ContainsKey($rid)) { return 'Group' }
    }

    # 2. Classe declarada pelo PS/ADSI, quando confiavel.
    if ($RawClass) {
        $rawStr = [string]$RawClass
        if ($rawStr -ieq 'Group') { return 'Group' }
        if ($rawStr -ieq 'User') {
            # Pista fraca: para principals de dominio o Get-LocalGroupMember
            # falsamente reporta 'User'. Confirmamos pelo nome resolvido.
            if ($ResolvedName -and ($ResolvedName -match '\\(.+)$')) {
                $tail = $matches[1]
                if ($tail -match '(?i)\b(Admins|Group|Operators|Users|Owners|Controllers)$') {
                    return 'Group'
                }
            }
            return 'User'
        }
    }

    return 'Unknown'
}

function Get-LocalAdminMembers {
    $members = @()

    # SID well-known do grupo Administrators local (independe de idioma)
    $adminSid = 'S-1-5-32-544'

    # Caminho preferido: Get-LocalGroupMember aceita SID nativo (Win10+ / Server 2016+)
    try {
        $rows = Get-LocalGroupMember -SID $adminSid -ErrorAction Stop
        foreach ($m in $rows) {
            $sidStr = $m.SID.Value

            # Sanitiza o Name do Get-LocalGroupMember (pode vir vazio/COM
            # para principals de dominio nao resolviveis localmente).
            $name = ConvertTo-CleanName $m.Name

            # Sempre faz Translate([NTAccount]) como fallback definitivo —
            # o LSA consegue resolver SIDs de dominio que o cmdlet nao.
            if (-not $name) {
                $name = Resolve-SidToNtAccount -Sid $sidStr
            }

            $class = Get-PrincipalClass -Sid $sidStr -RawClass $m.ObjectClass -ResolvedName $name
            $resolved = [bool]$name

            $members += [PSCustomObject]@{
                sid         = $sidStr
                name        = $name
                objectClass = $class
                resolved    = $resolved
            }
        }
        return $members
    } catch {
        Write-Log "Get-LocalGroupMember falhou: $($_.Exception.Message). Caindo para ADSI." 'WARN'
    }

    # Fallback ADSI - ADsPath WinNT exige NOME do grupo (varia por idioma:
    # 'Administrators' em ingles, 'Administradores' em PT-BR). Traduzimos
    # o SID well-known para o nome local antes.
    $groupName = $null
    try {
        $sidObj = New-Object System.Security.Principal.SecurityIdentifier($adminSid)
        $ntAccount = $sidObj.Translate([System.Security.Principal.NTAccount]).Value
        # Remove prefixo "BUILTIN\" ou "VAI-COMP\" para obter so o nome
        $groupName = ($ntAccount -split '\\')[-1]
    } catch {
        Write-Log "Nao foi possivel traduzir S-1-5-32-544 para nome local: $($_.Exception.Message)" 'ERROR'
        throw
    }

    try {
        $group = [ADSI]"WinNT://./$groupName,group"
    } catch {
        Write-Log "ADSI falhou ao abrir grupo '$groupName': $($_.Exception.Message)" 'ERROR'
        throw
    }

    foreach ($member in $group.Invoke('Members')) {
        $sidStr  = $null
        $rawName = $null
        $rawClass = $null

        try {
            $sidBytes = $member.GetType().InvokeMember('objectSid', 'GetProperty', $null, $member, $null)
            if ($sidBytes -is [byte[]]) {
                $sid = New-Object System.Security.Principal.SecurityIdentifier($sidBytes, 0)
                $sidStr = $sid.Value
            }
        } catch {
            $sidStr = $null
        }

        try {
            $rawName = $member.GetType().InvokeMember('Name', 'GetProperty', $null, $member, $null)
        } catch {
            $rawName = $null
        }

        try {
            $rawClass = $member.GetType().InvokeMember('Class', 'GetProperty', $null, $member, $null)
        } catch {
            $rawClass = $null
        }

        if (-not $sidStr) {
            Write-Log "Membro sem SID detectavel; nome=$rawName" 'WARN'
            continue
        }

        # Sanitiza o nome cru, depois Translate como fonte autoritativa.
        $name = ConvertTo-CleanName $rawName
        $translated = Resolve-SidToNtAccount -Sid $sidStr
        if ($translated) { $name = $translated }
        $resolved = [bool]$name

        $class = Get-PrincipalClass -Sid $sidStr -RawClass $rawClass -ResolvedName $name

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
# 8a. Remediacao - executar acoes recebidas do servidor
# ============================================================
function Test-WellKnownSid {
    param([string]$Sid)
    # Authoritys / prefixos hard-coded - cinto e suspensorio do servidor
    if ($Sid -like 'S-1-5-32-*') { return $true }   # BUILTIN
    if ($Sid -eq 'S-1-5-18')     { return $true }   # SYSTEM
    if ($Sid -eq 'S-1-5-19')     { return $true }   # LOCAL SERVICE
    if ($Sid -eq 'S-1-5-20')     { return $true }   # NETWORK SERVICE
    if ($Sid -eq 'S-1-5-4')      { return $true }   # INTERACTIVE
    if ($Sid -eq 'S-1-5-11')     { return $true }   # Authenticated Users
    # RIDs perigosos no dominio
    if ($Sid -match '^S-1-5-21-\d+-\d+-\d+-(500|512|518|519)$') { return $true }
    return $false
}

function Invoke-Remediation {
    param(
        [Parameter(Mandatory)] $Action,
        [Parameter(Mandatory)] $CurrentMembers
    )

    $nowIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $base = @{
        actionId    = $Action.id
        collectedAt = $nowIso
        error       = $null
    }

    # Trava 1 - recusar SIDs well-known
    if (Test-WellKnownSid -Sid $Action.targetSid) {
        Write-Log "Acao $($Action.id) recusada (well-known $($Action.targetSid))" 'WARN'
        return $base + @{ result = 'refused_well_known'; error = "SID well-known: $($Action.targetSid)" }
    }

    # Trava 2 - nao esvaziar o grupo
    $survivors = $CurrentMembers | Where-Object {
        $_.sid -ne $Action.targetSid -and -not (Test-WellKnownSid -Sid $_.sid)
    }
    if (-not $survivors -or $survivors.Count -eq 0) {
        Write-Log "Acao $($Action.id) recusada (esvaziaria o grupo)" 'WARN'
        return $base + @{ result = 'refused_last_admin'; error = 'Remocao esvaziaria o grupo Administrators local' }
    }

    # SID esta mesmo no grupo?
    $present = $CurrentMembers | Where-Object { $_.sid -eq $Action.targetSid } | Select-Object -First 1
    if (-not $present) {
        Write-Log "Acao $($Action.id) - SID $($Action.targetSid) ja nao esta no grupo" 'INFO'
        return $base + @{ result = 'not_found'; error = 'SID nao encontrado no grupo' }
    }

    try {
        $sidObj = New-Object System.Security.Principal.SecurityIdentifier($Action.targetSid)

        # Caminho moderno (Win10+ / Server 2016+)
        try {
            Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member $sidObj -ErrorAction Stop
        } catch {
            # Fallback ADSI - caminho legado, funciona em qualquer Windows ainda suportado
            $group = [ADSI]"WinNT://./S-1-5-32-544,group"
            $group.Remove("WinNT://$($Action.targetSid)")
        }

        Write-Log "Acao $($Action.id) executada: removido $($Action.targetSid) ($($Action.targetName))"
        return $base + @{ result = 'success' }
    } catch {
        $msg = $_.Exception.Message
        Write-Log "Acao $($Action.id) falhou: $msg" 'ERROR'
        return $base + @{ result = 'error'; error = $msg }
    }
}

function Send-ActionResults {
    param(
        [Parameter(Mandatory)][string]$ScanId,
        [Parameter(Mandatory)]$Results
    )

    $body = @{ scanId = $ScanId; results = $Results } | ConvertTo-Json -Depth 4 -Compress

    $maxAttempts = 3
    $delays = @(0, 5, 30)

    for ($i = 0; $i -lt $maxAttempts; $i++) {
        if ($delays[$i] -gt 0) { Start-Sleep -Seconds $delays[$i] }
        try {
            $resp = Invoke-RestMethod -Method POST -Uri $RemediationResultUrl `
                -Headers @{ Authorization = "Bearer $IngestToken" } `
                -ContentType 'application/json; charset=utf-8' `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
                -TimeoutSec 30
            Write-Log "POST /remediation/result ok: applied=$($resp.applied) ignored=$($resp.ignored)"
            return $resp
        } catch {
            $msg = $_.Exception.Message
            Write-Log "Tentativa $($i+1)/$maxAttempts (results) falhou: $msg" 'WARN'
            if ($i -eq $maxAttempts - 1) {
                Write-Log "Falha definitiva ao postar resultados: $msg" 'ERROR'
                # Nao re-lanca - perda de resultado nao trava a coleta
                return $null
            }
        }
    }
}

# ============================================================
# 8b. Monta payload e envia
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

    $resp = Send-Payload -Payload $payload

    # Processa acoes de remediacao recebidas no response
    if ($resp -and $resp.actions -and $resp.actions.Count -gt 0) {
        Write-Log "Recebidas $($resp.actions.Count) acao(oes) de remediacao para esta maquina"
        $results = @()
        foreach ($action in $resp.actions) {
            $r = Invoke-Remediation -Action $action -CurrentMembers $members
            $results += $r
        }
        if ($results.Count -gt 0) {
            Send-ActionResults -ScanId $payload.scanId -Results $results | Out-Null
        }
    }

    Write-Log "Coleta concluida com sucesso."
    exit 0
} catch {
    Write-Log "Erro fatal: $($_.Exception.Message)" 'ERROR'
    exit 2
}
