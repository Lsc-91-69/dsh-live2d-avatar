<#
  dsh-pet.ps1 — Live2D 桌宠外壳（WebView2 承载）。

  只在 DSH 开着的时候才醒：先探测 DSH 的 Web 端口，探不到就直接退出。

  用法（在 DSH 之外、普通权限的 PowerShell 里运行）：
      pwsh -NoProfile -File .\dsh-pet.ps1
  可选参数：
      -Url http://127.0.0.1:3080   指定 DSH 地址
      -Width 340 -Height 460       窗口尺寸
      -NoTransparent               关掉透明（某些显卡驱动下透明会闪）

  为什么需要它单独存在：浏览器的文档画中画只能给一个带边框的小窗，
  做不成无边框、可贴桌面、置顶的贴纸。要那个效果必须由桌面程序承载 WebView2。
  形象页面复用 DSH 的 /live2d/pet，所以表情、气泡与网页里完全一致。
#>
[CmdletBinding()]
param(
  [string]$Url = 'http://127.0.0.1:3080',
  [int]$Width = 340,
  [int]$Height = 460,
  [string]$DllDir,
  [switch]$NoTransparent,
  # 自检：N 毫秒后自动关闭并汇报一次页面状态（默认 0 = 不自动关闭）
  [int]$SelfTestMs = 0
)

$ErrorActionPreference = 'Stop'

# ── 0. DPI 感知：必须在任何窗口/控件创建之前声明 ──────────────────────────
# 这是「桌宠很糊」的真正根因，而且靠超采样救不回来。
#
# 实测这台机器：桌面真实 1920×1200，但 WinForms 只报 1280×800 —— 系统在做 150% 缩放。
# 而 pwsh 默认是 DPI **UNAWARE**，于是 Windows 把整个窗口位图拉伸 1.5 倍：
# 我们渲染到 680×920 的缓冲，被系统插值放大到 1020×1380 显示 —— 又多糊一层。
# 先声明 Per-Monitor V2，系统才会把物理像素如实交给我们，渲染 1:1。
#
# 注意：此调用必须在创建任何窗口之前，且不可撤销。失败只记日志、不中断。
$dpiReady = $false
try {
  Add-Type -Namespace Dsh -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
[DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
[DllImport("shcore.dll")] public static extern int GetProcessDpiAwareness(IntPtr h, out int value);
'@ -ErrorAction Stop
  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4（按指针值传）
  $dpiReady = [Dsh.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
  if (-not $dpiReady) {
    # 老系统退回 shcore：2 = PROCESS_PER_MONITOR_DPI_AWARE
    $hr = [Dsh.Dpi]::SetProcessDpiAwareness(2)
    $dpiReady = ($hr -eq 0)
  }
} catch {
  # 类型已存在或调用失败都走到这里；后面会再查一次实际状态。
  $dpiReady = $false
}

# ── 0a2. 置顶相关的 Win32 ──────────────────────────────────────────────────
# 实测：一个覆盖全屏的浏览器窗口会把桌宠整个盖住，鼠标全落到浏览器上 ——
# 这就是「点击直接点到下一层」的真实原因，不是透明穿透，也不是 Z 序被抢。
# Form.TopMost 只设置一次会被后来的前台窗口压过去，所以需要显式 SetWindowPos
# 并周期性重申。
Add-Type -Namespace Dsh -Name Top -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
// 往上找根窗口。WindowFromPoint 命中的是**最上层的子窗口**，而我们的窗口里铺着
// WebView2，它的子 HWND 属于 msedgewebview2.exe —— 拿子窗口去比 PID 永远不等。
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
public const uint GA_ROOT = 2;
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
public const uint SWP_NOSIZE = 0x0001;
public const uint SWP_NOMOVE = 0x0002;
public const uint SWP_NOACTIVATE = 0x0010;
public const uint SWP_SHOWWINDOW = 0x0040;
public const int GWL_EXSTYLE = -20;
public const int WS_EX_NOACTIVATE = 0x08000000;
public const int WS_EX_TOOLWINDOW = 0x00000080;
  // 鼠标穿透：这个窗口不参与命中测试，点击直接落到下面那层
  public const int WS_EX_TRANSPARENT = 0x00000020;
[DllImport("dwmapi.dll")] public static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref MARGINS m);
[StructLayout(LayoutKind.Sequential)] public struct MARGINS { public int LeftWidth; public int RightWidth; public int TopHeight; public int BottomHeight; }
'@ -ErrorAction Stop

# ── 0b. 日志 ────────────────────────────────────────────────────────────────
# 必须写文件，不能只靠 Write-Host：桌宠是被 Host 以 detached 方式拉起的，
# 它的控制台输出没人看得到。没有这份日志，「静默退出」就等于完全无法诊断。
$logFile = Join-Path $env:TEMP 'dsh-live2d-pet.log'
function Log([string]$Message) {
  $line = "$(Get-Date -Format 'HH:mm:ss.fff') $Message"
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch { }
}
Log "启动 pid=$PID url=$Url pwsh=$($PSVersionTable.PSVersion)"
try {
  $awareness = 0
  [Dsh.Dpi]::GetProcessDpiAwareness([IntPtr]::Zero, [ref]$awareness) | Out-Null
  $names = @{ 0 = 'UNAWARE(会被系统拉伸,糊)'; 1 = 'SYSTEM_DPI_AWARE'; 2 = 'PER_MONITOR_DPI_AWARE' }
  Log "DPI: SetProcessDpiAwarenessContext=$dpiReady 实际感知=$awareness $($names[$awareness]) 系统DPI=$([Dsh.Dpi]::GetDpiForSystem())"
} catch {
  Log "DPI 状态查询失败：$($_.Exception.Message)"
}

# ── 1. 只在 DSH 运行时才启动 ────────────────────────────────────────────────
function Test-Dsh {
  param([string]$Base)
  try {
    $r = Invoke-WebRequest -Uri ($Base.TrimEnd('/') + '/live2d/manifest') -TimeoutSec 5 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch {
    $script:probeError = $_.Exception.Message
    return $false
  }
}

if (-not (Test-Dsh $Url)) {
  Log "DSH 探测失败（$Url）：$script:probeError —— 桌宠不启动"
  exit 0
}
Log 'DSH 在线'

# ── 2. 找到 WebView2 的 .NET 程序集与原生 loader ────────────────────────────
# 优先用随包分发的 lib/（版本配套），其次找 NuGet 缓存，最后退回 VS 私有目录。
function Resolve-WebView2 {
  param([string]$Hint)
  $candidates = @()
  if ($Hint) { $candidates += $Hint }
  $candidates += (Join-Path $PSScriptRoot 'lib')
  $candidates += (Join-Path $env:USERPROFILE '.nuget\packages\microsoft.web.webview2')
  $candidates += 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\PrivateAssemblies'
  $candidates += 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\PrivateAssemblies'

  foreach ($dir in $candidates) {
    if (-not (Test-Path $dir)) { continue }
    $core = Get-ChildItem -Path $dir -Recurse -Filter 'Microsoft.Web.WebView2.Core.dll' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\net462\\' -and $_.FullName -notmatch '\\net4' } | Select-Object -First 1
    if (-not $core) { continue }
    $loader = Get-ChildItem -Path $dir -Recurse -Filter 'WebView2Loader.dll' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'win-x64|x64' -or $_.DirectoryName -eq $core.DirectoryName } | Select-Object -First 1
    if (-not $loader) { continue }
    return [pscustomobject]@{ Core = $core.FullName; Loader = $loader.FullName; Root = $dir }
  }
  return $null
}

$wv = Resolve-WebView2 -Hint $DllDir
if (-not $wv) {
  Write-Host @'
找不到 WebView2 的程序集（Microsoft.Web.WebView2.Core.dll）。
两种解法：
  1) 把官方 NuGet 包解出的三个文件放进本脚本同级的 lib\ 目录：
     Microsoft.Web.WebView2.Core.dll（netcoreapp3.0 版）
     Microsoft.Web.WebView2.WinForms.dll（netcoreapp3.0 版）
     WebView2Loader.dll（runtimes\win-x64\native 版）
  2) 或者用 -DllDir 指向已有的目录。
