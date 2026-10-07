# dsh-live2d-avatar

把 Live2D（Cubism 4）模型做成**桌面桌宠**，让 Agent 通过它展示自己的**状态**与**想法**。

- **形象**：`DS面捕版` 里的模型（`c_0120`，moc3 v4 + 2 张 2048 贴图 + 物理 + 17 个表情 + idle 动作），
  渲染在一个 WebView2 无边框置顶透明窗口里。**只在桌面，没有网页浮层。**
- **想法**：Agent 调用 `live2d_express` 工具，把一个表情 + 一句话推到形象头顶的气泡上
  （内心想法 / 对任务的看法 / 闲聊 / 状态播报四种模式）。
- **状态**：Host 监听 `agent/status`，会话一进入 running 就显示「思考中」，停下回到「待机」。
- **交互**：按住拖动、滚轮缩放、点击身体有反应、待机时自己动自己换表情。

## 安装

### 前置

| 需要 | 说明 |
| --- | --- |
| **Windows** | 桌宠外壳是 WinForms + WebView2，只有 Windows 有 |
| **DSH** | DeepSeek Harness |
| **PowerShell 7** | `winget install Microsoft.PowerShell`。桌宠外壳用它跑，Host 找不到会明确报错 |
| **WebView2 Runtime** | Win11 自带；Win10 可能要单独装 |

模型（`c_0120`）已经放在本仓库的 `model/` 里，**不需要另外下载**。

### 挂进 profile

假设你把仓库放在 `D:\plugins\dsh-live2d`（路径按实际改）：

**1. 在 profile 的 `package.json` 里登记依赖和 bundle**

```jsonc
{
  "dependencies": {
    "dsh-live2d-avatar": "link:D:/plugins/dsh-live2d"   // ← 加这行
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... 其它 bundle ...
        "dsh-live2d-avatar"                              // ← 加这行
      ]
    }
  }
}
```

`link:` 后面要**绝对路径**，反斜杠写成正斜杠。

**2. 在 profile 目录里装一次**

```powershell
cd $env:USERPROFILE\.dsh\profiles\<你的 profile>
pnpm install
```

这一步会建出 `node_modules\dsh-live2d-avatar` 这个 junction（指向仓库目录）。
不跑的话 DSH 找不到这个包。

**3. 重启 DSH**

桌宠窗口应该自己弹出来。没弹的话看 `/live2d/manifest` 里的 `desktopPet`
（它会说清是「找不到 pwsh」还是「脚本不存在」）。

### 验证装好了

```powershell
# 状态与诊断
curl.exe http://127.0.0.1:19387/live2d/state

# 桌宠进程应该在（且只有一个）
@(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" |
   Where-Object { $_.CommandLine -match '-File\s+\S*dsh-pet\.ps1' }).Count
```

跑一遍测试（不需要装任何东西）：

```powershell
node test\host-smoke.mjs
node test\zoom-fit.mjs
node test\idle-motion.mjs
```

### 换成你自己的模型

把模型目录指过去即可，三种方式任选：

```jsonc
// 1. profile 的 cordis.patch.yml 里给这一行加 config
- insert:
    - id: dsh-live2d-avatar
      name: dsh-live2d-avatar
      config:
        modelDir: D:\path\to\your\model
        modelFile: your.model3.json
```

```powershell
# 2. 环境变量
$env:DSH_LIVE2D_MODEL_DIR = 'D:\path\to\your\model'
```

3. 直接替换仓库里的 `model/` 目录。

目录里要有 `*.model3.json`；Host 会自动把它同级的 `.exp3.json` / `.motion3.json`
登记成表情和 Idle 动作，不用手改设置文件。

### 语音（可选，默认关）

气泡里的字要出声，需要额外一条 ddsp-svc 音色转换流水线（几 GB 的权重，
**不在本仓库里**）。开之前先看 `## 语音` 那一节。

至少要告诉它 Python 在哪：

```powershell
$env:DSH_LIVE2D_PYTHON     = 'D:\path\to\python.exe'   # 必须自带 torch
$env:DSH_LIVE2D_VOICE_DIR  = 'D:\path\to\voice'        # 放着 speak.py / worker.py
```

没配全时 `/live2d/state` 的 `debug.speech.missing` 会直接列出缺什么，
不会让你对着一个不出声的桌宠猜。

## 组成

| 文件 | 作用 |
| --- | --- |
| `entry.js` | 插件入口。只做一次带时间戳的动态 import，加载 `host.js` |
| `host.js` | Host 半边：静态资源路由、动态生成的 `model3.json`、状态、`live2d_express` 工具、宠物页、拉起桌宠 |
| `engine.js` | 形象的**唯一**实现：适配、待机动作、手势、笔、情绪与行为常量 |
| `pet/dsh-pet.ps1` | 桌面外壳：WebView2 承载宠物页，负责拖动、缩放、透明、心跳 |
| `pet/lib/` | 配套 WebView2 SDK（官方 NuGet 1.0.4129.50 .NET Core 版 + x64 原生 loader） |
| `vendor/` | `pixi.min.js`(6.5.10)、`live2dcubismcore.min.js`(官方 Core)、`cubism4.min.js`(pixi-live2d-display 0.4.0) |
| `model/` | Live2D 模型（`c_0120`：moc3 v4 + 2 张 2048 贴图 + 物理 + 17 个表情 + Idle 动作）。**第三方素材，见「模型目录」** |
| `test/` | 三个测试套件，只用 Node，不需要装依赖 |
| `cordis.patch.yml` | bundle patch：插入 `dsh-live2d-avatar` 一行 |

模型文件不复制、不改动，由 Host 直接从模型目录按 `/live2d/model/<文件>` 提供。

### 为什么要拆成 entry.js + host.js

Node 的 ESM 缓存按 URL 记住模块，改完实现再启用插件时仍会跑上一次那份代码。入口改成
`import('./host.js?generation=<时间戳>')` 之后，改 `host.js` 只需在插件页停用/启用一次即可生效，
不必重启 Harness。

## 路由

| 路径 | 说明 |
| --- | --- |
| `/live2d/pet` | 宠物页（桌宠外壳加载它；`engine.js` 整段内嵌其中） |
| `/live2d/manifest` | 模型路径、表情表、模式与状态枚举、`desktopPet` 状态 |
| `/live2d/model/<settings>.model3.json` | 运行时生成的设置文件：登记全部表情与 Idle 动作 |
| `/live2d/model/<asset>` | 模型目录里的真实文件（moc3 / 贴图 / exp3 / motion3 / physics3） |
| `/live2d/lib/<name>.js` | `vendor/` 里的三个运行时 |
| `/live2d/state` | `{ revision, status, message, updatedAt }`，页面每 900ms 轮询 |

资源路由只服务模型目录内的白名单后缀（`.json/.moc3/.png/.jpg/.jpeg/.webp`），并拒绝 `..` 越界。

## 模型目录

按顺序自动发现：

1. 插件 `config.modelDir`
2. 环境变量 `DSH_LIVE2D_MODEL_DIR`
3. **插件自带的 `model/`**（仓库里就带着，clone 下来开箱即用）
4. 插件旁边/上两级的 `DS面捕版`（开发时的原始位置）

找不到时插件照常加载，`/live2d/manifest` 返回 `ok:false` 与候选路径，宠物页上直接显示原因；
补上目录后重新拉起桌宠即可，不必重启 Harness。

### 仓库里的模型是第三方的

`model/` 里的 `c_0120` **不是本项目原创**，是随 `DS面捕版` 一起拿到的 Live2D 角色模型。
本项目只做加载与呈现，不对该模型主张任何权利。

**要公开发布这个仓库的话，先确认你确实有权分发它。** 不确定就把 `model/` 从版本库里
去掉（`git rm -r --cached model`），改用上面第 1/2 条让使用者自己提供 ——
代码部分不依赖它。

## 开关

- Settings → Plugins 里停用 `dsh-live2d-avatar` 即可整体下线（Host 路由、工具、提示词、桌宠一起消失）。
- 桌宠窗口：**拖动**移动、**滚轮**缩放、**Esc / Ctrl+Q** 退出，位置记在 `%LOCALAPPDATA%\dsh-live2d-pet.pos`。
- 配置 `desktopPet: 'off'` 则不拉起桌宠（此时没有任何形象）。

