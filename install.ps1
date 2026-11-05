#!/usr/bin/env pwsh
<#
.SYNOPSIS
    把 dsh-live2d-avatar 装进 DSH profile。

.DESCRIPTION
    做三件事，每件都是幂等的（重复跑不会重复写）：
      1. 在 profile 的 package.json 里登记 link 依赖
      2. 把这个 bundle 加进 dsh.profile.bundles
      3. 在 profile 目录里跑 pnpm install

    改 package.json 之前一定先备份 —— 这个文件是手改过很多次的那种，
    丢了很难重建。

.PARAMETER ProfileName
    要装进哪个 profile。默认 desktop。

.PARAMETER PluginPath
    插件本体在哪。默认就是本脚本所在的目录。

.PARAMETER SkipInstall
    只改配置，不跑 pnpm install（自己装依赖时用）。

.EXAMPLE
    ./install.ps1
    ./install.ps1 -ProfileName desktop
#>
[CmdletBinding()]
param(
    [string]$ProfileName = 'desktop',
    [string]$PluginPath = $PSScriptRoot,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Say($msg) { Write-Host "  $msg" }
function Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "  [x]  $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "dsh-live2d-avatar 安装程序" -ForegroundColor Cyan
Write-Host "────────────────────────────────────────────"

# ── 0. 定位 ────────────────────────────────────────────────────────────────
$plugin = (Resolve-Path $PluginPath).Path
if (-not (Test-Path (Join-Path $plugin 'cordis.patch.yml'))) {
    Die "这里不像插件目录（找不到 cordis.patch.yml）：$plugin"
}
Ok "插件目录 $plugin"

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
$profileJson = Join-Path $profileDir 'package.json'

if (-not (Test-Path $profileJson)) {
    $have = @()
    $root = Join-Path $dshHome 'profiles'
    if (Test-Path $root) { $have = @(Get-ChildItem $root -Directory | Select-Object -ExpandProperty Name) }
    Die ("找不到 profile '{0}'（{1}）。现有 profile: {2}" -f $ProfileName, $profileJson, ($have -join ', '))
}
Ok "profile $profileDir"

# 模型是插件自带的；没有模型装上也只是一块空白
$modelDir = Join-Path $plugin 'model'
if (Test-Path $modelDir) {
    $n = @(Get-ChildItem $modelDir -Recurse -File).Count
    Ok "自带模型 $n 个文件"
} else {
    Warn "插件目录里没有 model/ —— 装好之后要在配置里指定 modelDir，否则桌宠是空的"
}

# ── 1. 改 profile/package.json ─────────────────────────────────────────────
$raw = Get-Content $profileJson -Raw
$cfg = $raw | ConvertFrom-Json

$pkgName = 'dsh-live2d-avatar'
$linkSpec = 'link:' + ($plugin -replace '\\', '/')

# ConvertFrom-Json 出来的是 PSCustomObject；dependencies 可能是对象也可能是 $null
if ($null -eq $cfg.dependencies) {
    $cfg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$depNames = @($cfg.dependencies.PSObject.Properties.Name)
$changed = $false

if ($depNames -contains $pkgName) {
    $current = $cfg.dependencies.$pkgName
    if ($current -ne $linkSpec) {
        Say "依赖已存在，指向 $current —— 改成 $linkSpec"
        $cfg.dependencies.$pkgName = $linkSpec
        $changed = $true
    } else {
        Say "依赖已登记，无需改动"
    }
} else {
    $cfg.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue $linkSpec -Force
    $changed = $true
    Say "登记依赖 $pkgName -> $linkSpec"
}

if ($null -eq $cfg.dsh -or $null -eq $cfg.dsh.profile) {
    Die "profile 的 package.json 里没有 dsh.profile 段 —— 这不是一个 DSH profile，先别乱改"
}
$bundles = @($cfg.dsh.profile.bundles)
if ($bundles -contains $pkgName) {
    Say "bundle 已在列表里"
} else {
    $cfg.dsh.profile.bundles = @($bundles + $pkgName)
    $changed = $true
    Say "加入 bundle 列表"
}

if ($changed) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$profileJson.bak-before-live2d-install-$stamp"
    Copy-Item $profileJson $backup
    Ok "已备份到 $(Split-Path $backup -Leaf)"
    # 用 4 空格缩进写回，和 DSH 自己的写法一致，diff 才好看
    ($cfg | ConvertTo-Json -Depth 20) | Set-Content $profileJson -Encoding UTF8
    Ok "写入 $profileJson"
} else {
    Say "配置无需改动"
}

# ── 2. pnpm install ────────────────────────────────────────────────────────
if ($SkipInstall) {
    Warn "跳过 pnpm install（-SkipInstall）—— 别忘了自己装"
} else {
    $pnpm = $null
    foreach ($c in @(
        (Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'),
        (Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    )) {
        if ($c -and (Test-Path $c)) { $pnpm = $c; break }
    }

    if (-not $pnpm) {
        Warn "找不到 pnpm。手动在 profile 目录跑一次 pnpm install："
        Say "  cd `"$profileDir`" && pnpm install"
    } else {
        Say "pnpm: $pnpm"
        Push-Location $profileDir
        try {
            if ($pnpm -like '*.mjs') {
                & node $pnpm install --silent
            } else {
                & $pnpm install --silent
            }
            if ($LASTEXITCODE -ne 0) { Die "pnpm install 失败（exit $LASTEXITCODE）" }
            Ok "依赖已安装"
        } finally {
            Pop-Location
        }
    }
}

# ── 3. 下一步 ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "装好了。还要两步：" -ForegroundColor Cyan
Say "1) 重启 DSH（bundle 列表只在启动时读）"
Say "2) 起来之后验证："
Say "     Invoke-RestMethod http://127.0.0.1:<端口>/live2d/manifest | ConvertTo-Json -Depth 3"
Say "   返回 ok=true 且 expressions 有内容，就说明模型也通了。"
Write-Host ""
Say "桌宠会自动出现在桌面右下角。要关掉它：插件配置里设 desktopPet: 'off'。"
Say "要换成自己的模型：插件配置里设 modelDir（Cubism 3/4 格式）。"
Write-Host ""