另外系统需要安装 WebView2 Runtime（Win11 自带；Win10 多半也有）。
'@ -ForegroundColor Yellow
  exit 1
}
Log "WebView2 SDK: $($wv.Core)"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path $wv.Core
if (Test-Path (Join-Path (Split-Path $wv.Core) 'Microsoft.Web.WebView2.WinForms.dll')) {
  Add-Type -Path (Join-Path (Split-Path $wv.Core) 'Microsoft.Web.WebView2.WinForms.dll')
}
[Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath((Split-Path $wv.Loader))

$coreType = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]

# 消息泵：绝不在事件处理器里同步等待 WebView2 的 Task，那会自我死锁。
function Wait-Pumped {
  param($Task, [int]$TimeoutMs = 30000)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not $Task.IsCompleted) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 15
    if ($sw.ElapsedMilliseconds -gt $TimeoutMs) { throw "等待超时（${TimeoutMs}ms）" }
  }
  $Task.GetAwaiter().GetResult()
}
function Pump-For {
  param([int]$Ms)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $Ms) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 20
  }
}

# ── 3. 窗口 ─────────────────────────────────────────────────────────────────
# 声明 DPI 感知后，WinForms 的 Size/Location 都按**逻辑像素**解释，
# 由系统换算成物理像素。所以这里保持逻辑值即可；但缩放比例要记下来，
# 用于给用户显示「实际物理尺寸」以及滚轮缩放的步进。
# 这里只拿一个**开机估值**：此刻窗口还没建出来，没有 HWND 可问，只能先按系统 DPI 撑个尺寸。
# 真的缩放必须在拿到 HWND 之后用 GetDpiForWindow 现算 —— 见下面的 Get-Scale。
$script:appliedScale = 1.0
# 用户滚轮放大的倍数。跨屏重设窗口时必须乘回去 ——
# 否则 Sync-Size 会把窗口弹回初始尺寸，等于悄悄吃掉用户的缩放。
$script:zoomK = 1.0
try {
  $bootDpi = [Dsh.Dpi]::GetDpiForSystem()
  if ($bootDpi -gt 0) { $script:appliedScale = $bootDpi / 96.0 }
} catch { $script:appliedScale = 1.0 }