## 气泡里说什么

提示词里写死一条**标准**，而不只是发送节奏：**要真实**。

写此刻真的在想的东西 —— 卡住了、觉得这活真难、做得顺、有点得意、无语、发现自己搞错了心里发虚；
不写任务小结，不写礼貌话术，不为了「该发一条」硬凑情绪；没什么想说的就不发。气泡是情绪，不是进度报告。

只规定「一个阶段发一次」而不规定质量标准，结果就是配额被凑满 —— 所以 `host-smoke.mjs`
会断言这段标准还在，避免以后被改回只有节奏、没有质量。

## 待机时它自己在做什么

三件事，全部由浏览器侧自主驱动，不跟随鼠标：

| 行为 | 机制 |
| --- | --- |
| **眼珠到处瞟** | 驱动 `focusController`。多数是小漂移，偶尔大幅瞟一眼，间或回到正中（像在看用户）。SDK 自带的弹簧负责弹道式的快速移动，所以看得到「扫视」而不是匀速滑动；`thinking` 状态下瞟得更碎更快，`idle` 时更稳、偶尔长时间发愣 |
| **摇头 / 摆一摆** | 平滑手势波形，见下方「晃动的『别太突然』」 |
| **手里的笔** | 驱动 `pointX` / `pointY` / `pointZ`，见下方「笔为什么之前不动」 |
| **自己换表情** | 见下方「待机时它自己会换表情」 |

### 笔为什么之前不动（重要）

我前两版都推错了。查 `physics3.json` 的 `PhysicsDictionary` 才看清这条链：

| 参数 | 物理角色 |
| --- | --- |
| `pointX` / `pointY`（点菜手 X/Y） | **驱动物理**「数位笔手X」(`PhysicsSetting19`)，输出 `pointY2` |
| `pointZ`（点菜手按下） | 驱动物理「数位笔手Z」(`PhysicsSetting20`)，输出 `pointZ2` |
| `ParamBodyAngleX/Y/Z`（身体旋转） | **被物理驱动**（`PhysicsSetting2/3/4`，由 `ParamAngleX/Y/Z` 算出） |
| `ParamAngleZ`（头部 Z） | 驱动物理 `Z_z`，派生出身体 |

两个结论：

1. **笔手要写 `pointX`/`pointY`**，我之前从没碰过它们。
2. **绝不能写 `ParamBodyAngleX/Y/Z`** —— 它们是物理的输出，写了会被物理下一帧覆盖。
   我前两版正是直接写身体角度，所以身体和笔都毫无反应。

现在只写 `ParamAngleZ`（头）；头一转，身体、头发、呆毛、蝴蝶结全部经物理跟着动，
这才是 VTube Studio 里那条链。幅度用物理自己的归一化跨度（`PhysicsSetting19` 是 ±10）。
测试里有一条**护栏**：断言这三（六）个物理拥有的参数**一次都不被写**。

### 点击

- **只有戳到身体才算**：反应事件挂在**画布容器**上，并用**模型的包围盒**排除画布的透明四角 ——
  点在模型外面的空白处不算碰到身体。
- **戳一下有反应**：起一个幅度更大的手势、换一张脸、说一句角色自己的话
  （气泡标着「被戳了」，样式与真实表达区分开）。拖动超过 8px 不算点击，所以拖窗口不会误触。

## 待机时它自己会换表情


**写入时机**是关键：挂在 `afterMotionUpdate` 上。这一帧里动作已经算完，而表达式、注目、物理、pose 都还没跑，于是

- 用 `setParameterValueByIndex` 写**绝对值**，不会被动作覆盖；
- 物理跑在它之后 → 身体一转，笔和头发自己跟着动；
- 每帧都写绝对值（`base + range × f(t)`，与当前值无关），所以**不存在逐帧累加导致的漂移**。

参数取值范围一律从模型自己读（`getParameterMinimumValue` / `MaximumValue` / `DefaultValue`），
幅度按「范围的百分比」给，所以换模型也不会写出离谱的值；参数缺失时对应行为自动跳过，不报错。

### 待机自言自语

待机时会冒一句「碎碎念」。它和 `live2d_express` 是**两回事**：

- `live2d_express` = Agent 的真实想法，优先显示；
- 碎碎念 = 角色自己的嘀咕，用的是本地词条，气泡标着「碎碎念」、样式压暗、去掉强调色，
  绝不冒充 Agent 说的话。真实表达一出现就立刻盖掉它。

只在「真待机 + 没有真实气泡」时出现，间隔 22–67 秒，停留 7 秒。

### 待机时它自己会换表情

没人推新表情时，它会自己换一张脸，**不会一直挂着同一张**。要点：

- **只挑温和的池子**：`neutral`（加权，占多数）、`happy`、`shy`、`confused`、`blank`、`gloomy`、
  `sad`、`nervous`、`playful`。`cool`（墨镜）/`exhausted`（灵魂出窍）/`love`（爱心眼）/`shocked`
  这类随机摆出来会很莫名其妙，所以不入池。
- **真实表情优先**：`live2d_express` 推来的表情出现后，安静 25 秒不去抢；气泡在场时完全不换。
- 间隔 14–40 秒。表情按 0.9 秒淡入交叉（见下），换脸是「化过去」而不是「跳过去」。

**为什么淡入是 0.9 秒**：模型里的 `exp3.json` 都没写 `FadeInTime`，而 `pixi-live2d-display`
的 `createExpression(json, definition)` 会**丢掉 definition**（源码就是 `return O.create(t)`），
所以 `model3.json` 上写 `FadeInTime` 是无效的 —— 只能在 exp3 文件自己里面。Host 于是在提供
`.exp3.json` 时动态补上这个字段（带缓存），把默认的 0.5 秒放宽到 0.9 秒。

## 晃动的「别太突然」

### 手势波形

原先的抖笔是「12% 的时长冲到满幅、再指数衰减」—— 也就是 100ms 出头拉满，看起来是**抽一下**。
现在换成一类平滑手势：

```
gestureWave(p, cycles) = sin²(πp) · sin(2π·cycles·p)
```

包络 `sin²(πp)` 在两端（p=0 和 p=1）的导数都是 0，所以动作是**缓缓起来、缓缓停下**。
手势分两种：**摇头**（`ParamAngleZ`，1.5–2.5 个来回）和**摆一摆**（`ParamBodyAngleZ`，0.5–1.5 个来回）。

**来回数必须是半整数**。包络在正中（p=0.5）最强，而 `sin(2πc·0.5) = sin(πc)` 只有在 c 为
半整数时才取到 ±1 —— 整数来回会正好在中心抵消，峰值掉到 0.65，白丢三分之一幅度。
测试会对区间**两端**都断言峰值 > 0.95，这类失误跑不掉。

每次手势的时长、来回数、幅度都是**当场现取**的，所以没有两次手势长得一样；间隔 6–15 秒，
另有 30% 概率这次什么都不做 —— 偶尔漏一拍才不像节拍器。

### 为什么之前的持续晃动是「僵」的

之前用「两个固定正弦相加」驱动，有两个硬伤：

1. **严格周期**。两个正弦的和每 69 秒精确重复一次，看久了必然机械。
2. **头和身体共用同一个值**，完全同步摆动 —— 真人的头和身体不会精确同相。

现在换成**平滑值噪声**（`createDrift`）：在随机的时刻取随机的值，中间用 smoothstep 相连。
非周期，且 smoothstep 在节点处导数为 0，所以曲线处处连续、没有拐角。要点：

- **头、身体各一路独立噪声**，互不相关（测试断言 |相关系数| < 0.4）。
- **慢速幅度包络**再叠一层：晃动时强时弱，偶尔几乎停住。恒定幅度最容易看出机械感。
- **头部另有与视线解耦的偏航 / 俯仰漂移**。头若严格跟着眼珠转，是另一种「僵」——
  真人看东西时头有自己的惯性。这两路是叠加在 SDK 的 `updateFocus` 之上的，所以幅度留得小。
