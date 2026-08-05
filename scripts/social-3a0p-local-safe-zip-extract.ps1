[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $true)]
    [string]$Destination,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ExpectedSha256,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9._-]+$')]
    [string]$LayoutRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail-Closed {
    param([Parameter(Mandatory = $true)][string]$Code)
    throw [System.InvalidOperationException]::new($Code)
}

function Assert-NoReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)
    $attributes = [System.IO.File]::GetAttributes($Path)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail-Closed 'windows_harness_zip_reparse_point_refused'
    }
}

function Get-CanonicalWindowsEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$ExpectedLayoutRoot
    )

    if (
        [string]::IsNullOrEmpty($Value) -or
        $Value.IndexOf([char]0) -ge 0 -or
        $Value.Contains("`r") -or
        $Value.Contains("`n") -or
        $Value.Contains('\') -or
        $Value.StartsWith('/') -or
        $Value -match '^[A-Za-z]:'
    ) {
        Fail-Closed 'windows_harness_archive_entry_invalid'
    }

    $isDirectory = $Value.EndsWith('/')
    $canonical = if ($isDirectory) {
        $Value.Substring(0, $Value.Length - 1)
    } else {
        $Value
    }
    if ([string]::IsNullOrEmpty($canonical)) {
        Fail-Closed 'windows_harness_archive_entry_invalid'
    }

    $parts = $canonical.Split('/')
    if ($parts.Count -lt 1 -or $parts[0] -cne $ExpectedLayoutRoot) {
        Fail-Closed 'windows_harness_archive_layout_invalid'
    }
    foreach ($part in $parts) {
        if (
            [string]::IsNullOrEmpty($part) -or
            $part -eq '.' -or
            $part -eq '..' -or
            $part.EndsWith(' ') -or
            $part.EndsWith('.') -or
            $part -match '[<>:"\\|?*]'
        ) {
            Fail-Closed 'windows_harness_archive_entry_invalid'
        }
        foreach ($character in $part.ToCharArray()) {
            if ([int]$character -lt 32 -or [int]$character -gt 126) {
                Fail-Closed 'windows_harness_archive_entry_invalid'
            }
        }
        $deviceStem = $part.Split('.')[0].ToUpperInvariant()
        if ($deviceStem -match '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$') {
            Fail-Closed 'windows_harness_archive_entry_invalid'
        }
    }

    return [pscustomobject]@{
        Canonical = $canonical
        IsDirectory = $isDirectory
    }
}

