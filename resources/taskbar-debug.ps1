Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$tc = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
$tb = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $tc)
if (-not $tb) { Write-Output "NO TB"; exit 0 }

$depth = 0
function Dump($el, $d) {
  $r = $el.Current.BoundingRectangle
  $pad = '  ' * $d
  Write-Output ("{0}CT=[{1}] ID=[{2}] CLS=[{3}] X=[{4}] Y=[{5}] W=[{6}] H=[{7}] OFF=[{8}]" -f $pad, $el.Current.ControlType.ProgrammaticName, $el.Current.AutomationId, $el.Current.ClassName, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height, $el.Current.IsOffscreen)
  if ($d -ge 3) { return }
  $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($k in $kids) { Dump $k ($d + 1) }
}

Dump $tb $depth