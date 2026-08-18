# Measure the taskbar's blank area via Windows UI Automation.
# Output JSON: { x, y, width, height }  (PHYSICAL pixels)
# Centered taskbar -> place in the LEFT blank area (before the start button).
# Left-aligned taskbar (no left gap) -> fall back to the RIGHT gap (between app cluster and tray).

$ErrorActionPreference = 'Stop'

function Emit-Zero {
  '{ "x": 0, "y": 0, "width": 0, "height": 0 }'
  exit 0
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $tc = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
  $tb = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $tc)
  if (-not $tb) { Emit-Zero }

  $tbRect = $tb.Current.BoundingRectangle
  $trayLeft = [int]$tbRect.X
  $trayRight = [int]($tbRect.X + $tbRect.Width)

  # Collect all visible button elements to find the leftmost content edge
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
    # Centered taskbar: enough blank space on the left -> use it
    $out.x = $trayLeft
    $out.y = [int]$tbRect.Y
    $out.width = [Math]::Max(120, $leftmostX - $trayLeft - $margin)
    $out.height = [int]$tbRect.Height
  } else {
    # Left-aligned taskbar: fall back to the gap between app cluster and system tray
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
  }

  ($out | ConvertTo-Json -Compress)
} catch {
  '{ "x": 0, "y": 0, "width": 0, "height": 0, "error": "' + $_.Exception.Message.Replace('"', "'") + '" }'
}