<#
当前窗口所在那块屏的缩放（1.0 / 1.5 / 2.0 …）。

**必须现算，不能缓存。** 之前的写法是启动时 GetDpiForSystem() 算一次存进 $scale，
那个值是"系统 DPI"= 主显示器的 DPI，窗口在副屏时会算错；而且窗口被拖到另一块
不同缩放的屏上之后也不会更新。两个症状都表现为"拖动又开始不同步"：
  · 主屏 100% / 副屏 150%，桌宠在副屏启动 → 缩放算成 1.0，窗口只走鼠标的 2/3
  · 拖动跨到另一块屏 → 缩放还是旧的，立刻退回同样的毛病
GetDpiForWindow 问的是**这个 HWND 当前所在显示器**，一次 P/Invoke，开销可以忽略。
#>
function Get-Scale {
  try {
    if ($form -and $form.Handle -ne [IntPtr]::Zero) {
      $d = [Dsh.Dpi]::GetDpiForWindow($form.Handle)
      if ($d -gt 0) { return $d / 96.0 }
    }
  } catch { }
  return $script:appliedScale
}

<#
跨屏之后把窗口尺寸重新套一遍（物理尺寸 = 逻辑尺寸 × 该屏缩放）。

不处理 WM_DPICHANGED 也能做到这件事：直接按当前 HWND 的 DPI 比对，变了就重设。
比子类化 WndProc 稳，也不依赖 WinForms 对无边框窗口的行为。
#>
function Sync-Size {
  $s = Get-Scale
  if ([math]::Abs($s - $script:appliedScale) -lt 0.001) { return }
  $script:appliedScale = $s
  $w = [int][math]::Round($Width * $script:zoomK * $s)
  $h = [int][math]::Round($Height * $script:zoomK * $s)
  $script:physW = $w
  $script:physH = $h
  try {
    $form.Size = New-Object System.Drawing.Size($w, $h)
    Log "DPI 变成 $([math]::Round($s*100))%，窗口重设为 ${w}x${h}"
  } catch { }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH Live2D'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $false
# TopMost 只声明一次是不够的：实测一个覆盖全屏的浏览器窗口会把桌宠整个盖住，
# 于是鼠标全落到浏览器上（「点击穿透到下一层」的真实原因）。真正的置顶靠下面的
# SetWindowPos(HWND_TOPMOST) + 周期性重申。
$form.TopMost = $true
$form.MinimumSize = New-Object System.Drawing.Size(160, 200)
# 声明 DPI 感知后，WinForms 把 Size 当**物理像素**。要维持同样的视觉大小，
# 必须乘上缩放：否则 340 物理像素在 150% 下只有 227 逻辑像素，窗口看着变小。
# 乘完之后物理窗口 = 510×690，页面 CSS 视口回到 340×460，
# canvas 后备缓冲 510×690 与屏幕 1:1 —— 这正是「原版精度」。
$script:physW = [int][math]::Round($Width * $script:appliedScale)
$script:physH = [int][math]::Round($Height * $script:appliedScale)
$form.Size = New-Object System.Drawing.Size($script:physW, $script:physH)
Log "窗口尺寸：逻辑 ${Width}x${Height} → 物理 $($script:physW)x$($script:physH)（开机估值 DPI 缩放 $([math]::Round($script:appliedScale*100))%）"

# 记位置，下次开在同一处（存 %LOCALAPPDATA%）
#
# 恢复前必须**校验这个位置现在还在不在屏幕上**：位置是上次退出时存的，中间可能
# 拔过副屏、改过分辨率、或者被拖到了负坐标（实测存到过 x=-48）。存进去的位置
# 在新显示器布局里可能整个落在屏幕外 —— 窗口照样创建、进程照样活着，
# 但人什么都看不见，表现和「桌宠没起来」一模一样。
function Test-PosVisible {
  param([int]$X, [int]$Y)
  # 单位必须统一：$X/$Y 和 WorkingArea 都是**物理**像素，所以窗口尺寸也得用物理的
  # （$physW/$physH）。这里原先用的是 $Width/$Height（逻辑值），150% 下把窗口
  # 少算了 1/3，判断会偏松。
  $need = 80
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $wa = $s.WorkingArea
    $ix = [Math]::Min($X + $physW, $wa.Right) - [Math]::Max($X, $wa.Left)
    $iy = [Math]::Min($Y + $physH, $wa.Bottom) - [Math]::Max($Y, $wa.Top)
    if ($ix -ge $need -and $iy -ge $need) { return $true }
  }
  return $false
}

