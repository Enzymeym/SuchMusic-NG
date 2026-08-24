# Long-running watcher: polls the taskbar blank area every second and emits a JSON
# line (PHYSICAL pixels) only when the measured value changes. Runs until killed.
#
# Output lines: { x, y, width, height }

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$script:lastJson = ''

function Measure-Blank {
  $json = $script:lastJson
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $tc = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
    $tb = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $tc)
    if (-not $tb) { return }

    $tbRect = $tb.Current.BoundingRectangle
    $trayLeft = [int]$tbRect.X
    $trayRight = [int]($tbRect.X + $tbRect.Width)

    $btnCond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $buttons = $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)

    $leftmostX = $trayRight
    foreach ($b in $buttons) {
      try {
        if ($b.Current.IsOffscreen) { continue }
        $r = $b.Current.BoundingRectangle
        if ($r.Width -le 0 -and $r.Height -le 0) { continue }
        if ($r.X -lt $leftmostX) { $leftmostX = [int]$r.X }
      } catch { }
    }

    $margin = 6
    $out = @{}
    if ($leftmostX -gt ($trayLeft + 400)) {
      # Centered taskbar -> left blank area
      $out.x = $trayLeft
      $out.y = [int]$tbRect.Y
      $out.width = [Math]::Max(120, $leftmostX - $trayLeft - $margin)
      $out.height = [int]$tbRect.Height
      $out.align = 'center'
    } else {
      # Left-aligned taskbar -> right gap
      $children = $tb.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      $trayX = $trayRight
      $leftEndX = $trayLeft
      foreach ($c in $children) {
        try {
          $r = $c.Current.BoundingRectangle
          if ($r.Width -le 0 -and $r.Height -le 0) { continue }
          $cls = $c.Current.ClassName
          if ($cls -match 'TrayNotifyWnd') {
            if ($r.X -lt $trayX) { $trayX = [int]$r.X }
            continue
          }
          if ($r.Right -gt $leftEndX -and $r.Right -le $trayX) { $leftEndX = [int]$r.Right }
        } catch { }
      }
      $out.x = $leftEndX + $margin
      $out.y = [int]$tbRect.Y
      $out.width = [Math]::Max(120, $trayX - $leftEndX - 2 * $margin)
      $out.height = [int]$tbRect.Height
      $out.align = 'left'
    }

    $json = ($out | ConvertTo-Json -Compress)
  } catch {
    $json = '{ "x": 0, "y": 0, "width": 0, "height": 0, "error": "' + $_.Exception.Message.Replace('"', "'") + '" }'
  }

  if ($json -ne $script:lastJson) {
    $script:lastJson = $json
    Write-Output $json
  }
}

# Poll every second; emit only when the measured value changes
while ($true) {
  Measure-Blank
  Start-Sleep -Milliseconds 1000
}