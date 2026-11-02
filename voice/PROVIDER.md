# 语音接口：接你自己的模型

插件本身**不带语音模型**，也不训练任何东西。它只规定一个进程级的协议，
你写什么语言的 program 都行 —— Python、Node、Rust、或者你训练好的模型自带的启动器。

对外的开关只有三个配置项：

| 配置 | 环境变量 | 作用 |
|---|---|---|
| `speech: 'on'` | — | 打开语音（默认 `off`） |
| `speechRuntime` | `DSH_LIVE2D_RUNTIME` | 跑你的 worker 的解释器/可执行程序 |
| `speechWorker` | `DSH_LIVE2D_WORKER_PY` | 你的 worker 脚本路径 |
| `speechScript` | `DSH_LIVE2D_SPEAK_PY` | 文本前端（把气泡里的口语文本处理成待念文本），可选 |
| `speechTimeoutMs` | — | 单句合成超时，默认 120000 |

> `speechPython` / `DSH_LIVE2D_PYTHON` 是 `speechRuntime` 的旧名，仍然可用。

---

## 协议

worker 是一个**常驻子进程**，用 stdin/stdout 交换一行一条的 JSON。
（必须按行 —— 插件是按 `\n` 切的。）

### 1. 启动

进程起来后，先在 **stdout** 打一行：

```json
{"ready":true}
```

插件等到这一行才认为可用。**别省这一步**：没有它，插件会一直等到超时，
现象是「永远不出声」，很难查。

### 2. 收到一条合成请求

stdin 上会来一行：

```json
{"text":"今天这事儿有点难办。","out":"C:\\Users\\me\\AppData\\Local\\Temp\\dsh-live2d-voice\\v123.wav","steps":8}
```

| 字段 | 含义 |
|---|---|
| `text` | 要念的话。已经是口语化的短句（插件侧先精炼过，且有字数上限） |
| `out` | **必须**把音频写到这个绝对路径。格式 wav，容器随便（44.1k/单/双声道都行） |
| `steps` | 采样步数的建议值，只对扩散类模型有意义；用不上直接忽略 |

### 3. 回复

合成完，在 **stdout** 打一行：

```json
{"ok":true}
```

失败就：

```json
{"ok":false,"error":"模型没加载起来"}
```

`error` 会被插件记进日志并显示在诊断页里 —— 写得具体一点，别只写 "failed"。

---

## 两条硬性要求（都是踩过的）

1. **stderr 会被读走但丢弃。** 你可以往里打日志，但**必须让它流动** ——
   插件端在消费 stderr，不消费的话管道 64KB 一满，worker 卡在写、插件卡在读，
   双向死锁，现象还是「永远不出声」。

2. **不要自己起常驻的 shell 再调外部程序。** 插件停用时会 `taskkill /T` 杀整棵树，
   你自己派生的东西如果逃出了进程树，就会留成孤儿（SAPI 那套曾经留过）。

---

## 参考实现（开箱可用，不需要训练）

`voice/sapi-worker.ps1` 是同一套协议的最小实现，用 Windows 自带的 System.Speech。
音质一般，但**立刻能听到声音**，可以拿它验证接线通不通，再换成你自己的模型：

```yaml
# profile 的 patch 里
config:
  speech: 'on'
  speechRuntime: 'C:\Program Files\PowerShell\7\pwsh.exe'
  speechWorker: 'D:\path\to\dsh-live2d\voice\sapi-worker.ps1'
  speechScript: 'D:\path\to\dsh-live2d\voice\tts-front.py'   # 可选
```

## 换成一个训练好的模型

照上面三步写一个 worker 就行。常见的两种：

**模型带 Python 接口**（VITS / GPT-SoVITS / Bert-VITS2 / ddsp-svc 之类）：

```python
# worker.py
import sys, json
from your_model import load, synth

tts = load("checkpoints/best.pth")
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    if not line.strip():
        continue
    req = json.loads(line)
    try:
        synth(tts, req["text"], req["out"])          # 写成 wav
        print(json.dumps({"ok": True}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
```

**模型是个命令行程序**：worker 就变成一个壳，收 JSON、拼命令行、等它退出、回 ok。

---

## 这套接口为什么长这样

之前的版本把「SAPI + contentvec + ddsp-svc」整条链焊死在插件里，连 Python 依赖目录
都是写死的。结果是：想换模型得改插件源码，而当时那个模型的**内容保真度只有 0.47~0.55**
（清晰语音需要 0.9+）——听着有声音，但完全听不懂。

把模型换掉应该是**换一个 worker 文件**，不是改插件。所以现在插件只认三样：
运行时、worker、跑得起来。质量好坏、用什么架构、训了多少步，都是 provider 自己的事。
