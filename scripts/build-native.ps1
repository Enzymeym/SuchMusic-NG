# Auto-build Rust native module and copy to resources/native/
# Usage:
#   dev:    .\scripts\build-native.ps1           (Debug)
#   build:  .\scripts\build-native.ps1 -Release  (Release)

param(
    [switch]$Release
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$RustDir = Join-Path $ProjectRoot "native\rust-audio-engine"
$ResourcesDir = Join-Path $ProjectRoot "resources\native"
$Profile = if ($Release) { "release" } else { "debug" }

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

Write-Host "[native-build] Building Rust audio engine ($Profile)..." -ForegroundColor Cyan

Push-Location $RustDir
try {
    $buildArgs = @("build", "-p", "audio-napi", "--features", "wasapi")
    if ($Release) {
        $buildArgs += "--release"
    }

    $buildCmd = "cargo $($buildArgs -join ' ')"
    Write-Host "  > $buildCmd" -ForegroundColor DarkGray

    $savedErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & cargo @buildArgs
    $ErrorActionPreference = $savedErrorAction
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[native-build] Rust build failed, using existing native module if available" -ForegroundColor Red
        exit 0
    }

    Write-Host "[native-build] Build succeeded, copying artifacts..." -ForegroundColor Green

    if (-not (Test-Path $ResourcesDir)) {
        New-Item -ItemType Directory -Force -Path $ResourcesDir | Out-Null
    }

    $DllSource = Join-Path $RustDir "target\$Profile\audio_napi.dll"

    if (Test-Path $DllSource) {
        Copy-Item -Force $DllSource (Join-Path $ResourcesDir "audio_napi.node")
        Write-Host "  audio_napi.node -> resources/native/" -ForegroundColor Green

        Copy-Item -Force $DllSource (Join-Path $ResourcesDir "audio_napi.dll")
        Write-Host "  audio_napi.dll  -> resources/native/" -ForegroundColor Green
    } else {
        Write-Host "[native-build] Warning: artifact not found at $DllSource" -ForegroundColor Yellow
    }

    Write-Host "[native-build] Done!" -ForegroundColor Green
} finally {
    Pop-Location
}