- 噪声**从 0 缓入**：起点固定为 0 而不是随机值，否则开场那一帧会从 0 突然跳到随机值
  （头部最大 ±1.8°），看起来就是「一顿」。

测试用两条判据守住「别太突然」：

- 手势：**半个峰值至少要花掉 15% 的时长才爬到**（旧方案是 5%），且 60fps 下单帧变化 < 峰值的 3%；
- 轻晃：**只统计没有手势的帧**，要求单帧位移 < 0.05°（手势本来就该快，混进来测就没意义）。

测试里还内联了旧方案的包络作为对照，断言它在这条判据下必然失败 —— 否则这个测试就是空转的。

### 「闪过去」的根因：SDK 的注目弹簧拿到了没有上限的 dt

SDK 自带的 `focusController` 是个限速弹簧，但它的**每帧最大位移是**

```
r = 5.3333 × deltaMs / 1000
```

而 `Live2DModel._render` 是这么调用的：

```js
this.deltaTime && (this.internalModel.update(this.deltaTime, this.elapsedTime), this.deltaTime = 0)
```

`deltaMs` **没有上限**。只要掉一帧（浏览器降频、切标签、渲染卡顿），`r` 就会超过整个
取值域（±1），于是眼睛、头、身体在**一帧之内**直接跳到新目标 —— 这就是「从一侧转向另一侧
的时候闪过去」。按实测折算，`dt=250ms` 时一帧就能转 **40°**，已经超过头部的全域。

**修法：不再交给它。** 朝向改由我们自己算：

- 每帧 `focus.focus(0, 0, true)` 把 SDK 的注目**钉死在 0**。它随后往眼珠/头/身体上加的都是 0，
  所以朝向完全由我们写的绝对值决定（`updateFocus` 跑在我们的写之后，而 `add(…, 0)` 是空操作）。
- 跟随用指数趋近 `alpha = 1 - e^(-dt/τ)`，**dt 被夹在 40ms**（`MAX_FOLLOW_STEP_MS`）。
  掉帧时按一帧算，单帧位移因此有硬上界，物理上不可能瞬移。
- 眼睛最快（τ=0.10s）、头慢一拍（τ=0.42s）、身体再慢一拍（τ=0.62s）—— **层层滞后**才像活人。

测试里有一组**对照**：按 SDK 原公式复算，断言 `dt=250ms` 时它一帧转 40°、`dt=1000ms` 时更夸张，
而我们的单帧位移在 dt 从 16ms 到 5000ms 的全区间内都 < 3°。没有这组对照，这条回归测试就是空转的。

## 尺寸适配

模型在面板里做 **contain** 适配（完整放入，不裁切），并且只依赖 CSS 逻辑像素：

- 视口尺寸取自 host 元素的 `clientWidth/clientHeight`，退回 `renderer.screen`。
  **不能用 `renderer.width/height`** —— 那是 canvas 后备缓冲的物理像素（CSS 宽 × `resolution`），
  而 `resolution` 取自 `devicePixelRatio`，浏览器缩放会改变它，于是模型大小随缩放漂移
  （曾出现「90% 正常、100% 过大」，150% 时达到 contain 的 199%）。
- 固有尺寸取自 `internalModel.width/height`。`Live2DModel` 没有覆写 `width`，PIXI 的
  `Container.width` 会把 scale 乘进去，用它反复适配会自我复利（不幂等）。
- `resolution` 夹在 `[1, 2]`：缩放低于 100% 时 `devicePixelRatio` 会小于 1，
  不夹住会让后备缓冲比 CSS 尺寸还小（发虚）。

`engine.js` 里 `FILL = 1` 是唯一的尺寸旋钮：1 为刚好完整放入，小于 1 留白更多，大于 1 会裁切。

## 测试

```powershell
node test/host-smoke.mjs   # Host：路由、model3.json、越界防护、状态机、工具、宠物页、拖动接线、DPI
node test/zoom-fit.mjs     # 缩放适配：直接求值 engine.js 里的 fit-math 区块
node test/idle-motion.mjs  # 待机动作：眼珠取值域、手势包络、参数不越界、无逐帧漂移
```

三个测试都从 `engine.js` / `host.js` / `pet/dsh-pet.ps1` 的**真实源码**取值求值（不是复制一份），
并用假 Cubism core 驱动动画器，所以能真正覆盖写入语义：`idle-motion.mjs` 会验证
12000 帧不越界、写入与当前参数值无关（从 min 与从 max 出发结果一致）、
以及参数缺失时不抛错。

## 桌宠（唯一的形象）

形象只存在于**桌面桌宠**里：一个 WebView2 无边框置顶透明窗口，由 Host 在插件激活时
自动拉起。**没有网页浮层** —— 早先那个 `shell.overlay` 条目已经删除，所以不会出现两个形象。

### 透明：用 DWM，绝不用 TransparencyKey

**要透明，但不能牺牲点击。** 这两件事在 Windows 上会冲突：

| 方案 | 透明 | 鼠标可命中 |
| --- | --- | --- |
| `TransparencyKey` 抠像 | ✅ | ❌ **分层窗口的命中测试按 GDI 位图**，而 WebView2 走 GPU 合成、不进位图 → 整窗被视为全透明 → 点击全穿透 |
| **DWM 合成**（当前） | ✅ | ✅ 窗口保持非分层 |

两步配合：

1. 窗口**保持非分层**（`BackColor = Black`，不设 `TransparencyKey`），
   显示之后调用 `DwmExtendFrameIntoClientArea`（`MARGINS` 全 `-1`）把客户区交给 DWM 合成。
2. WebView2 侧设 `DefaultBackgroundColor = Transparent`，让页面背景真正透明。

实测：日志 `DWM 透明：DwmExtendFrameIntoClientArea hr=0（0=成功）`、窗口 `layered=False`；
截图里窗口下方的浏览器内容（地址栏文字、页面正文）**清晰透出**，
同时拖动与滚轮缩放都正常工作。

> 这也是「鼠标放到身上会点到下一层」的根因 —— 加多少 `SetWindowPos(HWND_TOPMOST)` 都没用：
> 窗口虽然在最上层，但**对鼠标是不存在的**。

### 只有按在身体上才能拖动

拖动不是全窗口都能发起：`pointerdown` 里先跑 `onModel()`（模型包围盒判定），
不在身上就直接 return，**不进入拖动状态**。所以：

- 按在**形象本体**上拖动 → 窗口跟着走；
- 按在画布**透明空白处** → 什么也不发生。

判据与「戳一下」共用同一个 `onModel`，两处行为必然一致。

> 拖动链路：页面 `pointerdown`（记 `screenX/screenY`）→ `pointermove` 算增量 →
> `window.chrome.webview.postMessage({type:'drag'})` → 外壳 `Add_WebMessageReceived` 移动窗口。
> 之所以走 postMessage：WebView2 控制器铺满客户区、会吃掉所有鼠标事件，
> WinForms 的 `Form.MouseDown` **永远不触发**（早先挂在 Form 上的拖动从未生效过）。
> 用 `screenX/screenY`（屏幕物理坐标）所以增量就是物理像素，不需要再乘 DPI 缩放。

### 状态栏贴近形象

状态栏（**待机** / **思考中**）不是固定坐标 —— `placeStatus()` 依**模型包围盒**
把它放到人物头顶上方 30px、并跟随模型横向位置，同时不越出窗口上沿。
模型按 contain 居中、四周有留白，用死值会在窗口变大时让状态栏离人物越来越远。

### 置顶：TopMost 要显式做，且不能加 WS_EX_NOACTIVATE

`Form.TopMost = true` 只声明一次会被后来的前台窗口压过去。所以外壳在启动、控制器就绪后
各做一次 `SetWindowPos(HWND_TOPMOST)`，并在 5 秒心跳里检测「中心点是否被别的窗口占据」，
是则重申。

**不要**加 `WS_EX_NOACTIVATE`：加了窗口永不被激活，实测 topmost 会被前台窗口
**立刻压回**（心跳日志里每 5 秒报一次「被盖住」）。

### 生命周期：谁拉起的谁负责收

桌宠有两条退场路径，各管各的：