$posFile = Join-Path $env:LOCALAPPDATA 'dsh-live2d-pet.pos'
$defaultPos = {
  # WorkingArea 是物理像素，所以这里也用物理尺寸
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  New-Object System.Drawing.Point(($wa.Right - $physW - 40), ($wa.Bottom - $physH - 40))
}
$placed = $false
if (Test-Path $posFile) {
  try {
    $p = Get-Content -LiteralPath $posFile -Raw | ConvertFrom-Json
    $sx = [int]$p.x; $sy = [int]$p.y
    if (Test-PosVisible -X $sx -Y $sy) {
      $form.Location = New-Object System.Drawing.Point($sx, $sy)
      $placed = $true
    } else {
      Log "记住的位置 ($sx,$sy) 已不在任何屏幕内，改用默认位置"
    }
  } catch { Log "位置文件读不出来，改用默认位置：$($_.Exception.Message)" }
}
if (-not $placed) { $form.Location = & $defaultPos }
# 透明方案：**不用** TransparencyKey 抠像，改用 DWM 合成。
#
# 为什么不用 TransparencyKey（代价最大的一条教训）：
# 它会让窗口变成 WS_EX_LAYERED **分层窗口**，而 Windows 对分层窗口的鼠标命中测试
# 是**按 GDI 位图**判断的。WebView2 的内容走 GPU 合成、根本不进 GDI 位图 ——
# 于是整个窗口位图都是抠像色，被判为「全透明」，**每一次点击都穿透到下一层**。
# 加多少 SetWindowPos(HWND_TOPMOST) 都没用：窗口在最上层，但对鼠标是「不存在」的。
#
# DWM 方案：窗口保持**非分层**（鼠标能命中），把客户区交给 DWM 合成，
# 再让 WebView2 用 DefaultBackgroundColor=Transparent 把页面背景做透明。
# 两边配合，桌面就透出来了，而点击仍然落在形象上。
$form.BackColor = [System.Drawing.Color]::Black

# ── 4. 承载 WebView2（纯 Core API，不依赖 WinForms 包装） ───────────────────
# 自动播放策略：WebView2 默认「用户没交互过就不许出声」。
# 但桌宠是主动说话的，永远不会先有那个手势 —— 不放行的话语音永远静音
# （报错原文：play() failed because the user didn't interact with the document first）。
# 用环境变量传参，而不是 CoreWebView2EnvironmentOptions 对象 ——
# 后者在这个 SDK 版本里没有可用构造函数（New-Object 直接报
# "A constructor was not found"），环境变量这条路更稳。
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--autoplay-policy=no-user-gesture-required'
$env2 = Wait-Pumped ($coreType::CreateAsync($null, (Join-Path $env:LOCALAPPDATA 'dsh-live2d-pet'), $null))
Log "WebView2 运行时: $($env2.BrowserVersionString)（已放行自动播放）"

$form.Show()
Pump-For 250

# 句柄现在才存在，这时候问到的才是「窗口所在那块屏」的 DPI。
# 开机估值用的是系统 DPI（主屏），桌宠开在副屏或副屏缩放不同时那一步是错的。
Sync-Size

# 跨屏不会自动通知我们（没子类化 WndProc），用个 1 秒的钟盯着就够 ——
# 只在缩放真的变了才重设窗口，平时只是一次 P/Invoke。
$script:dpiWatch = New-Object System.Windows.Forms.Timer
$script:dpiWatch.Interval = 1000
$script:dpiWatch.Add_Tick({ Sync-Size })
$script:dpiWatch.Start()

# 穿透判定：120ms 一次。拖动/缩放期间光标一定在人身上，天然不会误触发。
$script:passWatch = New-Object System.Windows.Forms.Timer
$script:passWatch.Interval = 120
$script:passWatch.Add_Tick({ Update-PassThrough })
$script:passWatch.Start()

# 开启 DWM 透明：把整个客户区交给 DWM 合成（MARGINS 全 -1 = 铺满）。
# 必须在窗口显示之后调用；只对非分层窗口有效（正是我们要的）。
try {
  $margins = New-Object Dsh.Top+MARGINS
  $margins.LeftWidth = -1; $margins.RightWidth = -1; $margins.TopHeight = -1; $margins.BottomHeight = -1
  $hr = [Dsh.Top]::DwmExtendFrameIntoClientArea($form.Handle, [ref]$margins)
  Log "DWM 透明：DwmExtendFrameIntoClientArea hr=$hr（0=成功）"
} catch {
  Log "DWM 透明失败（窗口将是不透明的）：$($_.Exception.Message)"
}

