[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OwnedRoot,

    [Parameter(Mandatory = $true)]
    [string]$OwnedParent,

    [Parameter(Mandatory = $true)]
    [string]$CustodyPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

$plainBytes = $null
$protectedBytes = $null
$readProtectedBytes = $null
$roundTripBytes = $null
$success = $false
$cleanupPassed = $true
$failureCode = 'dpapi_operation_failed'
$custodyFull = $null
$custodyValidated = $false
$custodyCreated = $false

function Clear-ByteArray {
    param([byte[]]$Bytes)
    if ($null -ne $Bytes) {
        [Array]::Clear($Bytes, 0, $Bytes.Length)
    }
}

try {
    Add-Type -AssemblyName System.Security

    $rootFull = [IO.Path]::GetFullPath($OwnedRoot)
    $parentFull = [IO.Path]::GetFullPath($OwnedParent)
    $custodyFull = [IO.Path]::GetFullPath($CustodyPath)
    $rootName = [IO.Path]::GetFileName($rootFull.TrimEnd([IO.Path]::DirectorySeparatorChar))
    $custodyParent = [IO.Path]::GetDirectoryName($custodyFull)
    $custodyName = [IO.Path]::GetFileName($custodyFull)

    if (-not $rootName.StartsWith('ia4tube-social-3a0p-', [StringComparison]::Ordinal)) {
        throw 'owned_root_refused'
    }
    if (-not [String]::Equals(
        [IO.Path]::GetDirectoryName($rootFull),
        $parentFull,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'owned_parent_refused'
    }
    if (-not [String]::Equals($rootFull, $custodyParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'custody_path_refused'
    }
    if (-not $custodyName.StartsWith('dpapi-', [StringComparison]::Ordinal) -or
        -not $custodyName.EndsWith('.bin', [StringComparison]::Ordinal)) {
        throw 'custody_name_refused'
    }
    if (-not [IO.Directory]::Exists($rootFull)) {
        throw 'owned_root_missing'
    }
    $rootItem = Get-Item -LiteralPath $rootFull -Force
    $parentItem = Get-Item -LiteralPath $parentFull -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'owned_root_reparse_refused'
    }
    if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'owned_parent_reparse_refused'
    }
    if ([IO.File]::Exists($custodyFull) -or [IO.Directory]::Exists($custodyFull)) {
        throw 'custody_preexisting_refused'
    }
    $custodyValidated = $true

    $encodedInput = [Console]::In.ReadToEnd().Trim()
    if ([String]::IsNullOrWhiteSpace($encodedInput)) {
        throw 'stdin_missing'
    }
    if ($encodedInput.Length -gt 4096) {
        throw 'stdin_too_large'
    }
    $plainBytes = [Convert]::FromBase64String($encodedInput)
    $encodedInput = $null
    if ($plainBytes.Length -lt 32) {
        throw 'material_too_short'
    }

    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $custodyStream = [IO.File]::Open(
        $custodyFull,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    # Ownership starts when CreateNew succeeds, so a partial write is still
    # removed by this run and a pre-existing path is never adopted.
    $custodyCreated = $true
    try {
        $custodyStream.Write($protectedBytes, 0, $protectedBytes.Length)
        $custodyStream.Flush($true)
    }
    finally {
        $custodyStream.Dispose()
    }
    $readProtectedBytes = [IO.File]::ReadAllBytes($custodyFull)
    $roundTripBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $readProtectedBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )

    if ($roundTripBytes.Length -ne $plainBytes.Length) {
        throw 'round_trip_length_mismatch'
    }
    $difference = 0
    for ($index = 0; $index -lt $plainBytes.Length; $index++) {
        $difference = $difference -bor ($plainBytes[$index] -bxor $roundTripBytes[$index])
    }
    if ($difference -ne 0) {
        throw 'round_trip_mismatch'
    }

    $success = $true
    $failureCode = 'ok'
}
catch {
    $success = $false
    $failureCode = 'dpapi_operation_failed'
}
finally {
    Clear-ByteArray -Bytes $plainBytes
    Clear-ByteArray -Bytes $protectedBytes
    Clear-ByteArray -Bytes $readProtectedBytes
    Clear-ByteArray -Bytes $roundTripBytes
    try {
        if ($custodyValidated -and $custodyCreated -and
            $null -ne $custodyFull -and [IO.File]::Exists($custodyFull)) {
            Remove-Item -LiteralPath $custodyFull -Force
        }
    }
    catch {
        $cleanupPassed = $false
        $success = $false
        $failureCode = 'dpapi_cleanup_failed'
    }
}

$result = [ordered]@{
    code = $failureCode
    dpapiProtected = $success
    roundTripVerified = $success
    plaintextPersisted = $false
    currentUserScope = $true
    custodyCreatedByThisRun = $custodyCreated
    temporaryCustodyRemoved = $cleanupPassed
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
if (-not $success) {
    exit 1
}