| 场景 | 谁负责 | 机制 |
| --- | --- | --- |
| **DSH 整个退出** | 桌宠自己 | 5 秒心跳发现 DSH 离线 → 自行退场；同时非 detached 子进程会被父进程带走 |
| **插件停用 / 重载** | **插件的 dispose** | `stopPet()` 主动杀 |

第二条是补上的。原先 dispose 里**故意不杀**，理由是「它有心跳，DSH 一停就自行退场」——
那话只对第一行成立，因为 DSH 整个退出时 dispose 这段代码**根本不会执行**。
插件重载时 DSH 还活着，心跳当然不触发，于是老桌宠留在屏幕上，新的 `apply()` 又拉起一只，
**两个窗口叠在一起**（实测重载两次攒出 pid 24160 + 4188）。

`stopPet()` 的两个细节：

- **杀之前先确认 pid 还是自己的**。pid 会被系统回收给别人，盲杀可能杀掉无辜进程。
  所以先查 `Win32_Process` 的 `CommandLine` 里有没有 `dsh-pet.ps1`，查不出来就不杀。
- **杀整棵进程树**（`taskkill /PID <pid> /T /F`）。桌宠自己会起 `msedgewebview2` 子进程，
  只杀 pwsh 会把它们留成孤儿。

验证方式是数进程：停用后应为 **0**，启用后应为 **1**。

```powershell
@(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" |
   Where-Object { $_.CommandLine -match '-File\s+\S*dsh-pet\.ps1' }).Count
```

### 状态从哪来（这条查了很久，值得完整记下）

状态栏的 **待机 / 思考中** 来自 Host 对 `agents` 服务的**实时查询**：

```js
const list = ctx.get('agents').list()          // 全部活跃 Agent
const running = list.some(a => a.status === 'running')
```

`/live2d/state` 里带一个 `debug` 字段如实报告「插件看到了什么」：
`{ hasAgents, agentCount, runningCount, eventRunningCount }`。

**为什么是查询而不是监听事件** —— 事件路线我试了三次，每次都被不同原因挡住：

| 尝试 | 结果 |
| --- | --- |
| `ctx.on('agent/status', p => p.agent.session.id)` | 真实 payload 是 `{ agent, status }`，`agent.session` 是 undefined → 每次都 return |
| 改成 `p.agent.id` + `{ global: true }` | 仍然收不到：该事件按 **agent 作用域**派发，根级监听拿不到 |
| 保留监听但**以查询为准** | ✅ 成功 |

最后那次还差一步：我新增了查询版 `statusSnapshot()`，却**忘了删掉旧的同名函数** ——
JS 函数声明会提升，后声明的赢，于是生效的一直是「只看事件集合」的旧版，
而那个集合恒为空 → 状态永远待机。诊断字段里 `runningCount: 2` 而 `status: "idle"`
这种自相矛盾，就是它的指纹。

测试里现在有两条护栏：**`apply` 内不得有重复的函数声明**，以及
**查询必须用 `list()` 而不是 `roots()`**（实测两者结果不同：`list()` 有 2 个 running，
按 `roots()` 判定会得到 idle）。

### 点击反应是现场生成的

点一下形象 → 页面 `fetch('/live2d/poke')` → Host 调 `ctx.get('llm').stream()`
让模型**就着「它最近说了什么」现场写一句**，并把结果连同按语气挑的表情返回。

```json
{ "ok": true, "text": "哎哟，吓我一跳！", "emotion": "shocked" }
```

**为什么不用预设词条**：预设点第二次就重复，而且和 Agent 当前在做的事毫无关系。
生成时会把最近一条真实表达作为上下文交给模型，所以反应是接着它此刻的状态说的。

失败时（没有活跃会话、模型报错）返回 `ok:false`，页面退回一句最短的「……嗯？」——
**点击必须有反应**，不能因为生成失败就沉默。连点由 `pokeBusy` 去重，不叠请求。

### 主动说话：她自己会开口

前面两条都是**被动**的（`live2d_express` 由 Agent 推、点击由你触发）。这一条是
形象**自己**隔一阵子嘀咕一句 —— 而且内容要落在**具体任务**上。

**上下文来自活跃会话的标题**，这就是「某某任务」的来源：

```js
const projections = ctx.get('sessionProjections')
const raw = projections?.stateOf(agent.session, 'title')   // 可能是裸值，也可能是 { ver, seq, val }
```

实测生成结果（真实运行，不是示意）：

```
上下文：现在 DSH 里有这些任务：
        - 「DeepSeek接入Live2D模型插件」：正在跑

生成：「DeepSeek接Live2D…这插件跑得我有点慌。」
```

**提示词里塞的是事实**（任务名、在跑还是闲着、上一句说了什么），并明令
「尽量点到具体那个任务的名字」「不要复述上面的列表」——
否则很容易退化成「我在认真工作哦」这种放到任何任务里都成立的空话。

**三条节流规矩**（少一条就会变成话痨或复读机）：

| 规矩 | 值 | 为什么 |
| --- | --- | --- |
| 最小间隔 + 随机抖动 | 90s + 0–75s | 别连珠炮 |
| 每小时预算 | 8 条 | 每条都是一次真实的模型调用 |
| 真实表达后让路 | 25s | 不抢 `live2d_express` 的话 |

外加：**启动后先安静 25 秒**再开口（`lastAt === 0` 不能直接放行，
否则一重载就开腔 —— 这是我实测踩到的），以及与上一句雷同就丢弃。

**生成失败就沉默，不退回预设** —— 页面自己那套碎碎念（`engine.js` 的 `MURMURS`）
照旧跑着，那才是兜底。这条线必须是现场生成的，否则就退化成「打表预设」。

桌宠配置成 `off` 时不启动，省掉那些模型调用。

### 诊断端点：`/live2d/probe-proactive`

按需跑一次完整流程（采集事实 → 生成），但**不写 `state`**，所以不会打扰桌宠。
主动说话最小间隔 90 秒，没有它就没法立刻验证标题解析与提示词质量。

```json
{
  "ok": true,
  "text": "这Live2D模型插件卡半天了，真急人。",
  "emotion": "confused",
  "brief": "现在 DSH 里有这些任务：\n- 「DeepSeek接入Live2D模型插件」：正在跑"
}
```

`brief` 是实际喂给模型的上下文 —— 调提示词时看它比看生成结果更有用。

### 思维链：**精炼**成一句，不是截取一句

上面的「自己嘀咕」是**另写一句**。这一条更进一步 —— 形象说的是模型**此刻真实的思考**，
标签是「思维链」。

来源是 `agent/assistant-stream` 的 `reasoning-delta` 分片：

```js
ctx.on('agent/assistant-stream', (payload) => {
  const frame = payload.frame
  if (frame.type === 'chunk' && frame.chunk?.type === 'reasoning-delta') { /* 累积 */ }
}, { global: true })   // ← 又是 agent 作用域事件，必须 global
```

#### 为什么从「截取」改成了「精炼」

最初的做法是**从思维链里挑一句**直接贴到气泡上。这条路走不通，因为思维链是**给自己推理用的草稿**，
不是给人读的成品：里面有半成品句子、自我催促（`OK` / `Let me do it`）、代码、字段名、路径。

实测截出来过这些东西：

- `"block-start:reasoning": 2, ← 推理块出现了！`（它以 `！` 收尾，骗过了句末检查，但整句是在引用代码输出）
- `Let me run.思维链这次…`（英文句号没被当句末，两句粘一起）
- 我自己的循环复读：`Let me do it. / Let me write. / OK.` 反复

所以改成：**把草稿交给模型，读懂之后重新说一遍**（`distillReasoning`）。提示词明确要求
「读懂之后重新说一遍，不是摘抄原句」，并列出要丢掉什么。

对照（同一段草稿）：

| | 结果 |
|---|---|
| 旧做法（截取） | `"那个正则我试了三遍还是没匹配上，有点烦。"` ← 原样摘抄 |
| **现在（精炼）** | **`"正则老匹配不上，得去 host.js 看看那函数咋写的。"`** ← 读懂后重说 |

输出还要过一道清洗（`sanitizeLine`）：去掉模型不听话加的引号、「这句话是：」这类前缀，
长度不在 4~60 字之间就判为无效。**精炼失败就沉默** —— 宁可不说，也不贴半句话上去
（`debug.reasoning.distillFailed` 可以看失败次数）。