# 强制置顶：Form.TopMost 会被后来的前台窗口压过去。
#
# 实测结论：一个覆盖全屏的 Edge 浏览器窗口（topmost=False）能把桌宠整个盖住，
# 该矩形内 WindowFromPoint 全部命中浏览器进程，鼠标因此全落到浏览器上 ——
# 这就是「点击直接点到下一层」的真实原因。不是透明穿透，也不是 Z 序被抢。
#
# 修法：显式 SetWindowPos(HWND_TOPMOST)，并在心跳里检测「是否被盖住」后重申。
# 关键细节：**不加 WS_EX_NOACTIVATE**。加了它窗口永不被激活，实测 topmost 会被
# 前台窗口立刻压回（心跳日志里每 5 秒报一次「被盖住」）。不抢焦点靠 NOACTIVATE 标志
# 传给 SetWindowPos 就够了 —— 那只是「不因这次调用而激活」，不是「永远不可激活」。
$script:topmostReasserts = 0
function Assert-TopMost {
  param([string]$Why = '')
  try {
    $ex = [Dsh.Top]::GetWindowLong($form.Handle, [Dsh.Top]::GWL_EXSTYLE)
    # 只在任务栏隐藏（像个贴纸），不要 NOACTIVATE
    $newEx = ($ex -bor [Dsh.Top]::WS_EX_TOOLWINDOW) -band (-bnot [Dsh.Top]::WS_EX_NOACTIVATE)
    [Dsh.Top]::SetWindowLong($form.Handle, [Dsh.Top]::GWL_EXSTYLE, $newEx) | Out-Null
    $flags = [Dsh.Top]::SWP_NOMOVE -bor [Dsh.Top]::SWP_NOSIZE -bor [Dsh.Top]::SWP_NOACTIVATE -bor [Dsh.Top]::SWP_SHOWWINDOW
    [Dsh.Top]::SetWindowPos($form.Handle, [Dsh.Top]::HWND_TOPMOST, 0, 0, 0, 0, $flags) | Out-Null
    # SetWindowPos 之后再来一次 BringWindowToTop：某些前台窗口（尤其是全屏浏览器）
    # 会在我们之后重排 Z 序，只靠 SetWindowPos 会被立刻压回。
    [Dsh.Top]::BringWindowToTop($form.Handle) | Out-Null
    $script:topmostReasserts++
    if ($Why) { Log "置顶已重申（$Why，第 $($script:topmostReasserts) 次）" }
  } catch {
    Log "置顶失败：$($_.Exception.Message)"
  }
}
Assert-TopMost '启动'

