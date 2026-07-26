Add-Type -AssemblyName System.Drawing

$source = "$PSScriptRoot\..\build\icons\1024x1024.png"
$destDir = "$PSScriptRoot\..\build\appx"

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

$sizes = @{
    "StoreLogo.png"         = @(50, 50)
    "Square44x44Logo.png"   = @(44, 44)
    "Square150x150Logo.png" = @(150, 150)
    "Wide310x150Logo.png"   = @(310, 150)
}

$img = [System.Drawing.Image]::FromFile((Resolve-Path $source))

foreach ($entry in $sizes.GetEnumerator()) {
    $file = $entry.Key
    $w = $entry.Value[0]
    $h = $entry.Value[1]

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.SmoothingMode = 'HighQuality'
    $g.DrawImage($img, 0, 0, $w, $h)
    $g.Dispose()

    $outPath = Join-Path $destDir $file
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Write-Host "Created: build\appx\$file ($($w)x$($h))"
}

$img.Dispose()
Write-Host "Done!"