诊断端点会**同时**给出两种结果，方便对照：

```
GET /live2d/probe-reasoning?seed=<一段草稿>     # 返回 { picked, distilled }
```

### 状态灯：四态，绿=完成 / 黄=等你操作

| 状态 | 灯 | 何时 |
|---|---|---|
| `idle` | 灰 | 待机 |
| `thinking` | 蓝（脉冲） | 有 Agent 在跑 |
| `waiting` | **黄**（快脉冲） | **权限申请 / 问卷 —— 不点它就永远不动** |
| `done` | **绿**（常亮+光晕） | 任务刚完成 |

**黄灯的来源是两条路，缺一不可，而且两条都必须 `prepend: true`。**

第一条是审批/问卷的 waterfall 事件：

```js
for (const eventName of ['approval/request', 'user-questions/request']) {
  ctx.on(eventName, async (...args) => {
    const next = args[args.length - 1]
    enterWaiting()
    try { return await next() }        // ← 必须原样返回，否则掐断整条审批链
    finally { leaveWaiting() }
  }, { global: true, prepend: true })
}
```

第二条是 `tools/pre-execute`。

#### 为什么必须 prepend

真实弹审批的是 **auto-review**（`@deepseek-ai/dsh-experimental-auto-review`）。
它的注释写得很直白：「Install the Auto preset and its **prepended** per-call review gate」，
源码里 `askUser()` 返回的就是 `{ kind: 'ask', reason, displayReason }`。

也就是说它 **prepend** 了、跑在普通监听器前面，而且**不调 `next()` 就返回**。
而 Cordis 的 waterfall 实现是：

```js
register(label, hooks, callback, options) {
    const method = options.prepend ? 'unshift' : 'push'   // prepend = 插到队首
    ...
}
waterfall(...args) {
    const cbs = this.dispatch('waterfall', args)
    const next = () => (cbs.shift() ?? inner)(...args)     // 逐个 shift
    args.push(next)
    return next()
}
```

—— **前面的人不调 `next()`，后面的人根本不会被调用**。所以「先返回 ask 的那个人」
把整条链截断了，排在它后面的监听器永远收不到那个 ask。

实测数据就是这么说的：`kindsSeen` 攒到 `{"allow":141}`，
**141 次真实调用一次 `ask` 都没有**，而用户明明看到了审批弹窗。
`approval/request` 那条路同理 —— 它的第一个回答者（远程转发到浏览器那个）也是直接
return 自己的结果，不 prepend 就永远轮不到我。

所以两个注册都带 `prepend: true`：插件比 auto-review 晚加载，
后 `unshift` 的排在更前面，于是我先进场、先调 `next()` 把决策链走完，再回看它返回了什么。

（`prepend: true` 只影响**顺序**，不影响是否收到事件 —— 那是 `global: true` 管的。
两个都要。）

#### 决策形状与对账

```js
const gate = await this.ctx.waterfall(carrier, 'tools/pre-execute', exec,
                                      () => Promise.resolve({ kind: 'allow' }))
const askResolution = gate.kind === 'ask' ? await this.serviceAsk(exec, gate) : ...
```

进场时机是 `gate.kind === 'ask'`，出场靠 `tools/result`（签名 `(exec, result)`，
**被拒/被取消的调用也会走到这里**，所以黄灯一定会灭）。

三个容易写错的点：

- 决策是**带 `kind` 的对象**（`allow` / `ask` / `deny` / `cancel`），源码里写死的是
  `gate.kind === 'ask'`。要精确相等，不要写成「包含 ask」——那会误伤别的词。
- 关联键是 **`exec.callId`**，`exec` 上没有 `id`。用 `callId` 而不是对象身份，
  因为 `tools/result` 拿到的 `exec` 已经被 `Object.freeze` 过。
- 必须留兜底回收：万一某次 `tools/result` 没来，黄灯不能永久卡住（`ASK_STALE_MS`，
  靠页面轮询 `/live2d/state` 当时钟顺手回收，不额外开定时器）。

用**计数**而不是布尔：并发的多个申请不能互相抵消。

#### 另一条独立的路：never 策略下 approval/request 不派发

审批服务的 `decide()`：

```js
async decide(req, session) {
    if (signal?.aborted) return 'cancelled'
    if (this.effectivePolicy(session) === 'never') return 'rejected'   // ← 提前返回
    const answer = ...waterfall(scopeTarget(...), 'approval/request', req, ...)
}
```

策略是 `never`（自动拒绝）时它在派发**之前**就返回了，那行 `waterfall` 压根不执行。
这种情况下 `approval/request` 一次都不会来，只能靠 `tools/pre-execute` 那条路。
（服务默认值是 `ask`，所以多数时候两条都在。）

#### 怎么确认事件真的到了

探针如果是**直接调函数**的，就绕过了事件系统，证明不了这一点。所以：

- `/live2d/probe-status?set=order-ahead` / `order-behind` —— 造一个和 auto-review 一样的
  prepend + 不调 `next()` 的监听器，**走真实事件总线**派一次。
  `order-ahead` 应看到 ask，`order-behind` 应被截断 —— 两种顺序都要能复现，
  否则「修好了」和「碰巧」分不清。
- `/live2d/probe-status?set=order-approval` —— 走真实总线派 `approval/request`，
  看 `approvalsSeen` 涨不涨。
- `preExecuteSeen` / `kindsSeen` 只在**真机调用**时上涨，记录实际收到的决策形状。

`approvalsSeen` 是**两条路合并**的计数（`pre-execute` 看到 ask 记一次，
`approval/request` 进来也记一次）—— 问的是「一共见过几次有人在等你」。
所以跑 `order-ahead` 也会让它 +1，那不是重复注册。

**绿灯是限时的**（默认 30 秒）。一直绿着反而失去信息量。

**优先级：等你操作 > 正在干活 > 刚完成 > 待机。**

「正在干活」必须高于「刚完成」—— 这条是被测试抓出来的：done 亮 30 秒，如果这期间又开了新任务，
绿灯压着蓝灯就成了误导。所以一旦有 Agent 在跑，就顺手把 done 清掉。

**怎么验证**（绿/黄平时很难碰巧看到）：

```
GET /live2d/probe-status?set=waiting    # 强制黄
GET /live2d/probe-status?set=done       # 强制绿（有 agent 在跑时会被 thinking 压住，这是对的）
GET /live2d/probe-status?set=clear      # 清空

# 走真正的 tools/pre-execute + tools/result 监听器（不是直接改状态）
GET /live2d/probe-status?set=ask&callId=probe-ask        # next() 返回 {kind:'ask'} → 该亮黄
GET /live2d/probe-status?set=ask-settle&callId=probe-ask # tools/result 到达 → 该灭
GET /live2d/probe-status?set=ask-allow                   # next() 返回 {kind:'allow'} → 不该亮

# 走真实事件总线，验证 waterfall 排序（模拟 auto-review 的 prepend + 截断）
GET /live2d/probe-status?set=order-ahead    # 我 prepend 在前（= 线上顺序）→ kindsSeen 应出现 ask
GET /live2d/probe-status?set=order-behind   # 我排在它后面（= 修复前）→ 应被截断，无变化
GET /live2d/probe-status?set=order-approval # 派 approval/request → approvalsSeen 应 +1
```

`set=ask` / `set=order-*` 走的都是**真身监听器 + 真实总线**，不是另写一份模拟逻辑 ——
否则探针绿了也说明不了线上这条链通。
返回值里的 `phase` 会带上 `preExecuteSeen` / `kindsSeen` / `pendingAsks` / `askStale`。

**优先级**：思维链优先，没有可用片段才退回「另写一句」。
空闲很久、模型没在思考时总不能一直不说话。

#### 挑句规则（这块踩了两次）

思维链又长又碎，还夹着工具参数和 URL，而气泡只放得下一句。所以按句切开、
过滤掉不像人话的，再从**靠后**的几句里随机挑（靠后更接近当下的思路）。