$createMethod = $env2.GetType().GetMethods() |
  Where-Object { $_.Name -eq 'CreateCoreWebView2ControllerAsync' -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1
$controller = Wait-Pumped ($createMethod.Invoke($env2, @([IntPtr]$form.Handle)))
Log '控制器已建立'
Assert-TopMost '控制器就绪后'

$syncBounds = {
  try {
    $controller.Bounds = New-Object System.Drawing.Rectangle(0, 0, $form.ClientSize.Width, $form.ClientSize.Height)
  } catch { }
}
& $syncBounds
if (-not $NoTransparent) {
  try { $controller.DefaultBackgroundColor = [System.Drawing.Color]::Transparent }
  catch { Log "透明背景设置失败（改用不透明）：$($_.Exception.Message)" }
}

# 关掉右键菜单与状态栏，纯粹一点
try {
  $controller.CoreWebView2.Settings.AreDefaultContextMenusEnabled = $false
  $controller.CoreWebView2.Settings.IsStatusBarEnabled = $false
  $controller.CoreWebView2.Settings.AreDevToolsEnabled = $false
} catch { }

$controller.CoreWebView2.Navigate($Url.TrimEnd('/') + '/live2d/pet')
Log "已加载 $Url/live2d/pet"

# ── 5. 拖动与缩放：由页面 postMessage 发起 ──────────────────────────────
#
# 为什么不在 Form 上挂 MouseDown/MouseMove：WebView2 的控制器铺满整个客户区，
# 会接走所有鼠标事件，Form 的鼠标事件**永远不触发** —— 早先那段拖动代码从未生效。
# 所以拖动必须在页面里发起，通过 WebViewMessageReceived 传进来。
#
# **dx/dy 是 CSS 像素，必须乘 DPI 缩放换成物理像素。**
#
# 原先这里写着「screenX/screenY 是屏幕物理坐标，不用乘 DPI 缩放」—— 这句是错的。
# 按 CSSOM View 规范，MouseEvent.screenX/screenY 的单位是 **CSS 像素**，不是物理像素。
# 而本窗口为了「原版精度」把物理尺寸设成了 逻辑×缩放（见上面第 3 节），
# 于是页面 CSS 视口是 340×460、物理窗口是 510×690，devicePixelRatio = 缩放 = 1.5。
# 结果：鼠标实际移动 150 物理像素，screenX 只增加 100；而 $form.Location 是物理像素，
# 加 100 就只走了 100 —— **窗口位移只有鼠标的 2/3**，越拖越落后。
#
# 另外必须累积小数余量：1.5 倍下每 1 CSS 像素 = 1.5 物理像素，逐帧四舍五入会把
# 慢速拖动的那 0.5 像素一次次丢掉，长距离下来仍然会漂。
$script:lastDragLog = [datetime]::MinValue
$script:dragResidualX = 0.0
$script:dragResidualY = 0.0

# ── 5b. 空白处穿透 ────────────────────────────────────────────────────────
#
# 窗口是透明铺满的，WebView2 会把整个矩形的鼠标都吃掉：在她的空白处点一下，
# 什么也不会发生，桌面上被盖住的东西反而点不到 —— 对桌宠来说这很不对。
#
# 做法：页面把「身体的可点矩形」报过来（css 像素，和戳击/拖动同一个判据），
# 外壳每 120ms 看一次光标在不在这个矩形里，不在就把 WS_EX_TRANSPARENT 挂上。
# 挂上之后窗口完全不参与命中测试，点击直接落到下一层。
#
# 为什么不用 WM_NCHITTEST 返回 HTTRANSPARENT：那需要子类化 WndProc，
# 在 PowerShell 里代价高、还容易和 WinForms 自己的消息处理打架。
# 轮询一次 GetCursorPos 便宜得多，而且能顺手处理「窗口被拖走/换 DPI」。
$script:hitbox = $null          # 页面报来的可点矩形（CSS 像素）
$script:mask = $null            # 页面报来的轮廓位图 { cols, rows, bits }
$script:passThrough = $false    # 当前是否已挂上穿透

function Set-PassThrough {
  param([bool]$On)
  if ($script:passThrough -eq $On) { return }
  $script:passThrough = $On
  try {
    $ex = [Dsh.Top]::GetWindowLong($form.Handle, [Dsh.Top]::GWL_EXSTYLE)
    if ($On) { $ex = $ex -bor [Dsh.Top]::WS_EX_TRANSPARENT }
    else { $ex = $ex -band (-bnot [Dsh.Top]::WS_EX_TRANSPARENT) }
    [void][Dsh.Top]::SetWindowLong($form.Handle, [Dsh.Top]::GWL_EXSTYLE, $ex)
  } catch { }
}

function Update-PassThrough {
  if ($null -eq $script:hitbox) { return }
  try {
    $pt = New-Object Dsh.Top+POINT
    if (-not [Dsh.Top]::GetCursorPos([ref]$pt)) { return }
    # 光标换算成窗口内的 CSS 像素（页面报来的矩形就是这个坐标系）
    $dpiScale = Get-Scale
    if ($dpiScale -le 0) { return }
    $cx = ($pt.X - $form.Location.X) / $dpiScale
    $cy = ($pt.Y - $form.Location.Y) / $dpiScale
    $h = $script:hitbox
    $inside = ($cx -ge $h.x -and $cx -le ($h.x + $h.w) -and $cy -ge $h.y -and $cy -le ($h.y + $h.h))

    # 有轮廓就按轮廓判：矩形四角明明空着，却也会吃掉点击。
    # 轮廓采不到（页面那边读不回 alpha）时 $inside 保持矩形结果 —— 粗一点也认了。
    $m = $script:mask
    if ($inside -and $null -ne $m -and $m.cols -gt 0) {
      $mx = [int][math]::Floor(($cx - $h.x) / $h.w * $m.cols)
      $my = [int][math]::Floor(($cy - $h.y) / $h.h * $m.rows)
      if ($mx -lt 0) { $mx = 0 }
      if ($mx -ge $m.cols) { $mx = $m.cols - 1 }
      if ($my -lt 0) { $my = 0 }
      if ($my -ge $m.rows) { $my = $m.rows - 1 }
      $inside = ($m.bits.Substring($my * $m.cols + $mx, 1) -eq '1')
    }

    Set-PassThrough (-not $inside)
  } catch { }
}

$controller.CoreWebView2.Add_WebMessageReceived({
  param($s, $e)
  try {
    $msg = $e.WebMessageAsJson | ConvertFrom-Json
    switch ($msg.type) {
      'drag' {
        # CSS 像素 → 物理像素，带上一次没走完的零头。
        # 缩放**现算**：窗口可能刚被拖到另一块不同 DPI 的屏上，
        # 沿用启动时的旧值就会立刻退回"窗口位移只有鼠标的 2/3"。
        # （变量不能叫 $s —— 那是上面 param 里的 sender。）
        $dpiScale = Get-Scale
        $rawX = ([double]$msg.dx * $dpiScale) + $script:dragResidualX
        $rawY = ([double]$msg.dy * $dpiScale) + $script:dragResidualY
        $dx = [int][math]::Round($rawX)
        $dy = [int][math]::Round($rawY)
        $script:dragResidualX = $rawX - $dx
        $script:dragResidualY = $rawY - $dy
        if ($dx -eq 0 -and $dy -eq 0) { return }
        $form.Location = New-Object System.Drawing.Point(
          ($form.Location.X + $dx),
          ($form.Location.Y + $dy))
        # 拖动日志按秒节流，否则会把日志刷爆
        if (((Get-Date) - $script:lastDragLog).TotalSeconds -gt 1) {
          $script:lastDragLog = Get-Date
          Log "拖动 → 窗口位置 $($form.Location.X),$($form.Location.Y)（本次 d=${dx},${dy} 物理 / $($msg.dx),$($msg.dy) CSS，缩放 $([math]::Round($dpiScale*100))%）"
        }
      }
      'hitbox' {
        # 页面报来身体的可点矩形（CSS 像素）。null 表示"还没布局好"，保持现状。
        $script:hitbox = @{
          x = [double]$msg.x; y = [double]$msg.y
          w = [double]$msg.w; h = [double]$msg.h
        }
      }
      'mask' {
        # 轮廓位图：rows 行 cols 列，bits 是 '0'/'1' 串。cols=0 表示这次没采到。
        $bits = [string]$msg.bits
        if ([int]$msg.cols -gt 0 -and $bits.Length -eq ([int]$msg.cols * [int]$msg.rows)) {
          $script:mask = @{ cols = [int]$msg.cols; rows = [int]$msg.rows; bits = $bits }
        } else {
          $script:mask = $null
        }
      }
      'zoom' {
        # 每档 8% 物理像素，并保持长宽比
        $step = if ([int]$msg.delta -gt 0) { 1.08 } else { 1 / 1.08 }
        $newW = [int][math]::Round($form.Width * $step)
        $newH = [int][math]::Round($form.Height * $step)
        $newW = [Math]::Max(160, [Math]::Min(2000, $newW))
        $newH = [Math]::Max(200, [Math]::Min(2400, $newH))
        $form.Size = New-Object System.Drawing.Size($newW, $newH)
        # 用**实际落到的尺寸**反推倍数：被 Max/Min 夹过之后，按 8% 递增推会算错。
        $curScale = Get-Scale
        if ($curScale -gt 0) { $script:zoomK = [double]$form.Width / ($Width * $curScale) }
        & $syncBounds
        Log "缩放 → 物理 ${newW}x${newH}（倍数 $([math]::Round($script:zoomK*100))%）"
      }
    }
  } catch {
    Log "处理页面消息失败：$($_.Exception.Message)"
  }
})

$form.Add_Resize({ & $syncBounds })

# 退出原因要告诉 Host，否则它分不清「用户主动关的」和「自己死掉的」。
# 前者要尊重（别再弹回来），后者必须重生 —— 否则就变成用户报的那个现象：
# 桌宠自己退了，插件还开着，屏幕上什么都没有，只能关掉插件再打开。
$script:exitReason = 'unknown'

# 记住位置；Esc / 双击标题区外的右键菜单都没有，用 Ctrl+Q 退出
$form.Add_FormClosing({
  try { @{ x = $form.Location.X; y = $form.Location.Y } | ConvertTo-Json | Set-Content -LiteralPath $posFile -Encoding UTF8 } catch { }
  # 只上报「不是用户关的」。用户主动关的不用报 —— 报不报 Host 都不该重生它。
  if ($script:exitReason -ne 'user') {
    try {
      $u = ($Url.TrimEnd('/') + '/live2d/pet-exit?reason=' + $script:exitReason)
      Invoke-WebRequest -Uri $u -TimeoutSec 3 -UseBasicParsing | Out-Null
      Log "已上报退出原因：$($script:exitReason)"
    } catch { Log "上报退出原因失败（不影响退出）：$($_.Exception.Message)" }
  }
})
$form.KeyPreview = $true
$form.Add_KeyDown({
  param($s, $e)
  if ($e.Control -and $e.KeyCode -eq [System.Windows.Forms.Keys]::Q) { $script:exitReason = 'user'; $form.Close() }
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $script:exitReason = 'user'; $form.Close() }
})

