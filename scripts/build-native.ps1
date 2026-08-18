# Auto-build Rust native module and copy to resources/native/
# Usage:
#   dev:    .\scripts\build-native.ps1           (Debug)
#   build:  .\scripts\build-native.ps1 -Release  (Release)
#
# Builds three napi-rs crates:
#   - media-control-napi   (all platforms: Windows/Linux/macOS)
#   - music-tag-reader-napi (all platforms: Windows/Linux/macOS)
#   - audio-napi          (Windows only, WASAPI)

param(
    [switch]$Release
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$RustDir = Join-Path $ProjectRoot "native\rust-audio-engine"
$ResourcesDir = Join-Path $ProjectRoot "resources\native"
$Profile = if ($Release) { "release" } else { "debug" }

# Windows PowerShell 5.1 has no $IsWindows variable; fall back to $env:OS
$IsWindowsOS = if ($null -ne $IsWindows) { $IsWindows } else { $env:OS -eq 'Windows_NT' }

# Check if cargo is available
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    Write-Host "[native-build] Rust toolchain not found, skipping native build" -ForegroundColor Yellow
    Write-Host "  Install Rust for WASAPI support: https://rustup.rs/" -ForegroundColor DarkGray
    exit 0
}

# Check if native directory exists (it may be gitignored and excluded from CI checkout)
if (-not (Test-Path $RustDir)) {
    Write-Host "[native-build] Native directory not found, skipping build" -ForegroundColor Yellow
    exit 0
}

# Run a cargo build. $ErrorActionPreference is temporarily set to Continue so a
# failed build does not abort the script (best-effort, exit code stays 0).
function Invoke-CargoBuild {
    param([string[]]$BuildArgs)

    $buildCmd = "cargo $($BuildArgs -join ' ')"
    Write-Host "  > $buildCmd" -ForegroundColor DarkGray

    $savedErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & cargo @BuildArgs
    $ErrorActionPreference = $savedErrorAction
    return $LASTEXITCODE
}

# Copy a built artifact from target/$Profile into resources/native.
# Returns $true on success, $false (with a warning) when the artifact is missing.
function Copy-NativeArtifact {
    param(
        [string]$SourceName,
        [string]$DestName
    )

    $SourcePath = Join-Path $RustDir "target\$Profile\$SourceName"
    if (Test-Path $SourcePath) {
        Copy-Item -Force $SourcePath (Join-Path $ResourcesDir $DestName)
        Write-Host "  $DestName -> resources/native/" -ForegroundColor Green
        return $true
    }

    Write-Host "[native-build] Warning: artifact not found at $SourcePath" -ForegroundColor Yellow
    return $false
}

Write-Host "[native-build] Building Rust native modules ($Profile)..." -ForegroundColor Cyan

Push-Location $RustDir
try {
    # --- Build media-control-napi (cross-platform) ---
    $mediaArgs = @("build", "-p", "media-control-napi")
    if ($Release) {
        $mediaArgs += "--release"
    }

    if ((Invoke-CargoBuild -BuildArgs $mediaArgs) -ne 0) {
        Write-Host "[native-build] media-control-napi build failed, using existing native module if available" -ForegroundColor Red
    } else {
        Write-Host "[native-build] media-control-napi build succeeded, copying artifact..." -ForegroundColor Green

        if (-not (Test-Path $ResourcesDir)) {
            New-Item -ItemType Directory -Force -Path $ResourcesDir | Out-Null
        }

        # Artifact extension depends on the platform: dll (Windows) / dylib (macOS) / so (Linux).
        # Prefer the expected extension for the current OS, but fall back to any that actually exists.
        $mediaCandidates = if ($IsWindowsOS) {
            @("media_control_napi.dll", "media_control_napi.dylib", "media_control_napi.so")
        } else {
            @("media_control_napi.dylib", "media_control_napi.so", "media_control_napi.dll")
        }
        $mediaSource = $mediaCandidates | Where-Object { Test-Path (Join-Path $RustDir "target\$Profile\$_") } | Select-Object -First 1

        if ($mediaSource) {
            [void](Copy-NativeArtifact -SourceName $mediaSource -DestName "media_control_napi.node")
        } else {
            Write-Host "[native-build] Warning: media_control_napi artifact not found in target\$Profile" -ForegroundColor Yellow
        }
    }

    # --- Build music-tag-reader-napi (cross-platform) ---
    $tagArgs = @("build", "-p", "music-tag-reader-napi")
    if ($Release) {
        $tagArgs += "--release"
    }

    if ((Invoke-CargoBuild -BuildArgs $tagArgs) -ne 0) {
        Write-Host "[native-build] music-tag-reader-napi build failed, using existing native module if available" -ForegroundColor Red
    } else {
        Write-Host "[native-build] music-tag-reader-napi build succeeded, copying artifact..." -ForegroundColor Green

        if (-not (Test-Path $ResourcesDir)) {
            New-Item -ItemType Directory -Force -Path $ResourcesDir | Out-Null
        }

        # Artifact extension depends on the platform: dll (Windows) / dylib (macOS) / so (Linux).
        # Prefer the expected extension for the current OS, but fall back to any that actually exists.
        $tagCandidates = if ($IsWindowsOS) {
            @("music_tag_reader_napi.dll", "music_tag_reader_napi.dylib", "music_tag_reader_napi.so")
        } else {
            @("music_tag_reader_napi.dylib", "music_tag_reader_napi.so", "music_tag_reader_napi.dll")
        }
        $tagSource = $tagCandidates | Where-Object { Test-Path (Join-Path $RustDir "target\$Profile\$_") } | Select-Object -First 1

        if ($tagSource) {
            [void](Copy-NativeArtifact -SourceName $tagSource -DestName "music_tag_reader.node")
        } else {
            Write-Host "[native-build] Warning: music_tag_reader_napi artifact not found in target\$Profile" -ForegroundColor Yellow
        }
    }

    # --- Build audio-napi (Windows only, WASAPI) ---
    if ($IsWindowsOS) {
        $audioArgs = @("build", "-p", "audio-napi", "--features", "wasapi")
        if ($Release) {
            $audioArgs += "--release"
        }

        if ((Invoke-CargoBuild -BuildArgs $audioArgs) -ne 0) {
            Write-Host "[native-build] audio-napi build failed, using existing native module if available" -ForegroundColor Red
        } else {
            Write-Host "[native-build] audio-napi build succeeded, copying artifacts..." -ForegroundColor Green

            if (-not (Test-Path $ResourcesDir)) {
                New-Item -ItemType Directory -Force -Path $ResourcesDir | Out-Null
            }

            [void](Copy-NativeArtifact -SourceName "audio_napi.dll" -DestName "audio_napi.node")
            [void](Copy-NativeArtifact -SourceName "audio_napi.dll" -DestName "audio_napi.dll")
        }
    }

    Write-Host "[native-build] Done!" -ForegroundColor Green
} finally {
    Pop-Location
}