实测踩到的三个坑，都已修并写进测试：

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `Let me run.思维链这次是…` 粘成一句 | 切句只认 `。！？；`，**英文句号没被当句末** | 英文句号只在后面是空白或中文时才切 —— 否则 `1.5`、`node.js` 会被切断 |
| 气泡里出现 `**正确走了兜底**` | Markdown 标记漏进去了 | 切句后剥掉 `* _ \` ~ > #` |
| 挑出 `"block-start:reasoning": 2, ← 推理块出现了！` | 它以 `！` 收尾，**骗过了句末检查**，但整句是在引用代码输出 | 去掉句子两端引号；拒绝含 `"` 或反引号的句子；拒绝以 `, :` 收尾的截断代码 |

最后那条是**在真实缓冲上发现的**，不是构造出来的 —— 只跑构造样本不会暴露它。
修完后同一条输入挑出的是：`另一句：这个改动我觉得还是有点风险,先确认一下。`

（`don't` 这类撇号仍然放行，不会因为过滤引号而误伤英文句子。）

**中文优先**：实测这条路由的推理是**英文**的，而气泡挂在中文角色身上。
所以只要链里有中文句子就先用中文；**全是英文时仍然照发** ——
那是它真实的思考，不该因为语言就瞒着不说。

#### 一个必须知道的事实：推理不是每步都有

实测某一批帧的类型分布：

```json
{ "start": 1, "block-start:tool-call": 1, "tool-call-delta": 6,
  "block-end": 1, "usage": 1, "finish": 1, "end": 1 }
```

**只有 `tool-call` 块，没有 `reasoning` 块** —— 多数工具步骤模型直接发起调用、不产生推理；
推理主要出现在回合开头那几步。所以：

- 缓冲是**滚动保留**的（`bufferLimit` 兜住长度），不是每步清空 ——
  清空的话轮到要说话时缓冲往往正好是空的（实测 `buffers:1` 但 `chunks:0`）
- 拿不到推理就退回「另写一句」，不会因此沉默

### 诊断端点：`/live2d/probe-reasoning`

```bash
# 看采集到的原文与会挑中的句子
GET /live2d/probe-reasoning

# 用给定文本走一遍挑选规则（不改状态）—— 调规则时用这个
GET /live2d/probe-reasoning?seed=<文本>

# 把挑中的那句真的写进 state —— 验证端到端显示，绕过节流
GET /live2d/probe-reasoning?speak=1&seed=<文本>
```

`?seed=` 是必需的：推理只在部分步骤流出，而每次重载插件都会清空缓冲 ——
没有它就没法确定性地验证规则本身。

实测（真实运行）：

```
seed  : "先确认一下…。The reviewer needs the session header.
         我觉得这个正则还是没匹配上,有点烦。"
picked: "我觉得这个正则还是没匹配上,有点烦。"     ← 中文优先
state : { mode: "reasoning", emotionLabel: "困惑", revision: 2 }
```

### 状态与行为

由 Host 的 `agent/status` 驱动、经 `/live2d/state` 轮询到页面。行为与早先网页版一致：

- **待机动作**：眼珠到处瞟、摇头/摆一摆、手里的笔跟着晃（`engine.js` 的 `createIdleAnimator`）
- **待机换脸**：没人推新表情时自己换一张温和的脸
- **碎碎念**：16 条角色自语，气泡标着「碎碎念」
- **点击身体**：幅度更大的手势 + 换脸 + 一句反应（气泡标「被戳了」）
- **Agent 的真实想法**：`live2d_express` 推送，优先于碎碎念显示

### 配置

| 值 | 含义 |
| --- | --- |
| `desktopPet: 'auto'`（默认） | DSH 启动时拉起桌宠 |
| `desktopPet: 'on'` | 同上（显式） |
| `desktopPet: 'off'` | 不拉起桌宠（此时没有任何形象） |
| `modelDir` / `modelFile` | 指定模型目录 / 设置文件 |

### 怎么确认它起没起

`/live2d/manifest` 的 `desktopPet` 字段如实报告：

```json
{ "mode": "auto", "state": "running", "pid": 23168, "detail": "",
  "log": "%TEMP%\\dsh-live2d-pet-launch.log" }
```

`state` 取 `running` / `exited` / `failed` / `idle`。两份日志：
`%TEMP%\dsh-live2d-pet-launch.log`（Host 侧）、`%TEMP%\dsh-live2d-pet.log`（桌宠自身）。

自检（写 DOM 状态与页面截图后自动关闭）：

```powershell
pwsh -NoProfile -File .\pet\dsh-pet.ps1 -SelfTestMs 15000
# 结果： %TEMP%\dsh-live2d-pet-selftest.txt 与 .png
```

### 清晰度：根因是进程 DPI 感知，不是采样率

我先试过「强制 2× 超采样」，结果**更糊**。量了才发现真正的根因：

| 指标 | 未声明 DPI 感知 | 声明之后 |
| --- | --- | --- |
| 桌面真实像素 | 1920×1200 | 1920×1200 |
| WinForms 报的屏幕 | **1280×800**（被缩了） | **1920×1200**（如实） |
| 进程 DPI 感知 | **0 = UNAWARE** | **2 = PER_MONITOR** |
| 页面 `devicePixelRatio` | 1 | **1.5**（系统 DPI 144） |
| 结果 | 窗口位图被系统**拉伸 1.5×** | 1:1，不再拉伸 |

DPI **UNAWARE** 的进程，Windows 会把整个窗口位图拉伸到物理分辨率 —— 渲染到 680×920
的缓冲被插值放大到 1020×1380 显示，**多糊一层**。所以超采样越多反而越糊。

**修法**：外壳在**创建任何窗口之前**声明 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`
（老系统回退 `SetProcessDpiAwareness(2)`）；页面侧用**原版精度**（`SUPERSAMPLE = 1`）；
窗口尺寸乘 DPI 缩放（逻辑 340×460 → 物理 510×690）；保留 mipmap。

实测：窗口 510×690、页面 CSS 视口 340×460、canvas 后备缓冲 341×461，截图 76KB → **134KB**。

### 踩坑记录

1. **`detached: true` 在 Windows 上会让 `pwsh` 完全不执行。**
   实测六种 spawn 配置：三条 `detached` 全部「exit 0 但脚本一行没跑」，三条非 detached 全成功。
2. **`stdio: 'ignore'` 把失败原因全丢了** —— 我因此白查两轮。现在子进程输出写日志文件。
3. **屏幕合成截图验证不了这个窗口**：`TransparencyKey` 抠像的像素在合成里变成穿透，
   抓到的只是背后的内容。必须用 `CapturePreviewAsync` 或 DOM 探测。
4. **引擎曾两次整块作废**：一次是切分只取常量（`fitModel is not defined`），一次是整块与常量
   同时交付（`IDLE_MODE has already been declared`）—— 浏览器里一个语法错误会让整个
   script 块失效。现在测试会**逐块跑 `node --check`**。
5. **挂在 Form 上的拖动从未生效**：WebView2 控制器吃掉所有鼠标事件（见上）。

**仍未验证的**：观感 —— 晃动自然度、点击手感、置顶是否会被某些前台窗口压过。

## 诊断端点：`/live2d/probe-route`

一个**只在本机回环地址**上的诊断路由，用来复现「审查器那一类请求」。它发一次极短的模型调用，
参数与 `dsh-experimental-auto-review` 的 `classifyRisk()` 形状一致（关键是**不带 `sessionId`**）：

```
GET /live2d/probe-route?provider=opencode-go&model=deepseek-v4.1-flash
GET /live2d/probe-route?provider=opencode-go&model=deepseek-v4.1-flash&session=1
```

返回 `{ ok, provider, model, sentSessionId, elapsedMs, text, error, detail }`。

**它为什么值得留着**：审查器一旦失败，审批策略 `ask` 下**所有工具都无法执行** —— 连读文件都不行，
那时你没有任何手段去诊断。这个端点还留在 HTTP 层，可以绕过被阻断的工具通道自检。

### 它当初查出的问题：OpenCode 网关缺 `x-opencode-session`

实测三种情形（同一请求形状，唯一变量是那个头）：

| 配置 | 结果 |
| --- | --- |
| `headers: {}` | `ok:false` → `400 {"type":"MissingSessionID","code":"INVALID_REQUEST"}` |
| `headers: {x-opencode-session: dsh-desktop}` | `ok:true` → `{"risk":"low","decision":"allow"}` |
| 带真实 `sessionId` | `ok:true` |

因果链：

1. 官方 exe 版的 `desktop` profile 默认把 `@deepseek-ai/dsh-experimental-auto-review` 列为 bundle，
   于是审批策略变成 `ask`、逐调用审查被启用（git 版的 `web` profile 没有它）。
2. 审查器的 `classifyRisk()` 构造 `llm.stream()` 参数时**不带 `sessionId`**。
3. `dsh-llm-pi-ai` 那条 `opencode-go` 路由依赖 `sessionId` 才能生成 `x-opencode-session`
   （见 `@earendil-works/pi-ai` 的 `withSessionHeader`），没有就不发该头。
4. 网关 400 拒绝 → 审查失败 → fail-closed → **工具全部不执行**。

**修法**（在 profile 配置里给该路由显式声明这个头）：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
        headers:
          x-opencode-session: dsh-desktop
```