# ── 6. 心跳：DSH 一停，桌宠自己也退场（「只有 DSH 开着才醒」） ────────────
#
# 两次误判都出在这个心跳里，都是实测踩到的：
#
# (1) 离线误判 —— 原先**一次探测失败就退出**，而探测打的是 `/live2d/manifest`，
#     那是插件自己的路由。宿主忙一下、请求超过 5 秒，就被判成「DSH 已离线」，
#     桌宠当场退场（日志里就是这么写的），而 DSH 其实好好的。
#     现在要求**连续失败**才退场，中间只要成功一次就把计数清零。
#
# (2) 置顶误判 —— `WindowFromPoint` 命中的是**最上层的子窗口**，而我们窗口里铺着
#     WebView2，那个子 HWND 属于 msedgewebview2.exe。拿它的 PID 和 $PID 比永远不等，
#     于是「被盖住」每 5 秒误报一次（实测刷到 323 次）。改成往上取根窗口比 HWND。
$script:offlineStrikes = 0
$script:offlineStrikesNeeded = 6   # 6 × 5s = 连续 30 秒探不通才算真离线

$heartbeat = New-Object System.Windows.Forms.Timer
$heartbeat.Interval = 5000
$heartbeat.Add_Tick({
  if (Test-Dsh $Url) {
    if ($script:offlineStrikes -gt 0) {
      Log "DSH 探测恢复正常（此前连续失败 $($script:offlineStrikes) 次）"
      $script:offlineStrikes = 0
    }
  } else {
    $script:offlineStrikes++
    if ($script:offlineStrikes -ge $script:offlineStrikesNeeded) {
      Log "DSH 已离线（连续 $($script:offlineStrikes) 次探测失败：$($script:probeError)），桌宠退出。"
      $script:exitReason = 'offline'
      $heartbeat.Stop()
      $form.Close()
      return
    }
    Log "DSH 探测失败第 $($script:offlineStrikes)/$($script:offlineStrikesNeeded) 次：$($script:probeError)"
  }
  # 每 5 秒重申一次置顶：别的程序（尤其是全屏浏览器）会把我们压下去，
  # 压下去之后鼠标就全落到它身上，表现为「点击穿透」。
  # 只在确实被压下去时才重申，避免无谓地刷日志。
  try {
    $cx = $form.Location.X + [int]($form.ClientSize.Width / 2)
    $cy = $form.Location.Y + [int]($form.ClientSize.Height / 2)
    $pt = New-Object Dsh.Top+POINT
    $pt.X = $cx; $pt.Y = $cy
    $hit = [Dsh.Top]::WindowFromPoint($pt)
    # 必须取根窗口：命中的通常是 WebView2 的子 HWND，它的属主是
    # msedgewebview2.exe，直接比 PID 会永远判成「被盖住」。
    $root = [Dsh.Top]::GetAncestor($hit, [Dsh.Top]::GA_ROOT)
    if ($root -ne $form.Handle) { Assert-TopMost '被其它窗口盖住' }
  } catch { }
})
$heartbeat.Start()

