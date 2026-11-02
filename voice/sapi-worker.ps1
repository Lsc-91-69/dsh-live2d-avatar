# sapi-worker.ps1 — 语音接口的参考实现（Windows 自带的 System.Speech）
#
# 它不是一个好听的 TTS，它是一个**能立刻跑通的例子**：证明协议是对的。
# 拿它验证接线之后，请换成你自己的模型（见同目录 PROVIDER.md）。
#
# 协议（一行一条 JSON）：
#   启动    → stdout: {"ready":true}
#   请求    ← stdin : {"text":"...","out":"C:\\...\\x.wav","steps":8}
#   回复    → stdout: {"ok":true}  或  {"ok":false,"error":"..."}
#
# 注意两件事：
#   1. 所有输出走显式的 UTF-8 流。用 [Console]::Out 在重定向时编码不确定，
#      中文会变成乱码，插件侧 JSON.parse 直接失败。
#   2. 每写完一行必须 flush。管道有缓冲，不 flush 的话插件那头永远等不到。

$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

function Reply($obj) {
    $stdout.WriteLine(($obj | ConvertTo-Json -Compress))
}

try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

    # 挑一个中文音色；没有就用系统默认（英文念中文会很难听，但至少能出声）
    $zh = $synth.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh*'
    } | Select-Object -First 1
    if ($zh) {
        try { $synth.SelectVoice($zh.VoiceInfo.Name) } catch { }
    }

    Reply @{ ready = $true }

    while ($null -ne ($line = $stdin.ReadLine())) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $req = $line | ConvertFrom-Json
            $text = [string]$req.text
            $out = [string]$req.out
            if ([string]::IsNullOrWhiteSpace($text) -or [string]::IsNullOrWhiteSpace($out)) {
                Reply @{ ok = $false; error = 'text/out 不能为空' }
                continue
            }
            $synth.SetOutputToWaveFile($out)
            $synth.Speak($text)
            $synth.SetOutputToNull()
            if (-not (Test-Path $out)) { throw "没写出文件：$out" }
            Reply @{ ok = $true }
        } catch {
            try { $synth.SetOutputToNull() } catch { }
            Reply @{ ok = $false; error = $_.Exception.Message }
        }
    }
} catch {
    Reply @{ ok = $false; error = "worker 启动失败：$($_.Exception.Message)" }
    exit 1
}