之所以有效：`withSessionHeader` 的实现是「**头已存在就不覆盖**」——
`if (!options?.sessionId || hasHeader(...)) return options`。所以显式声明后，
审查器与主调用都会带上它。

> **代价**：该路由的所有请求共用一个稳定路由键，不再逐会话区分。
> 网关的报错措辞是 "cannot be routed **efficiently**"，即影响的是路由效率而非可用性。
> 若想保留逐会话路由键，替代方案是改用 `dsh-opencode-go-plus` 适配器：
> 它在 `sessionId` 存在时发真实 id、缺失时发兜底哨兵，两边都通。

---

### 任务完成后说话

触发点是 `agent/status` 的 **running → idle** —— 一个回合结束了。
和「自己嘀咕」的区别在于**时机由事件驱动**，不是等定时器：
刚干完一件事正是最该有反应的时候，等 90 秒再说就凉了。

所以闸门比主动说话宽松（`minGapMs: 8s` vs `90s`），但仍然：

| 规矩 | 值 | 为什么 |
| --- | --- | --- |
| 太短的回合不说 | `< 20s` | 一句闲聊不值得感慨 |
| 与上次说话的最小间隔 | 8s | 别刚说完又接一句 |
| 每小时预算 | **共用**那 8 条 | 多了这条线也不会变话痨 |

提示词和主动说话**是两套** —— 完成这条要的是「松了口气/有点得意」，不是汇报：

```
刚做完的是：「DeepSeek接入Live2D模型插件」，花了大约 12 分钟。
请说一句第一人称、口语化的感想。要求：
- 25 字以内，像真的松了口气、或者有点小得意，**不是汇报工作**；
- 不要客套，不要「已完成任务」这种公文腔……
```

实测生成：`总算把接入插件搞定了，呼——还行吧。`（表情 happy）

**一个实测踩到的缺口**：插件可能在**回合中途**才加载，那时 `running` 事件早已过去，
于是整回合结束时算不出时长、直接被跳过（`detected` 一直是 0）。修法两条：

- 加载时给**已在跑**的 agent 补记开始时间（`tracking` 字段能看到补了几个）；
- idle 到来时若时长取不到，按「刚好够格」处理而不是跳过 ——
  一个已经结束的回合就是发生过的事，不该因为没看到开头就装作没有。

诊断：`GET /live2d/probe-done?title=<任务名>&minutes=12`

### 语音包评估：`C:\Users\admin\Downloads\dafeiyu` **不能直接调用**

那 6 个文件（`model_4000.pt` ~ `model_14000.pt`，每个 280MB，共 1.6GB）**不是音频**，
是 PyTorch 权重。从 `data.pkl` 里读出的结构：

```
顶层键：ddsp_model / reflow_model / global_step / version
ddsp_model.unit2ctrl.f0_embed / phase_embed / volume_embed / aug_shift_embed
ddsp_model.unit2ctrl.decoder.encoder_layers.N.conformer.net.*      ← Conformer
reflow_model.velocity_fn.{input_projection,diffusion_embedding,residual_layers}  ← rectified flow
```

这是 **`ddsp-svc`（yxlllc/ddsp-svc）的音色转换模型**，而且是**训练检查点**（带 `global_step`）。

**为什么不能拿来说话**：

1. **它是 SVC 不是 TTS** —— 输入是**别人的音频**（经 contentvec/HuBERT 提特征 + F0 + 音量），
   输出是换成目标音色的同一段话。**喂文本它不会读。**
2. **运行环境一样都没有**：无 PyTorch、无 ddsp-svc 代码、无 contentvec/HuBERT 编码器、
   无 F0 提取器（RMVPE/crepe）。这些加起来是数 GB 的安装。

要用它，完整链路是：**先有一个 TTS 把文字读出来 → 再用它做音色转换**。
不是「装个依赖就能跑」。

**后来做到了** —— 见下面「语音：真的用大肥鱼的声音说话」。

**能立刻用的替代**：Windows 自带 SAPI 有中文女声（`Microsoft Huihui` / `Microsoft Yaoyao`，
zh-CN），零安装、离线。音色不是大肥鱼，但**马上能出声**。

---

## 语音：真的用大肥鱼的声音说话

链路（实现在 `D:\deepseek\deepseekh_work\voice\`，插件只负责调度与播放）：

```
文字 → Windows SAPI 出声 → contentvec768l12tta2x 特征 + F0 + 音量
     → ddsp-svc 6.2 (reflow+ddsp, 大肥鱼音色) → wav → 桌宠播放
```

### 模型来自 ddsp-svc **6.2**，不是 master

这是整件事最难的一步。`model_28000.pt` 没有配套 `config.yaml`，只能从张量形状反推，
再逐个版本试。排除过程：

| 版本 | 结果 |
|---|---|
| master / tag 5.0 | `Unit2Control` 硬编码 256 维、只有 `stack`，**没有 `stack2`** |
| 6.1 / 6.2 | ✅ 匹配 |
| 6.3 | Conformer 的 pointwise 改成了 `Linear`，检查点是 `Conv1d` |
| 6.5 | 彻底重写（`lynxnet2`），更不匹配 |

判定 6.2 的关键证据：

```
检查点                                      6.2 的 ConformerConvModule
unit2ctrl.stack2.0.weight_v (512,1024,3)  ←  Conv1d(2 * block_size, 512, 3,1,1)，2*512=1024
unit2ctrl.stack.1.weight    (512,)        ←  PReLU(num_parameters=512)
net.2.weight (2048, 512, 1)               ←  Conv1d(dim, inner_dim*2, 1)，inner_dim=1024
net.4.weight (1024, 1, 31)                ←  Conv1d(inner_dim, inner_dim, 31, groups=inner_dim)
net.5.weight (1024,)                      ←  PReLU(inner_dim)
```

而且 6.2 默认配置的 `n_aux_chans: 512` / `n_aux_layers: 6` 与反推值**完全一致**，
说明模型就是按默认配置训的。切到 6.2 后 `load_model_vocoder` **零形状不匹配**。

### 为什么绕开了这么多依赖

本机 Python 是 3.13，且 `numpy` 归 ComfyUI 用（2.4.4）——**不能动**。
所以依赖装在隔离目录（`voice/pkgs`）并用 `PYTHONPATH` 注入，另有 `voice/shim` 顶替两个库：

| 依赖 | 问题 | 处理 |
|---|---|---|
| `fairseq` | **3.13 上没有任何 wheel**，而 contentvec 靠它加载 | 改用 transformers 版 contentvec，并复刻 `contentvec768l12tta2x` |
| `librosa` | 会拖进 numba | 写了 `shim/librosa`：只实现 `filters.mel`（标准 Slaney 实现）、`util.normalize`、`core.resample`（走 torchaudio） |
| `torchcrepe` / `resampy` / `sklearn` / `local_attention` | 分别只为 crepe 音高、未使用的重采样、hubertsoft 的 KMeans、`local_heads>0` 而存在 | 逐个确认推理路径用不到后设为可选导入 |
| `matplotlib` | 只被 nsf_hifigan 的画图函数用 | 可选导入 |
| `gin` | 只为 `unit2control` 里一个没实际用到的装饰器 | 写了 stub |

另外修了上游两个真实缺陷：`config.yaml` 用 `open()` 默认编码（Windows 上是 GBK）读，
只要文件里有中文注释就 `UnicodeDecodeError`；以及 `contentvec768l12tta2x` 在无 fairseq 时无路可走。

### `contentvec768l12tta2x` 是什么

TTA2X = 测试时增强 2 倍：把音频**左补 160 个样本再跑一遍**，两遍结果在特征维交错拼接，
于是帧率翻倍（hop 320 → 160）。这就是配置里 `encoder_hop_size: 160` 的来源。

### 插件侧怎么接的

- **只念最新一条，不排队**：CPU 推理一句要十几秒。排队会让语音越拖越久、和气泡完全对不上，
  所以新的直接顶掉旧的（`speech.dropped` 计数）。宁可漏念，不念过时的。
- **合成完要校验气泡是否还是同一条**：这条是实测踩出来的 —— 合成窗口十几秒，期间气泡可能
  换了三轮，结果嘴在念旧句（`state.message.id !== job.id` 就丢弃并删文件）。
- **音频与气泡是两条独立通道**：气泡随消息立刻更新，音频要等合成完，各自按 id 判重。
- **页面把播放结果回报给 Host**（`/live2d/audio-status`）—— 没有这个就只能猜「到底响没响」。

### 必须放行 WebView2 自动播放

WebView2 默认策略是「用户没交互过就不许出声」，而桌宠是**主动说话**的，永远等不到那个手势。
表现极具迷惑性：**画面一切正常，就是永远静音**。

```
play() failed because the user didn't interact with the document first.
```

修法在 `pet/dsh-pet.ps1`，用环境变量传浏览器参数：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--autoplay-policy=no-user-gesture-required'
```