Log '桌宠已就位（Ctrl+Q 或 Esc 退出；拖动移动；滚轮缩放）'

# 自检用：让窗口在 N 毫秒后自动关闭，并把一次 DOM 状态写进文件。
# 写文件而不是 Write-Host：WinForms 事件处理器里的控制台输出在重定向时不可靠。
# 变量名刻意与上面的 $logFile（启动日志）区分开，别互相覆盖。
if ($SelfTestMs -gt 0) {
  $selfTestFile = Join-Path $env:TEMP 'dsh-live2d-pet-selftest.txt'
  Remove-Item -LiteralPath $selfTestFile -Force -ErrorAction SilentlyContinue
  Log "自检模式：${SelfTestMs}ms 后自动关闭，结果写入 $selfTestFile"
  $probe = New-Object System.Windows.Forms.Timer
  $probe.Interval = [Math]::Max(1500, $SelfTestMs - 1500)
  $probe.Add_Tick({
    $probe.Stop()
    $lines = @("window=$($form.Bounds)", "runtime=$($env2.BrowserVersionString)")
    try {
      # 自检要能回答「到底连上没有」，所以把状态栏文本、最近一次轮询结果、
      # 以及 Host 侧的 state 一并报出来 —— 只报 pixi/canvas 是看不出连接死活的。
      $js = "JSON.stringify({href:location.href,stage:!!document.getElementById('stage'),canvas:document.querySelectorAll('canvas').length,pet:!!window.__pet,pixi:typeof window.PIXI,cubism:typeof window.Live2DCubismCore,scale:(window.__pet&&window.__pet.model)?window.__pet.model.scale.x.toFixed(4):null,bounds:(window.__pet&&window.__pet.model)?(function(b){return b.width.toFixed(1)+'x'+b.height.toFixed(1)})(window.__pet.model.getBounds()):null,statusText:(document.getElementById('statusText')||{}).textContent||null,statusClass:(document.getElementById('status')||{}).className||null,petStatus:window.__petStatus||null,lastPollError:window.__lastPollError||null,pollCount:window.__pollCount||0,bubble:(document.getElementById('bubble')||{}).className||null})"
      $task = $controller.CoreWebView2.ExecuteScriptAsync($js)
      $text = Wait-Pumped $task 8000
      $lines += "DOM=$text"
      # 顺带直接问一次 Host，两边对照才能定位是「页面没轮询」还是「Host 没数据」
      try {
        $hostState = (Invoke-WebRequest -Uri ($Url.TrimEnd('/') + '/live2d/state') -TimeoutSec 4 -UseBasicParsing).Content
        $lines += "HOST_STATE=$hostState"
      } catch {
        $lines += "HOST_STATE_FAILED=$($_.Exception.Message)"
      }
    } catch {
      $lines += "PROBE_FAILED=$($_.Exception.Message)"
    }
    try {
      $ms = New-Object System.IO.MemoryStream
      $cap = $controller.CoreWebView2.CapturePreviewAsync([Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat]::Png, $ms)
      Wait-Pumped $cap 15000 | Out-Null
      $png = Join-Path $env:TEMP 'dsh-live2d-pet-selftest.png'
      [System.IO.File]::WriteAllBytes($png, $ms.ToArray())
      $lines += "CAPTURE=$png ($($ms.Length) bytes)"
    } catch {
      $lines += "CAPTURE_FAILED=$($_.Exception.Message)"
    }
    $lines | Set-Content -LiteralPath $selfTestFile -Encoding UTF8
    $form.Close()
  })
  $probe.Start()
}

[System.Windows.Forms.Application]::Run($form)
try { $controller.Close() } catch { }
Log '桌宠已退出。'