function Ensure-SafeDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Directory
    )

    $rootPrefix = $Root.TrimEnd('\') + '\'
    $fullDirectory = [System.IO.Path]::GetFullPath($Directory)
    if (
        $fullDirectory -ne $Root -and
        -not $fullDirectory.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        Fail-Closed 'windows_harness_archive_entry_outside_root'
    }
    $relative = $fullDirectory.Substring($Root.Length).TrimStart('\')
    $current = $Root
    if (-not [string]::IsNullOrEmpty($relative)) {
        foreach ($component in $relative.Split('\')) {
            $current = [System.IO.Path]::Combine($current, $component)
            if (-not [System.IO.Directory]::Exists($current)) {
                [System.IO.Directory]::CreateDirectory($current) | Out-Null
            }
            Assert-NoReparsePoint $current
        }
    }
}

$archiveFull = [System.IO.Path]::GetFullPath($ArchivePath)
$destinationFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
if (
    -not [System.IO.File]::Exists($archiveFull) -or
    -not [System.IO.Directory]::Exists($destinationFull)
) {
    Fail-Closed 'windows_harness_zip_input_invalid'
}
Assert-NoReparsePoint $destinationFull

Add-Type -AssemblyName System.IO.Compression
$stream = $null
$sha = $null
$zip = $null
try {
    # FileShare.Read denies concurrent writers and deletion for the entire
    # hash + inventory + extraction operation. Every extracted byte therefore
    # belongs to the exact stream whose digest and entry types were approved.
    $stream = [System.IO.FileStream]::new(
        $archiveFull,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $actualSha256 = [System.BitConverter]::ToString(
        $sha.ComputeHash($stream)
    ).Replace('-', '').ToLowerInvariant()
    if ($actualSha256 -cne $ExpectedSha256) {
        Fail-Closed 'windows_harness_archive_sha256_mismatch'
    }
    $stream.Position = 0
    $zip = [System.IO.Compression.ZipArchive]::new(
        $stream,
        [System.IO.Compression.ZipArchiveMode]::Read,
        $false
    )
    if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 100000) {
        Fail-Closed 'windows_harness_archive_inventory_invalid'
    }

    $plans = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $files = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $requiredDirectories = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $destinationPrefix = $destinationFull + '\'
    [int64]$totalUncompressedBytes = 0

    foreach ($entry in $zip.Entries) {
        $entryPath = Get-CanonicalWindowsEntry $entry.FullName $LayoutRoot
        $canonical = [string]$entryPath.Canonical
        $isDirectory = [bool]$entryPath.IsDirectory
        if (
            $entry.Length -lt 0 -or
            $entry.Length -gt 2147483648L -or
            $entry.CompressedLength -lt 0 -or
            $entry.CompressedLength -gt 2147483648L -or
            ($entry.Length -gt 0 -and $entry.CompressedLength -eq 0) -or
            (
                $entry.Length -gt 67108864L -and
                $entry.CompressedLength -gt 0 -and
                ($entry.Length / $entry.CompressedLength) -gt 1000
            ) -or
            ($isDirectory -and $entry.Length -ne 0)
        ) {
            Fail-Closed 'windows_harness_archive_size_refused'
        }
        $totalUncompressedBytes += $entry.Length
        if ($totalUncompressedBytes -gt 4294967296L) {
            Fail-Closed 'windows_harness_archive_size_refused'
        }
        if (-not $seen.Add($canonical)) {
            Fail-Closed 'windows_harness_archive_inventory_invalid'
        }

        $external = [uint32]([int64]$entry.ExternalAttributes -band 0xffffffffL)
        $unixType = ($external -shr 16) -band 0xF000
        if ($unixType -ne 0 -and $unixType -ne 0x4000 -and $unixType -ne 0x8000) {
            Fail-Closed 'windows_harness_archive_entry_type_refused'
        }
        if (
            ($unixType -eq 0x4000 -and -not $isDirectory) -or
            ($unixType -eq 0x8000 -and $isDirectory) -or
            (($external -band 0x400) -ne 0)
        ) {
            Fail-Closed 'windows_harness_archive_entry_type_refused'
        }

        $components = $canonical.Split('/')
        $ancestor = ''
        for ($index = 0; $index -lt ($components.Count - 1); $index += 1) {
            $ancestor = if ($ancestor) {
                $ancestor + '/' + $components[$index]
            } else {
                $components[$index]
            }
            if ($files.Contains($ancestor)) {
                Fail-Closed 'windows_harness_archive_inventory_invalid'
            }
            $requiredDirectories.Add($ancestor) | Out-Null
        }
        if (-not $isDirectory) {
            if ($requiredDirectories.Contains($canonical)) {
                Fail-Closed 'windows_harness_archive_inventory_invalid'
            }
            $files.Add($canonical) | Out-Null
        }

        $windowsRelative = $canonical.Replace('/', '\')
        $target = [System.IO.Path]::GetFullPath(
            [System.IO.Path]::Combine($destinationFull, $windowsRelative)
        )
        if (-not $target.StartsWith(
            $destinationPrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            Fail-Closed 'windows_harness_archive_entry_outside_root'
        }
        $plans.Add([pscustomobject]@{
            Entry = $entry
            Target = $target
            IsDirectory = $isDirectory
        })
    }

    [int64]$actualTotalBytes = 0
    foreach ($plan in $plans) {
        if ($plan.IsDirectory) {
            Ensure-SafeDirectory $destinationFull $plan.Target
            continue
        }
        $parent = [System.IO.Path]::GetDirectoryName([string]$plan.Target)
        Ensure-SafeDirectory $destinationFull $parent
        if (
            [System.IO.File]::Exists([string]$plan.Target) -or
            [System.IO.Directory]::Exists([string]$plan.Target)
        ) {
            Fail-Closed 'windows_harness_archive_target_exists'
        }
        $inputStream = $null
        $outputStream = $null
        $copyCompleted = $false
        try {
            $inputStream = $plan.Entry.Open()
            $outputStream = [System.IO.FileStream]::new(
                [string]$plan.Target,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            [int64]$expectedEntryBytes = $plan.Entry.Length
            [int64]$writtenEntryBytes = 0
            $buffer = [byte[]]::new(1048576)
            while (($readBytes = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if (
                    ($writtenEntryBytes + $readBytes) -gt $expectedEntryBytes -or
                    ($writtenEntryBytes + $readBytes) -gt 2147483648L -or
                    ($actualTotalBytes + $readBytes) -gt 4294967296L
                ) {
                    Fail-Closed 'windows_harness_archive_size_refused'
                }
                $outputStream.Write($buffer, 0, $readBytes)
                $writtenEntryBytes += $readBytes
                $actualTotalBytes += $readBytes
            }
            if ($writtenEntryBytes -ne $expectedEntryBytes) {
                Fail-Closed 'windows_harness_archive_size_mismatch'
            }
            $outputStream.Flush($true)
            $copyCompleted = $true
        } finally {
            if ($null -ne $outputStream) { $outputStream.Dispose() }
            if ($null -ne $inputStream) { $inputStream.Dispose() }
            if (-not $copyCompleted -and [System.IO.File]::Exists([string]$plan.Target)) {
                [System.IO.File]::Delete([string]$plan.Target)
            }
        }
    }

    Write-Output '{"ok":true,"code":"windows_harness_zip_extracted"}'
} finally {
    if ($null -ne $zip) { $zip.Dispose() }
    if ($null -ne $sha) { $sha.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