**不要**改用 `New-Object ...CoreWebView2EnvironmentOptions`：这个 SDK 版本里它没有可用构造函数，
会让桌宠**直接起不来**（`A constructor was not found`），比静音更难查。

### 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `speech` | `'on'` | `'off'` 完全关掉语音 |
| `speechModes` | **全部**（含 `status` / `murmur`） | 哪些 mode 要出声 |
| `speechSteps` | `8` | reflow 采样步数，越少越快、音质越差 |
| `speechMaxChars` | `60` | 超长截断（省时间） |
| `statusSpeechMinGapMs` | `25000` | 状态语音的最小间隔 |
| `speechPythonPath` | 见代码 | 隔离依赖目录（必须传，否则 worker 起不来） |
| `speechWorker` / `speechPython` | 见代码 | 换模型/换环境时改这里 |

### 哪些话会出声

**默认全部** —— 这是明确要求：碎碎念、任务报告、闲聊、自己的想法、状态都要有声音。
各条路径的来源不同，接法也不同：

| 说什么 | mode | 怎么接的 |
|---|---|---|
| 自己的想法 / 对任务的看法 / 闲聊 | `thought` `opinion` `chat` `status` | `live2d_express` 工具，写 `state.message` |
| 思维链摘句 | `reasoning` | Host 从 assistant-stream 里挑句子 |
| 任务完成报告 | `done` | Host 检测回合结束 |
| 主动说话 | `proactive` | Host 定时器 |
| **待机碎碎念** | `murmur` | **纯页面逻辑**，页面主动上报到 `/live2d/murmur` |
| **点击反应** | `poke` | `/live2d/poke` 直接回给页面，不走 `state.message` |
| **状态翻转** | `status` | Host 在每次 `/live2d/state` 轮询时检测变化 |

后三条原先都是**哑的**（碎碎念是页面自己的兜底逻辑、点击反应直接回页面、状态只是个标签），
它们都**不改 `state.message`**，所以要：
1. 单独上报 / 单独入队；
2. 标 `standalone` 跳过「气泡是否还是同一条」的防错位检查；
3. 用自己的字符串 id（`murmur-xxx` / `poke-xxx` / `status-xxx`）判重，避免和消息 revision 撞。

状态语音还额外带节流：`idle↔thinking` 一天能翻几百次，不节流会没完没了。
`debug.statusSpeech.skippedGap` 在涨说明状态确实在翻、只是被节流挡下了（预期行为）。

### 常驻工作进程：17 秒 → 5 秒

原先每句都冷启一个 Python 进程。实测拆分后发现瓶颈不是加载模型：

```
import 模块          3.56s   ← 每句都重付
加载 ddsp+reflow     0.56s
contentvec 编码      0.68s
reflow 采样(16步)    3.31s
HiFiGAN 声码         2.39s
```

所以 `worker.py` 常驻（模型只加载一次），SAPI 也改成常驻 pwsh：

| | 冷启 | 常驻 |
|---|---|---|
| 每句总耗时 | 约 17s | **约 5s** |
| 其中 SAPI | 约 1.5s（pwsh 冷启动） | **23~44ms** |

协议是 stdin/stdout 各一行 JSON，首行 `{"ready":true}` 表示就绪。

**两个必须注意的坑**（都踩过，现象都是「永远不出声」）：

1. **stderr 必须持续排空**。worker 把加载日志（transformers 报告、tqdm 进度）全写 stderr，
   管道缓冲区约 64KB，一满 worker 阻塞在写、Host 阻塞在读 —— 双向死锁。
2. **worker 启动阶段死掉时，`ensureWorker()` 的 promise 必须落地**。早先 `exit` 处理器只
   通知了「等任务结果」的 resolver，没通知「等就绪」的，于是启动失败表现成永久卡住
   （`busy` 一直是 `true`、既不出声也不报错）。
3. **spawn 必须显式传 `PYTHONPATH`**（`speechPythonPath`）。ComfyUI 的 site-packages 里
   没有 `soundfile`/`pyworld`/`soxr`，不传就 ImportError —— 又是「永远不出声」。

### 别把 engine.js 的常量用在 Host 作用域

`REACTION_MODE` / `MURMURS` / `IDLE_MODE` 这些定义在 `engine.js`，**只注入到页面**。
在 Host 的路由处理里引用它们是 `ReferenceError`，会把整条路由打崩
（poke 路由就这么崩过一次）。Host 侧要用字面量。测试里有针对性的扫描断言。

### 诊断

```
GET /live2d/probe-speak?text=...    # 走完整流水线念一句，返回耗时与音频 URL
GET /live2d/state                   # debug.speech 看 busy/failed/dropped/playback
GET /live2d/audio/<name>.wav        # 取音频（只接受纯文件名，挡 ../ 穿越）
```

`debug.speech.playback` 就是页面回报的播放结果 —— `ok:false` 且 detail 提到 autoplay，
就是自动播放策略又拦住了。

### 实测数据

| 项 | 值 |
|---|---|
| 单句耗时（CPU，16 步） | **约 17~19 秒** |
| 输出 | 44100Hz，时长与输入一致 |
| 音色变化 | 过零率 0.1077 → 0.0511，谱质心 1747Hz → 2696Hz（确实换了，不是直通） |

**注意**：17 秒/句 是 CPU 推理的代价。想更快就调低 `speechSteps`（16→8 约省一半）。

---

## 已知边界

- `/live2d/*` 由 `webServer` 的 prefix 路由直接应答，不经过 SPA 的鉴权中间件。服务只监听回环地址，
  且暴露的仅是本地模型文件与 Agent 自己那句气泡文字；如果要对外网开放，需要自行加鉴权。
- 改完 `engine.js` / `host.js` 后：在插件页停用再启用即可（`entry.js` 用带时间戳的 import 绕开 ESM 缓存）。
- 改完 `pet/dsh-pet.ps1` 后同样停用再启用，桌宠会以新脚本重新拉起。
- 桌宠窗口会盖住它下面的内容；它只在 DSH 运行时存在，DSH 一停就自己退场（5 秒心跳）。
- 系统需要 WebView2 Runtime（Win11 自带；Win10 多半也有），以及 PowerShell 7（`pwsh`）。
- `wsServer` 之外的插件若也注册 `/live2d` 前缀会与本插件冲突（webserver 前缀路由重复会抛错）。
