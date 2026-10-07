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

# 路径解析失败时必须早退：把空值传给 Test-Path/Join-Path 会抛出
# 「无法将参数绑定到参数 Path，因为该参数是空值」这类终止性错误，
# 直接让整个原生构建中断。
# 注意：本文件必须保持 UTF-8 with BOM —— Windows PowerShell 5.1 会把无 BOM
# 的脚本按 ANSI(GB2312) 解码，中文注释里一旦出现 ASCII 引号就会让解析器错位。
if ([string]::IsNullOrWhiteSpace($ResourcesDir) -or [string]::IsNullOrWhiteSpace($RustDir)) {
    Write-Host "[native-build] Failed to resolve native paths, skipping native build" -ForegroundColor Yellow
    exit 0
}

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
# Returns $true on success, $false (with a warning) when the artifact is missing
# or the destination is locked. Never throws: a failed copy must not abort the
# whole build (resources/native may be held open by a running Electron instance).
function Copy-NativeArtifact {
    param(
        [string]$SourceName,
        [string]$DestName
    )

    if ([string]::IsNullOrWhiteSpace($SourceName) -or [string]::IsNullOrWhiteSpace($DestName)) {
        Write-Host "[native-build] Warning: artifact name is empty, skipping copy" -ForegroundColor Yellow
        return $false
    }

    $SourcePath = Join-Path $RustDir "target\$Profile\$SourceName"
    if (-not (Test-Path -LiteralPath $SourcePath)) {
        Write-Host "[native-build] Warning: artifact not found at $SourcePath" -ForegroundColor Yellow
        return $false
    }

    $DestPath = Join-Path $ResourcesDir $DestName
    try {
        Copy-Item -LiteralPath $SourcePath -Destination $DestPath -Force -ErrorAction Stop
    } catch {
        Write-Host "[native-build] Warning: 无法写入 $DestPath（可能被运行中的程序占用），保留现有文件" -ForegroundColor Yellow
        return $false
    }

    Write-Host "  $DestName -> resources/native/" -ForegroundColor Green
    return $true
}

# Remove a stale artifact (e.g. a leftover audio_napi.dll that must not ship).
# Best-effort: an empty/unassigned path, a missing file, a locked file or a
# blocked delete are all non-fatal - they only warn. Passing a $null path to
# Test-Path throws a *terminating* parameter-binding error, so the guard here is
# mandatory, not cosmetic.
function Remove-StaleArtifact {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    try {
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
        Write-Host "  removed stale $(Split-Path -Leaf $Path)" -ForegroundColor DarkGray
        return $true
    } catch {
        Write-Host "[native-build] Warning: 无法删除残留文件 $Path（可能被占用），请手动清理" -ForegroundColor Yellow
        return $false
    }
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

        if (-not (Test-Path -LiteralPath $ResourcesDir)) {
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

        if (-not (Test-Path -LiteralPath $ResourcesDir)) {
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

            if (-not (Test-Path -LiteralPath $ResourcesDir)) {
                New-Item -ItemType Directory -Force -Path $ResourcesDir | Out-Null
            }

            # cargo 在 Windows 上产出的是 .dll，需要重命名为 .node 才能被 require。
            # 只保留 .node：.dll 与之字节相同，再拷一份既浪费体积，又会被
            # 运行时的候选文件名列表误当成可加载模块（Node 不把 .dll 注册为原生扩展名）。
            [void](Copy-NativeArtifact -SourceName "audio_napi.dll" -DestName "audio_napi.node")
            # 同步清理历史版本可能残留的 .dll 副本，避免随包发布。
            # 路径写在这里唯一确定，交给 Remove-StaleArtifact 做尽力删除（失败仅告警）。
            [void](Remove-StaleArtifact -Path (Join-Path $ResourcesDir "audio_napi.dll"))
        }
    }

    Write-Host "[native-build] Done!" -ForegroundColor Green
} finally {
    Pop-Location
}
