/**
 * dsh-live2d — Host half.
 *
 * 四件事：
 *  1. 把「DS面捕版」里的 Cubism 4 模型按静态资源提供给浏览器（含一份动态生成的
 *     model3.json，把散装的表情 / 动作文件登记成模型设置）。
 *  2. 维护头像状态（当前状态 + 最近一条表达），供浏览器轮询。
 *  3. 注册 `live2d_express` 工具，让模型把自己的想法 / 看法 / 闲聊推到 Live2D 形象上。
 *  4. 提供宠物页，并按配置拉起桌面桌宠（WebView2 外壳）。
 *
 * 生成模型设置那一刻起，两侧就只通过 /live2d/* 路由 + /live2d/state 通信。
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync as readFileSyncSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** 声明的服务：缺任何一个，cordis 会把本插件挂起而不是带着半成品运行。 */
export const inject = ['tools', 'webServer', 'systemPrompt']

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(HERE, 'vendor')

/** 浏览器运行时：pixi.js 6 + 官方 Cubism Core + pixi-live2d-display(Cubism4)。 */
const LIBS = {
  'pixi.min.js': 'text/javascript; charset=utf-8',
  'live2dcubismcore.min.js': 'text/javascript; charset=utf-8',
  'cubism4.min.js': 'text/javascript; charset=utf-8',
}

/**
 * 情绪 → 表情文件。id 会进入工具枚举，file 为 null 表示恢复默认脸。
 * 顺序即 Expressions 数组下标，客户端按下标切换表情。
 */
const EMOTIONS = [
  { id: 'neutral', label: '平静', file: null },
  { id: 'happy', label: '开心', file: '开心兴奋.exp3.json' },
  { id: 'sad', label: '难过', file: '悲伤.exp3.json' },
  { id: 'angry', label: '生气', file: '生气.exp3.json' },
  { id: 'cry', label: '哭了', file: '哭.exp3.json' },
  { id: 'shy', label: '害羞', file: '脸红.exp3.json' },
  { id: 'sparkle', label: '眼冒星星', file: '星星眼.exp3.json' },
  { id: 'confused', label: '困惑', file: '问号.exp3.json' },
  { id: 'nervous', label: '冒汗', file: '流汗.exp3.json' },
  { id: 'dizzy', label: '晕乎乎', file: '晕晕.exp3.json' },
  { id: 'love', label: '满眼爱心', file: '爱心眼.exp3.json' },
  { id: 'gloomy', label: '阴郁', file: '阴暗.exp3.json' },
  { id: 'playful', label: '调皮', file: '调皮.exp3.json' },
  { id: 'cool', label: '耍酷', file: '墨镜.exp3.json' },
  { id: 'tongue', label: '吐舌', file: '吐舌.exp3.json' },
  { id: 'shocked', label: '震惊', file: '感叹号.exp3.json' },
  { id: 'exhausted', label: '灵魂出窍', file: '吐魂.exp3.json' },
  { id: 'blank', label: '发呆', file: '呆呆眼.exp3.json' },
]
const EMOTION_IDS = EMOTIONS.map(e => e.id)
const EMOTION_LABELS = new Map(EMOTIONS.map(e => [e.id, e.label]))

/** 表达模式：决定气泡的标签与默认停留时间。 */
const MODES = ['thought', 'opinion', 'chat', 'status']
const IDLE_MOTION_FILE = join('motions', 'idle.motion3.json')

/** 表情淡入秒数。0.5s 是 pixi-live2d-display 的默认值，换脸偏生硬，放宽一点。 */
const EXPRESSION_FADE_SECONDS = 0.9

/** 表情文件后缀。extname 只看最后一段，判断要用 endsWith。 */
const EXPRESSION_SUFFIX = '.exp3.json'

/**
 * 桌面桌宠的拉起配置。
 *
 * 为什么要 Host 来拉：桌宠是一个**独立的桌面进程**，网页无法唤起它 ——
 * 浏览器只能在窗口内部画画，窗口一最小化就没了。要「DSH 开着时桌面上一直有它」，
 * 必须由 Host 在启动时把这个进程拉起来。
 */
const PET_SCRIPT = join('pet', 'dsh-pet.ps1')

/**
 * 找到可用的 PowerShell 7（pwsh）的**绝对路径**。
 *
 * 必须解析成绝对路径：`spawn('pwsh.exe', …, { detached: true })` 在 Windows 上
 * 会先起一个 shell 去解析命令名，而 detached 的 shell 常常在真正执行之前就退出，
 * 于是子进程报 code 0、脚本却一行都没跑（我就是这么白查了两轮）。
 */
function findPwsh() {
  const candidates = [
    process.env.DSH_PWSH,
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ].filter(value => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* 忽略无法访问的候选 */ }
  }
  return null
}

const SETTINGS_SUFFIX = '.model3.json'
const TEXT_TYPES = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.moc3', 'application/octet-stream'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])
const ASSET_EXTENSIONS = new Set(['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp'])

/**
 * 模型目录候选，按优先级：
 *   1. 插件配置 `modelDir`
 *   2. 环境变量 `DSH_LIVE2D_MODEL_DIR`
 *   3. 插件自带的 `model/`（仓库里就带着，clone 下来开箱即用）
 *   4. 插件旁边/上两级的 `DS面捕版`（开发时的原始位置）
 *
 * 第 3 条是给「clone 就能跑」用的 —— 前两条都要用户自己动手，第 4 条只在
 * 开发机上存在。都没有时会走到 discoverModel 的报错分支，那里会说清怎么办。
 */
function modelDirCandidates(config) {
  const candidates = []
  if (config && typeof config.modelDir === 'string' && config.modelDir.length > 0) candidates.push(config.modelDir)
  if (typeof process.env.DSH_LIVE2D_MODEL_DIR === 'string' && process.env.DSH_LIVE2D_MODEL_DIR.length > 0) {
    candidates.push(process.env.DSH_LIVE2D_MODEL_DIR)
  }
  candidates.push(resolve(HERE, 'model'))
  candidates.push(resolve(HERE, '..', '..', 'DS面捕版'))
  candidates.push(resolve(HERE, '..', '..', '..', 'DS面捕版'))
  return [...new Set(candidates)]
}

/** 在候选目录里找一份 `*.model3.json`，返回 { dir, settingsFile, name }。 */
function discoverModel(config) {
  for (const dir of modelDirCandidates(config)) {
    let entries
    try {
      if (!existsSync(dir)) continue
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const settings = entries.filter(name => name.endsWith(SETTINGS_SUFFIX))
    if (settings.length === 0) continue
    const wanted = typeof config?.modelFile === 'string' && settings.includes(config.modelFile)
      ? config.modelFile
      : settings[0]
    return { dir, settingsFile: wanted, name: wanted.slice(0, -SETTINGS_SUFFIX.length) }
  }
  return null
}

function contentTypeFor(path) {
  return TEXT_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream'
}

/**
 * 校验共享引擎源码。
 *
 * 引擎是 `engine.js` —— 形象的**唯一**实现（适配、待机动作、手势、笔、行为常量）。
 * 它整段内嵌进宠物页，所以所有宿主行为必然一致。
 *
 * 早先这里是从 `client.js`（已移除的浏览器浮层版）按 `#region` 切区块，踩过两次坑：
 * 一次是 `fitModel` 挪进区块后切分逻辑只取常量，页面报 `fitModel is not defined`；
 * 一次是同时交付整块与切出的常量，导致 `IDLE_MODE has already been declared` ——
 * 浏览器里一个语法错误会让整个 script 块作废。改成独立文件后这两类问题都不存在。
 *
 * @param engineSource - engine.js 的全文。
 * @returns 引擎源码；缺少必需符号或声明重名时返回 null（宁可报错也不静默降级）。
 */
function validateEngine(engineSource) {
  const required = [
    'function fitModel(', 'function viewportOf(', 'function computeFit(', 'function intrinsicSize(',
    'function createIdleAnimator(', 'function createDrift(', 'function gestureWave(', 'function advanceFollower(',
    'function parameterHandle(', 'function nextGazeTarget(', 'function pickRange(',
    'const IDLE_MODE', 'const MURMURS', 'const REACTIONS', 'const IDLE_EXPRESSIONS',
    'const IDLE_EXPRESSION_MIN_MS', 'const IDLE_EXPRESSION_QUIET_MS',
    'const REACTION_MODE', 'const REACTION_VISIBLE_MS',
  ]
  for (const symbol of required) {
    if (!engineSource.includes(symbol)) return null
  }
  // 顶层声明不得重复 —— 重名会让浏览器丢弃整个 script 块。
  const declared = [...engineSource.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
  if (new Set(declared).size !== declared.length) return null
  return engineSource
}

/**
 * 宠物页。
 *
 * 背景透明，让桌面透出来。引擎（适配 + 待机动作 + 手势 + 笔 + 行为常量）
 * 整段内嵌自 `engine.js` —— 唯一实现。
 *
 * 拖动通过 `postMessage` 通知宿主：WebView2 的控制器铺满客户区，会吃掉所有
 * 鼠标事件，WinForms 侧的 MouseDown 永远不触发，所以拖动必须在页面里发起。
 */
function petPage(engine) {
  const scripts = Object.keys(LIBS)
    .map(name => '<script src="/live2d/lib/' + name + '"></script>')
    .join('')
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live2D 桌宠</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 13px/1.5 system-ui, "Segoe UI", sans-serif; -webkit-user-select: none; user-select: none; }
  #stage { position: fixed; inset: 0; }
  #stage canvas { display: block; }
  #bubble { position: fixed; left: 8px; right: 8px; bottom: 8px; padding: 8px 10px;
    border-radius: 12px; background: rgba(18,19,23,.92); color: #eef0f4;
    border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 24px rgba(0,0,0,.35);
    opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s;
    pointer-events: none; word-break: break-word; }
  #bubble.on { opacity: 1; transform: none; }
  #bubble .tag { display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 999px;
    background: #4d6bfe; color: #fff; font-size: 11px; }
  #hint { position: fixed; inset: 0; display: grid; place-items: center; color: #c8ccd4;
    text-align: center; padding: 16px; }
  /* 状态指示：贴近形象的头顶。
     模型按 contain 居中，四周留白 —— 固定 top 值在窗口变大时会离人物越来越远。
     做法：先按容器高度把状态栏放在「模型顶边往上一点」的位置，
     再由 JS 依当前视口实时校正（见 placeStatus）。 */
  #status { position: fixed; left: 12px; top: 34px; display: inline-flex; align-items: center;
    gap: 6px; padding: 4px 9px; border-radius: 999px; font-size: 11px; line-height: 1.3;
    background: rgba(18,19,23,.82); color: #c8ccd4;
    border: 1px solid rgba(255,255,255,.14); pointer-events: none; }
  #status .dot { width: 7px; height: 7px; border-radius: 50%; background: #6b7280; }
  #status.thinking { color: #eef0f4; }
  #status.thinking .dot { background: #4d6bfe; animation: pulse 1.6s ease-in-out infinite; }
  /* 绿：任务完成。用常亮 + 轻微光晕，让它在余光里也看得出「好了」。 */
  #status.done { color: #d7f7e2; border-color: rgba(52,199,123,.45); }
  #status.done .dot { background: #34c77b; box-shadow: 0 0 6px rgba(52,199,123,.9); }
  /* 黄：等你操作（权限申请、问卷）。用脉冲 —— 这是唯一需要你抬手的时刻，
     必须比「思考中」更抓眼，否则会被当成背景噪音忽略掉。 */
  #status.waiting { color: #fff4d6; border-color: rgba(240,180,41,.5); }
  #status.waiting .dot { background: #f0b429; animation: pulse .9s ease-in-out infinite;
    box-shadow: 0 0 8px rgba(240,180,41,.9); }
  @keyframes pulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
</style></head><body>
<div id="stage"></div><div id="bubble"></div>
<div id="status"><span class="dot"></span><span id="statusText">待机</span></div>
<div id="hint">正在唤醒形象…</div>
${scripts}
<script>
${engine}
</script>
<script>
(function () {
  var hint = document.getElementById('hint');
  var bubble = document.getElementById('bubble');
  var stage = document.getElementById('stage');
  var statusEl = document.getElementById('status');
  var statusText = document.getElementById('statusText');
  var model = null, app = null, animator = null, revision = null, hideTimer = null;
  var bubbleShowing = false;

  /**
   * 状态指示。四态：
   *   idle     待机     灰
   *   thinking 思考中   蓝（脉冲）
   *   waiting  等你操作 黄（快脉冲）← 权限申请 / 问卷
   *   done     完成了   绿（常亮）
   */
  function setStatus(next) {
    var map = {
      idle: '待机', thinking: '思考中', waiting: '等你操作', done: '完成了'
    };
    statusText.textContent = map[next] || '待机';
    statusEl.classList.remove('thinking', 'waiting', 'done');
    if (next === 'thinking' || next === 'waiting' || next === 'done') {
      statusEl.classList.add(next);
    }
  }

  /**
   * 把状态栏放到形象的头顶附近。
   *
   * 要求是「靠近形象一点」。模型按 contain 居中、四周有留白，所以固定 top 值
   * 在窗口变大时会让状态栏离人物越来越远。这里直接问模型的包围盒，
   * 把它放在人物上沿再往上一点的位置。
   */
  function placeStatus() {
    if (!model || !stage || !statusEl) return;
    var b;
    try { b = model.getBounds(); } catch (e) { return; }
    if (!b || !(b.height > 0)) return;
    // 头顶再往上 30px；但不越出窗口上沿（至少留 8px）
    var top = Math.max(8, b.y - 30);
    var left = Math.max(8, Math.min(b.x + 6, stage.clientWidth - 90));
    statusEl.style.top = Math.round(top) + 'px';
    statusEl.style.left = Math.round(left) + 'px';
  }

  // 气泡文案与浮层保持一致
  var LABEL = {
    thought: '心里话', opinion: '看法', chat: '闲聊', status: '状态',
    idle: '碎碎念', poke: '被戳了', proactive: '自己嘀咕', reasoning: '思维链',
    done: '干完了'
  };

  function show(text, tag, holdMs) {
    bubble.textContent = '';
    if (tag) {
      var span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tag;
      bubble.appendChild(span);
    }
    bubble.appendChild(document.createTextNode(text));
    bubble.classList.add('on');
    bubbleShowing = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { bubble.classList.remove('on'); bubbleShowing = false; }, holdMs || 15000);
  }

  function applyExpression(emotion) {
    if (!model || !window.__petManifest) return Promise.resolve();
    var manifest = window.__petManifest;
    var em = model.internalModel.motionManager.expressionManager;
    if (!em) return Promise.resolve();
    var entry = (manifest.expressions || []).filter(function (e) { return e.id === emotion; })[0];
    if (!entry) { em.resetExpression(); return Promise.resolve(); }
    return model.expression(entry.id).then(function (ok) {
      if (ok === false && typeof entry.index === 'number') return model.expression(entry.index);
    }).catch(function () { });
  }

  // 点击身体 → 反应：向 Host 要一句**现场生成**的话，而不是从预设里挑。
  //
  // 预设的问题：点第二次就重复，而且和 Agent 此刻在做的事毫无关系。
  // 生成失败（没有活跃会话、模型报错）时退回一句最短的状态话 —— 点击必须有反应。
  var pokeBusy = false;
  function poke() {
    if (pokeBusy) return;          // 连点不叠请求
    pokeBusy = true;
    fetch('/live2d/poke', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (data) {
        pokeBusy = false;
        if (data && data.ok && data.text) {
          show(data.text, LABEL[REACTION_MODE] || REACTION_MODE, REACTION_VISIBLE_MS);
          if (animator) { try { animator.poke(); } catch (e) { } }
          applyExpression(data.emotion || 'happy');
          return;
        }
        // 生成不出来时也别沉默：说一句诚实的短话
        show('……嗯？', LABEL[REACTION_MODE] || REACTION_MODE, REACTION_VISIBLE_MS);
        if (animator) { try { animator.poke(); } catch (e) { } }
        applyExpression('confused');
      })
      .catch(function () {
        pokeBusy = false;
        show('……嗯？', LABEL[REACTION_MODE] || REACTION_MODE, REACTION_VISIBLE_MS);
        if (animator) { try { animator.poke(); } catch (e) { } }
      });
  }
  // 拖动：由页面发起，通过 postMessage 通知宿主移动窗口。
  //
  // 为什么不能在 WinForms 侧做：WebView2 的控制器铺满整个客户区，会接走所有鼠标
  // 事件，Form 的 MouseDown 永远不触发 —— 早先挂在 Form 上的拖动代码从未生效过。
  var dragging = false;
  var dragStart = null;

  /** 告诉宿主：把这个窗口按 (dx, dy) 移动。宿主会做 DPI 换算。 */
  function post(type, payload) {
    try {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(Object.assign({ type: type }, payload || {}));
      }
    } catch (e) { /* 非 WebView2 宿主忽略（页面在普通浏览器里打开时走这里） */ }
  }

  // 只有**按在形象身上**才开始拖动。
  //
  // 这是明确要求：拖窗口不该在任何地方都能拖 —— 空白处（画布透明区）按下不移动窗口，
  // 只有碰到身体才拖。判据复用 onModel（模型包围盒），与戳击用同一套。
  stage.addEventListener('pointerdown', function (event) {
    stage.__pressedAt = { x: event.clientX, y: event.clientY };
    if (event.button !== 0) return;
    if (!onModel(event.clientX, event.clientY)) return;   // 不在身上 → 不拖
    dragging = true;
    dragStart = { x: event.screenX, y: event.screenY };
    try { stage.setPointerCapture(event.pointerId); } catch (e) { }
  });

  stage.addEventListener('pointermove', function (event) {
    if (!dragging || !dragStart) return;
    // 用 screenX/screenY：它是屏幕物理坐标，不受页面内缩放影响。
    var dx = event.screenX - dragStart.x;
    var dy = event.screenY - dragStart.y;
    if (dx === 0 && dy === 0) return;
    dragStart = { x: event.screenX, y: event.screenY };
    post('drag', { dx: dx, dy: dy });
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    dragStart = null;
    try { stage.releasePointerCapture(event.pointerId); } catch (e) { }
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('click', function (event) {
    var p = stage.__pressedAt;
    if (p && Math.hypot(event.clientX - p.x, event.clientY - p.y) > 8) return;
    if (!onModel(event.clientX, event.clientY)) return;
    poke();
  });

  // 滚轮缩放：同样交给宿主处理（它会换算 DPI 并重设 WebView2 边界）
  stage.addEventListener('wheel', function (event) {
    event.preventDefault();
    post('zoom', { delta: event.deltaY < 0 ? 1 : -1 });
  }, { passive: false });

  // 只有戳到形象本体才算（画布四角是透明的）
  function onModel(clientX, clientY) {
    if (!model || !stage) return false;
    var b;
    try { b = model.getBounds(); } catch (e) { return false; }
    if (!b || !(b.width > 0) || !(b.height > 0)) return false;
    var rect = stage.getBoundingClientRect();
    var x = clientX - rect.left, y = clientY - rect.top, pad = 6;
    return x >= b.x - pad && x <= b.x + b.width + pad && y >= b.y - pad && y <= b.y + b.height + pad;
  }

  // 待机换脸：没人推新表情时自己换一张（与浮层同池、同节流）
  var lastRealEmotionAt = 0;
  function scheduleIdleExpression() {
    var wait = IDLE_EXPRESSION_MIN_MS + Math.random() * IDLE_EXPRESSION_SPAN_MS;
    setTimeout(function () {
      if (!bubbleShowing && Date.now() - lastRealEmotionAt >= IDLE_EXPRESSION_QUIET_MS) {
        var pick = IDLE_EXPRESSIONS[Math.floor(Math.random() * IDLE_EXPRESSIONS.length)];
        applyExpression(pick);
      }
      scheduleIdleExpression();
    }, wait);
  }

  // 待机碎碎念
  function scheduleMurmur() {
    var wait = MURMUR_MIN_MS + Math.random() * MURMUR_SPAN_MS;
    setTimeout(function () {
      if (!bubbleShowing) {
        var line = MURMURS[Math.floor(Math.random() * MURMURS.length)];
        show(line, LABEL[IDLE_MODE], MURMUR_VISIBLE_MS);
        // 碎碎念是纯页面逻辑，不经过 Host 的 state.message ——
        // 不主动上报的话它就永远没声音（这是漏掉的一条路径）。
        requestMurmurSpeech(line);
      }
      scheduleMurmur();
    }, wait);
  }

  /** 把碎碎念交给 Host 合成。失败只是没声音，不该影响画面。 */
  function requestMurmurSpeech(line) {
    try {
      fetch('/live2d/murmur?text=' + encodeURIComponent(line), { cache: 'no-store' })
        .catch(function () { /* 没声音而已 */ });
    } catch (e) { /* 同上 */ }
  }

  // 清晰度：用**原版精度** —— 1 CSS 像素 = 1 物理像素。
  //
  // 早先我强制 2× 超采样，结果反而更糊。根因是当时进程是 DPI UNAWARE：
  // 系统把整个窗口位图拉伸 1.5 倍（实测桌面真实 1920×1200，WinForms 只报 1280×800），
  // 渲染到 680×920 的缓冲被插值放大到 1020×1380 显示 —— 多糊一层。
  // 现在外壳已声明 Per-Monitor V2 DPI 感知，物理像素如实交给我们，
  // 1:1 渲染就是最清晰的；超采样只会让 GPU 白做工、再被系统缩放一次。
  var SUPERSAMPLE = 1;
  function resolutionFor() {
    // 仍尊重真实的 devicePixelRatio（高 DPI 下可能是 1.5 / 2），但不人为抬高。
    var dpr = window.devicePixelRatio || 1;
    return Math.min(3, Math.max(SUPERSAMPLE, dpr));
  }

  async function boot() {
    if (!window.PIXI || !window.PIXI.live2d) { hint.textContent = '运行时未就绪'; return; }
    var Live2DModel = window.PIXI.live2d.Live2DModel;
    Live2DModel.registerTicker(window.PIXI.Ticker);
    var manifest = await (await fetch('/live2d/manifest')).json();
    if (!manifest.ok) { hint.textContent = manifest.error || '没有模型'; return; }
    window.__petManifest = manifest;

    app = new window.PIXI.Application({
      backgroundAlpha: 0, antialias: true, autoDensity: true,
      resolution: resolutionFor(), resizeTo: stage,
    });
    stage.appendChild(app.view);
    model = await Live2DModel.from(manifest.modelUrl, { autoInteract: false });

    // 贴图缩小时必须开 mipmap，否则线性采样严重走样（第二个糊源）。
    try {
      var mip = window.PIXI.MIPMAP_MODES ? window.PIXI.MIPMAP_MODES.ON : 1;
      model.textures.forEach(function (tex) {
        if (tex && tex.baseTexture) {
          tex.baseTexture.mipmap = mip;
          tex.baseTexture.update();
        }
      });
    } catch (e) { /* 开不了 mipmap 也不该让画面挂掉 */ }

    app.stage.addChild(model);
    // 适配用共享的 fitModel（只用 CSS 逻辑像素）
    var fit = function () { fitModel(model, app, stage); placeStatus(); };
    fit();
    new ResizeObserver(fit).observe(stage);
    hint.style.display = 'none';

    // 先把状态挂出去，再做其余初始化。
    // 之前 __pet 放在 createIdleAnimator 之后，那一步一旦抛错就永远不赋值 ——
    // 画面是好的、探针却报 undefined，我被这个顺序骗过一次。
    window.__pet = { manifest: manifest, model: model, animator: null, resolution: resolutionFor() };

    // 待机动作：共享的动画器，挂在 afterMotionUpdate 上
    try {
      animator = createIdleAnimator(model, {});
      if (animator) {
        var prev = performance.now();
        model.internalModel.on('afterMotionUpdate', function () {
          var now = performance.now();
          var dt = now - prev; prev = now;
          try { animator.step(dt, window.__petStatus || 'idle'); } catch (e) { }
        });
        window.__pet.animator = animator;
      }
    } catch (e) {
      console.error('待机动画器初始化失败：', e);
    }
    scheduleIdleExpression();
    scheduleMurmur();

    // 轮询真实表达（Agent 的真实想法优先于碎碎念）
    // 轮询计数与最后一次错误挂到 window 上：静默失败最难查，自检要能看到。
    window.__pollCount = 0;
    setInterval(async function () {
      try {
        var s = await (await fetch('/live2d/state', { cache: 'no-store' })).json();
        window.__pollCount++;
        window.__lastPollError = null;
        if (typeof s.status === 'string') { window.__petStatus = s.status; setStatus(s.status); }
        // 音频要在**每次轮询**都看一眼，不能只在 revision 变化时看：
        // 碎碎念不改 state.message，也就不会推 revision，绑在一起就会漏播。
        // playAudio 自己按 audio.id 判重，所以每轮调用是安全的。
        playAudio(s.audio);
        if (revision === null) { revision = s.revision; return; }
        if (s.revision === revision) return;
        revision = s.revision;
        if (!s.message) return;
        lastRealEmotionAt = Date.now();
        show(s.message.text, s.message.emotionLabel || LABEL[s.message.mode] || s.message.mode, 15000);
        await applyExpression(s.message.emotion);
      } catch (e) {
        window.__lastPollError = (e && e.message) ? e.message : String(e);
      }
    }, 900);
  }

  /**
   * 播放语音。同一个 id 只播一次。
   *
   * 播放失败（浏览器还没拿到用户手势、或音频被自动播放策略拦下）不该影响画面，
   * 所以整段吞掉异常，只把结果回报给 Host —— 否则「到底响没响」只能靠猜。
   */
  var lastAudioId = null;
  function playAudio(audio) {
    if (!audio || typeof audio.url !== 'string') return;
    if (audio.id === lastAudioId) return;
    lastAudioId = audio.id;
    function report(ok, detail) {
      window.__lastAudioError = ok ? null : detail;
      try {
        fetch('/live2d/audio-status?id=' + encodeURIComponent(audio.id)
          + '&ok=' + (ok ? '1' : '0')
          + '&detail=' + encodeURIComponent(String(detail).slice(0, 200)),
          { cache: 'no-store' }).catch(function () {});
      } catch (e) { /* 回报本身失败不该影响画面 */ }
    }
    try {
      var el = new Audio(audio.url);
      el.volume = 1.0;
      var p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          window.__lastAudioPlayed = audio.id;
          report(true, 'playing');
        }).catch(function (e) {
          report(false, (e && e.message) ? e.message : String(e));
        });
      } else {
        window.__lastAudioPlayed = audio.id;
        report(true, 'playing(no-promise)');
      }
    } catch (e) {
      report(false, (e && e.message) ? e.message : String(e));
    }
  }

  boot().catch(function (e) { hint.textContent = '加载失败：' + (e && e.message ? e.message : e); });
})();
</script>
</body></html>`
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function sendFile(res, absolute, cacheControl = 'no-cache') {
  const info = await stat(absolute)
  if (!info.isFile()) return sendJson(res, 404, { error: 'not a file' })
  res.writeHead(200, {
    'content-type': contentTypeFor(absolute),
    'content-length': info.size,
    'cache-control': cacheControl,
  })
  createReadStream(absolute).pipe(res)
}

/**
 * 把官方 model3.json 与散装表情 / 动作合成为浏览器可直接加载的设置文件。
 * 缺失的文件会被跳过，因此表情表始终是「磁盘上真实存在」的那一份。
 * @returns {{ settings: object, expressions: Array<{id:string,label:string,index:number,file:string}> }}
 */
function composeSettings(base, model) {
  const refs = base.FileReferences ?? {}
  const expressions = []
  const registry = []
  for (const emotion of EMOTIONS) {
    if (emotion.file === null) continue
    if (!existsSync(join(model.dir, emotion.file))) continue
    registry.push({ id: emotion.id, label: emotion.label, index: expressions.length, file: emotion.file })
    expressions.push({ Name: emotion.id, File: emotion.file })
  }
  const motions = {}
  if (existsSync(join(model.dir, IDLE_MOTION_FILE))) {
    motions.Idle = [{ File: 'motions/idle.motion3.json', FadeInTime: 1, FadeOutTime: 1 }]
  }
  const settings = {
    Version: base.Version ?? 3,
    FileReferences: {
      Moc: refs.Moc,
      Textures: refs.Textures ?? [],
      ...(refs.Physics === undefined ? {} : { Physics: refs.Physics }),
      ...(refs.DisplayInfo === undefined ? {} : { DisplayInfo: refs.DisplayInfo }),
      ...(expressions.length === 0 ? {} : { Expressions: expressions }),
      ...(Object.keys(motions).length === 0 ? {} : { Motions: motions }),
    },
    Groups: base.Groups ?? [],
  }
  return { settings, expressions: registry }
}

/**
 * 注册 Live2D 形象：资源路由 + 状态 + 表达工具 + 提示词。
 * @param ctx - 已注入 tools / webServer / systemPrompt 的 Host Context。
 * @param config - 可选部署配置：{ modelDir?, modelFile? }。
 */
export function apply(ctx, config) {
  // 成功解析一次即缓存；未解析时每次请求重试，方便用户事后补上模型目录。
  let cached = null
  let cachedError = '未找到 Live2D 模型目录（可在插件配置里指定 modelDir，或设置环境变量 DSH_LIVE2D_MODEL_DIR）'
  /** 补过 FadeInTime 的表情文件，按相对路径缓存。 */
  const expressionCache = new Map()
  /** engine.js 的内容；只读一次。 */
  let engineCache

  function engineSource() {
    if (engineCache !== undefined) return engineCache
    try {
      engineCache = validateEngine(readFileSyncSync(join(HERE, 'engine.js'), 'utf8'))
    } catch (error) {
      console.warn('[dsh-live2d] 读取 engine.js 失败：', error)
      engineCache = null
    }
    if (engineCache === null) {
      console.warn('[dsh-live2d] engine.js 缺少必需符号或有重复声明，宠物页无法渲染')
    }
    return engineCache
  }

  async function ensureModel() {
    if (cached !== null) return cached
    const model = discoverModel(config)
    if (model === null) return null
    const raw = await readFile(join(model.dir, model.settingsFile), 'utf8')
    const composed = composeSettings(JSON.parse(raw), model)
    cached = { ...model, ...composed }
    cachedError = null
    console.log(`[dsh-live2d] 已加载模型 ${cached.name}（${cached.dir}），表情 ${cached.expressions.length} 个`)
    return cached
  }

  // ── 状态 ────────────────────────────────────────────────────────────────
  const state = { revision: 0, message: null, audio: null }

  // ── 语音：把气泡里的话用大肥鱼的声音念出来 ──────────────────────────────
  /**
   * 流水线在 `voice/speak.py` 里：
   *   文字 → Windows SAPI 出声 → contentvec 特征 + F0 → ddsp-svc 6.2 → 大肥鱼音色 wav
   *
   * **为什么只念最新一条，不排队**：CPU 推理一句要十几秒。排队的话语音会越拖越久、
   * 和气泡完全对不上（气泡早换了三轮，喇叭还在念第一句）。所以只保留最新待念的那条，
   * 旧的在开始合成前就被新来的顶掉 —— 宁可漏念，也不要念过时的。
   */
  /**
   * 语音流水线放在哪。
   *
   * 这条流水线（ddsp-svc 音色转换）**不在本仓库里** —— 它要几个 GB 的
   * 预训练权重，和插件本身是两回事。所以这里不给「指向某个人的硬盘」的默认值，
   * 而是：配置 > 环境变量 > 插件目录下的 `voice/`。
   *
   * 语音默认是关的，所以没配也不会影响主功能；真开了又没配全，
   * `speechReady()` 会给出缺哪一项，而不是让 worker 静默启动失败。
   */
  const VOICE_DIR = (() => {
    if (typeof config?.speechDir === 'string' && config.speechDir.length > 0) return config.speechDir
    const env = process.env.DSH_LIVE2D_VOICE_DIR
    if (typeof env === 'string' && env.length > 0) return env
    return resolve(HERE, 'voice')
  })()

  const pick = (configValue, envName, fallback) => {
    if (typeof configValue === 'string' && configValue.length > 0) return configValue
    const env = process.env[envName]
    if (typeof env === 'string' && env.length > 0) return env
    return fallback
  }

  const SPEECH = {
    dir: VOICE_DIR,
    script: pick(config?.speechScript, 'DSH_LIVE2D_SPEAK_PY', join(VOICE_DIR, 'speak.py')),
    worker: pick(config?.speechWorker, 'DSH_LIVE2D_WORKER_PY', join(VOICE_DIR, 'worker.py')),
    // Python 解释器必须自带 torch —— 没有通用默认值，只能由用户指定。
    // 留空字符串而不是瞎猜一个路径，这样 speechReady() 能报「缺 python」而不是
    // 报一个看不懂的 spawn 失败。
    python: pick(config?.speechPython, 'DSH_LIVE2D_PYTHON', ''),
    // 隔离依赖目录：系统 Python 里通常没有 soundfile / pyworld / soxr 等，
    // 必须显式注入，否则 worker 一启动就 ImportError。
    pythonPath: pick(config?.speechPythonPath, 'DSH_LIVE2D_PYTHONPATH',
      [join(VOICE_DIR, 'shim'), join(VOICE_DIR, 'pkgs')].join(';')),
    steps: Number.isFinite(config?.speechSteps) ? config.speechSteps : 8,
    timeoutMs: Number.isFinite(config?.speechTimeoutMs) ? config.speechTimeoutMs : 120_000,
    maxChars: Number.isFinite(config?.speechMaxChars) ? config.speechMaxChars : 60,
    // 哪些 mode 要出声。**默认全部都念** —— 碎碎念、任务报告、闲聊、自己的想法、状态
    // 都该有声音，这是明确要求。要少念就用 speechModes 收窄。
    modes: Array.isArray(config?.speechModes)
      ? config.speechModes
      : ['thought', 'opinion', 'chat', 'poke', 'proactive', 'reasoning', 'done', 'idle', 'status', 'murmur'],
    // **默认关闭**。当前检查点的内容保真度只有约 0.55（清晰语音需要 0.9+），
    // 出声但听不懂，反而干扰。整条链路是好的、随时能开：
    // 在 profile 的 patch 里给 dsh-live2d-avatar 加 `speech: 'on'` 即可。
    enabled: (config?.speech ?? 'off') === 'on',
  }

  /**
   * 语音链路的就绪检查。返回缺失项清单（空数组 = 齐了）。
   *
   * 存在的意义：worker 起不来时现象只是「永远不出声」，看不出原因。
   * 与其让用户对着一个哑巴排查，不如直接说清缺哪个文件/哪一项配置。
   */
  function speechMissing() {
    const missing = []
    if (SPEECH.python === '') missing.push('Python 解释器（config.speechPython 或 DSH_LIVE2D_PYTHON）')
    else if (!existsSync(SPEECH.python)) missing.push(`Python 解释器不存在：${SPEECH.python}`)
    if (!existsSync(SPEECH.script)) missing.push(`speak.py 不存在：${SPEECH.script}`)
    if (!existsSync(SPEECH.worker)) missing.push(`worker.py 不存在：${SPEECH.worker}`)
    return missing
  }
  const speech = {
    busy: false, pending: null, last: null,
    spoken: 0, failed: 0, dropped: 0, lastError: null, dir: null, playback: null,
  }

  /** 语音 wav 放哪。用 tmpdir 而不是插件目录：这些是一次性产物，不该进版本库。 */
  function speechDir() {
    if (speech.dir === null) {
      speech.dir = join(tmpdir(), 'dsh-live2d-voice')
      try { mkdirSync(speech.dir, { recursive: true }) } catch { /* 已存在 */ }
    }
    return speech.dir
  }

  /** 这句话该不该念。 */
  function shouldSpeak(message) {
    if (!SPEECH.enabled) return false
    if (message === null || typeof message.text !== 'string') return false
    if (message.text.trim().length === 0) return false
    if (!SPEECH.modes.includes(message.mode)) return false
    return true
  }

  /**
   * 登记一条待念的话。永远只留最新的那条。
   *
   * `standalone` 用于碎碎念/状态这类**不改 state.message** 的话：
   * 它们没有「气泡是否还是同一条」可校验，所以要跳过防错位检查，
   * 否则会被当成过期内容直接丢掉。
   */
  function enqueueSpeech(message, standalone = false) {
    if (!shouldSpeak(message)) return
    if (speech.pending !== null) speech.dropped += 1
    speech.pending = standalone ? { ...message, standalone: true } : message
    void speechLoop()
  }

  /** 合成循环：空闲且有活时跑一条。 */
  async function speechLoop() {
    if (speech.busy) return
    const job = speech.pending
    if (job === null) return
    speech.pending = null
    speech.busy = true
    try {
      const file = join(speechDir(), `v${state.revision}_${Date.now()}.wav`)
      const text = job.text.slice(0, SPEECH.maxChars)
      const standalone = job.standalone === true
      await runSpeechScript(text, file)
      // 合成要十几秒，这期间气泡很可能已经换过好几轮了。
      // 只有「当前气泡仍是当初排队的这一条」时才公布音频 ——
      // 否则会出现嘴在念上一句、气泡显示下一句的错位（实测踩到过）。
      // standalone（碎碎念/状态）没有气泡可校验，跳过这一步。
      if (job.standalone !== true && (state.message === null || state.message.id !== job.id)) {
        speech.dropped += 1
        try { unlinkSync(file) } catch { /* 删不掉就算了，下次覆盖 */ }
        return
      }
      // standalone 任务要带上自己的身份：页面靠 audio.id 判重，
      // 而 standalone 的 id 是 murmur-xxx 这种字符串，不会和消息 revision 撞。
      speech.last = {
        id: standalone ? job.id : state.revision,
        url: `/live2d/audio/${basename(file)}`,
        text,
        at: Date.now(),
      }
      state.audio = speech.last
      state.revision += 1
      speech.spoken += 1
      speech.lastError = null
    } catch (error) {
      speech.failed += 1
      speech.lastError = error instanceof Error ? error.message : String(error)
    } finally {
      speech.busy = false
      // 合成期间又来了新的，接着跑
      if (speech.pending !== null) void speechLoop()
    }
  }

  /** 跑一次语音合成。失败必须带出原因，不能静默。 */
  function runSpeechScript(text, outFile) {
    return speakViaWorker(text, outFile)
  }

  // ── 常驻语音工作进程 ──────────────────────────────────────────────────
  /**
   * 为什么常驻：实测一句 17 秒里，`import torch` + 加载模型占了 4 秒多，
   * 而 SAPI 每次冷启 pwsh 还要再花 1.5 秒。常驻之后每句约 5 秒。
   *
   * 协议：stdin/stdout 各一行一条 JSON；首行 {"ready":true} 表示就绪。
   */
  const worker = { proc: null, ready: null, buf: '', resolver: null, lastError: null }

  function ensureWorker() {
    if (worker.ready !== null && worker.proc !== null && worker.proc.exitCode === null) {
      return worker.ready
    }
    // 先做就绪检查：缺 Python / 缺脚本时直接给一句人能看懂的话。
    // 否则现象只是「永远不出声」，用户对着哑巴排查不出原因。
    const missing = speechMissing()
    if (missing.length > 0) {
      const detail = `语音未配置完整，缺少：${missing.join('；')}`
      worker.lastError = detail
      speech.lastError = detail
      return Promise.reject(new Error(detail))
    }
    worker.ready = new Promise((resolveReady, rejectReady) => {
      let settled = false
      const failReady = (error) => {
        if (settled) return
        settled = true
        rejectReady(error)
      }
      let child
      try {
        child = spawn(SPEECH.python, [SPEECH.worker], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          // 必须显式传环境：worker 依赖 shim/ 与 pkgs/ 里的隔离依赖
          // （ComfyUI 的 site-packages 里没有 soundfile/pyworld 等）。
          // 不传的话 worker 一启动就 ImportError，而现象是「永远不出声」。
          env: {
            ...process.env,
            PYTHONPATH: SPEECH.pythonPath,
            HF_ENDPOINT: 'https://hf-mirror.com',
            PYTHONIOENCODING: 'utf-8',
          },
        })
      } catch (error) {
        failReady(error)
        return
      }
      worker.proc = child
      // stderr 必须持续排空。worker 把加载日志（transformers 报告、tqdm 进度）全写在这里，
      // 管道缓冲区约 64KB，一满 worker 就阻塞在写、我们阻塞在读 —— 双向死锁，现象是永远不出声。
      child.stderr.on('data', () => { /* 丢弃，但必须消费 */ })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        worker.buf += chunk
        let idx
        while ((idx = worker.buf.indexOf('\n')) >= 0) {
          const line = worker.buf.slice(0, idx).trim()
          worker.buf = worker.buf.slice(idx + 1)
          if (line.length === 0) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }   // 非协议行直接跳过
          if (msg.ready === true) { settled = true; resolveReady(msg); continue }
          const waiting = worker.resolver
          worker.resolver = null
          if (waiting !== null) waiting(msg)
        }
      })
      child.on('error', (error) => {
        worker.lastError = error.message
        worker.proc = null
        worker.ready = null
        failReady(error)
      })
      child.on('exit', (code) => {
        worker.proc = null
        worker.ready = null
        // 关键：启动阶段就退出时，也要让「等就绪」的那个 promise 落地。
        // 早先只通知了「等任务结果」的 resolver，于是启动失败会表现成永久卡住
        // （busy 一直是 true、既不出声也不报错），极难查。
        failReady(new Error(`语音工作进程启动即退出（code ${code ?? 'null'}）`))
        const waiting = worker.resolver
        worker.resolver = null
        if (waiting !== null) waiting({ ok: false, error: '语音工作进程已退出' })
      })
    })
    return worker.ready
  }

  async function speakViaWorker(text, outFile) {
    await ensureWorker()
    const proc = worker.proc
    if (proc === null) throw new Error('语音工作进程不可用')
    return new Promise((resolveDone, reject) => {
      const timer = setTimeout(() => {
        worker.resolver = null
        try { proc.kill() } catch { /* 已退出 */ }
        worker.proc = null
        worker.ready = null
        reject(new Error(`语音合成超时（${SPEECH.timeoutMs}ms）`))
      }, SPEECH.timeoutMs)
      worker.resolver = (msg) => {
        clearTimeout(timer)
        if (msg.ok === true && existsSync(outFile)) resolveDone(msg)
        else reject(new Error(msg.error ?? '语音合成失败（无原因）'))
      }
      proc.stdin.write(JSON.stringify({ text, out: outFile, steps: SPEECH.steps }) + '\n')
    })
  }

  /**
   * 插件停用时收工，别留下孤儿进程。
   *
   * 必须杀**整棵进程树**：worker.py 自己还起着常驻的 pwsh（SAPI），
   * 而 Windows 上 `kill()` 是 TerminateProcess —— 不跑任何清理，
   * 只杀 Python 的话那个 pwsh 就变孤儿了（实测攒出了两个）。
   */
  function stopWorker() {
    const proc = worker.proc
    worker.proc = null
    worker.ready = null
    worker.resolver = null
    if (proc === null || proc.pid === undefined) return
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      })
    } catch {
      try { proc.kill() } catch { /* 已退出 */ }
    }
  }

  // ── 主动说话（她自己开口）──────────────────────────────────────────────
  /**
   * 和 `live2d_express` 的区别：那个是 Agent 想说时才推（被动），
   * 这个是形象**自己**隔一阵子嘀咕一句（主动），而且内容要落在**具体任务**上 ——
   * 会话标题就是「某某任务」的来源。
   *
   * 三条硬规矩，少一条它就会变成话痨或复读机：
   *   1. 两次之间至少 `minGapMs`，再加随机抖动；
   *   2. 每小时不超过 `hourlyBudget` 条 —— 每条都是一次真实的模型调用；
   *   3. 刚有真实表达（live2d_express / 被戳）就让路，不抢话。
   *
   * 生成失败就**不说话**，不退回预设：页面自己那套碎碎念（`engine.js` 的
   * `MURMURS`）照旧跑着，那才是兜底。这条线必须是现场生成的，否则就退化成
   * 用户明确反对的「打表预设」。
   */
  const PROACTIVE = {
    mode: 'proactive',
    minGapMs: 90_000,          // 两次主动说话的最小间隔
    spanMs: 75_000,            // 叠加的随机跨度
    firstDelayMs: 25_000,      // 启动后先安静一会儿再开口
    hourlyBudget: 8,           // 每小时上限
    quietAfterExpressMs: 25_000, // 真实表达之后安静这么久
    tickMs: 10_000,            // 检查间隔
    maxTokens: 160,
  }
  const proactive = { timer: null, startedAt: 0, lastAt: 0, stamps: [], busy: false, spoken: 0, lastError: null }

  // ── 思维链 ──────────────────────────────────────────────────────────────
  /**
   * 「展示思维链里面的东西」—— 形象说的是模型**此刻真实的思考片段**，
   * 而不是另写一句概括。
   *
   * 来源是 `agent/assistant-stream` 的 `reasoning-delta` 分片：
   *
   *   'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent, frame })
   *   frame.type === 'chunk' → frame.chunk = { type: 'reasoning-delta', text }
   *
   * 这个事件同样是**按 agent 作用域派发**的，根级监听必须 `{ global: true }` ——
   * 和 `agent/status` 踩过的是同一个坑。
   *
   * 为什么只挑一句而不是整段贴出来：思维链又长又碎，还夹着工具参数和 URL。
   * 气泡只能放一句，所以按句切开、过滤掉不像人话的，再从靠后的几句里随机挑 ——
   * 靠后的更接近它当下的思路，加随机是为了别每次都挑到同一句。
   */
  const REASONING = {
    mode: 'reasoning',
    bufferLimit: 8000,   // 每个 agent 最多留这么多字符
    minChars: 12,        // 太短的不成句
    maxChars: 60,        // 太长塞不进气泡
    tailWindow: 4,       // 从最后 N 句里挑
  }
  /** agentId → 累积的思维链文本 */
  const reasoningBuf = new Map()
  const reasoningStat = {
    chunks: 0, chars: 0, spoken: 0, frames: 0, kinds: {},
    // 精炼失败计数：为 0 且 spoken 在涨，说明模型调用是通的。
    distillFailed: 0, lastError: null,
  }

  /** 从思维链里挑一句能读的。挑不到返回 null。 */
  function pickReasoningSentence(text) {
    if (typeof text !== 'string' || text.length === 0) return null
    // 切句：先按行，再按句末标点。
    // 英文句号只在「后面是空白或中文」时才当句末 —— 否则 `1.5`、`node.js`
    // 会被切断。实测踩过：`Let me run.思维链这次…` 因为不切 `.` 而粘成一句。
    // 顺手剥掉 Markdown 标记，气泡里出现 `**` 很难看。
    const parts = text
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[。！？；;])|(?<=[.!?])(?=\s|[\u4e00-\u9fff])/))
      .map((s) => s.replace(/[*_`~>#]/g, '').replace(/\s+/g, ' ').trim())
      // 去掉句子两端的引号：思维链里引用代码/输出时会带引号，
      // 整句读起来就变成代码而不是人话。
      .map((s) => s.replace(/^["'「『]+|["'」』]+$/g, '').trim())
      .filter((s) => s.length > 0)
    const usable = parts.filter((s) => {
      const n = [...s].length
      if (n < REASONING.minChars || n > REASONING.maxChars) return false
      if (/^[[{<]/.test(s)) return false            // JSON / 标签片段
      if (/https?:\/\/|www\./.test(s)) return false // 链接
      if (/^[a-zA-Z0-9_\-./\\]+$/.test(s)) return false // 纯标识符或路径
      // 引号与反引号基本只出现在「引用代码/输出」的句子里。
      // 实测踩过：挑出 `"block-start:reasoning": 2, ← 推理块出现了！` ——
      // 以 ！结尾所以通过了句末检查，但整句是代码。
      if (/["`]/.test(s)) return false
      if (/'/.test(s) && !/\w'\w/.test(s)) return false // 允许 don't 这类撇号
      if (/[":,]\s*$/.test(s)) return false         // 以 , : " 收尾 = 被截断的代码
      if (/\w\s*:\s*\w/.test(s) && !/[\u4e00-\u9fff]/.test(s)) return false // key: value
      return true
    })
    if (usable.length === 0) return null
    // 中文优先：思维链的语言不一定和用户一致（实测这条路由的推理是英文），
    // 但只要链里有中文句子就先用中文 —— 气泡挂在中文角色身上，英文会很突兀。
    // 全是英文时仍然照发：那是它真实的思考，不该因为语言就瞒着不说。
    const cjk = usable.filter((s) => /[\u4e00-\u9fff]/.test(s))
    const pool = cjk.length > 0 ? cjk : usable
    const tail = pool.slice(-REASONING.tailWindow)
    return tail[Math.floor(Math.random() * tail.length)]
  }

  /** 用思维链片段说话。说成就返回 true。 */
  /**
   * 把思维链**精炼**成一句内心想法 —— 而不是从里面截一段贴上去。
   *
   * 为什么要精炼：思维链是给自己推理用的草稿，里面有大量半成品、自我催促
   * （「让我看看」「OK」「Let me do it」）、代码、字段名、路径。
   * 直接截一句贴到气泡上，用户看到的是半句话甚至代码
   * （实测截到过 `"block-start:reasoning": 2, ← 推理块出现了！` 这种东西，
   * 也截到过我自己的循环复读）。所以改成「读懂之后再重新说一遍」。
   */
  async function distillReasoning(raw) {
    const agent = activeAgent()
    if (agent === null) return null
    const llm = ctx.get('llm')
    if (llm === undefined) return null

    const header = agent.session?.requestHeader?.()?.config
    const provider = header?.provider ?? agent.options?.provider
    const model = header?.model ?? agent.options?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return null

    const instruction = [
      '你在扮演一个桌面上的 Live2D 虚拟形象。下面是你刚才的思考草稿（可能很乱）。',
      '',
      '把它**精炼**成一句第一人称的内心想法 —— 读懂之后重新说一遍，不是摘抄原句。',
      '',
      '要求：',
      '- 25 字以内，口语化，像在心里嘀咕；',
      '- 只留最有信息量的那个念头：在纠结什么、发现了什么、下一步想干什么；',
      '- 丢掉自我催促（「让我看看」「OK」这类）、代码、路径、字段名、半句话；',
      '- 不要客套，不要「我会继续努力」这类空话；',
      '- 不要复述任务列表；',
      '- 只输出这一句话，不要引号，不要任何额外文字。',
      '',
      '思考草稿：',
      raw,
    ].join('\n')

    let text = ''
    try {
      const options = {
        provider,
        model,
        messages: [{
          id: `live2d-distill-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: instruction }],
          source: { kind: 'plugin', plugin: 'dsh-live2d-avatar' },
        }],
        maxTokens: REASONING.maxTokens,
        sessionId: agent.session.id,
      }
      for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          reasoningStat.distillFailed += 1
          reasoningStat.lastError = String(chunk.reason.error?.message ?? 'error-finish')
          return null
        }
      }
    } catch (error) {
      reasoningStat.distillFailed += 1
      reasoningStat.lastError = error instanceof Error ? error.message : String(error)
      return null
    }

    const line = sanitizeLine(text)
    if (line === null) reasoningStat.distillFailed += 1
    return line
  }

  /**
   * 模型输出清洗：去掉引号/换行/前缀，长度不合适就判为无效。
   * 生成模型经常不听话地加引号或写「这句话是：」，这里统一收拾掉。
   */
  function sanitizeLine(text) {
    if (typeof text !== 'string') return null
    let s = text.trim().split('\n')[0].trim()
    s = s.replace(/^["'「『]|["'」』]$/g, '').trim()
    s = s.replace(/^(这句话是|回答[:：]|输出[:：])\s*/u, '').trim()
    if (s.length < 4 || s.length > 60) return null
    return s
  }

  async function speakReasoning(agentId, now) {
    const raw = reasoningBuf.get(agentId)
    if (raw === undefined) return false
    // 精炼（一次模型调用），失败就静默跳过 —— 宁可不说，也不贴半句话上去。
    const line = await distillReasoning(raw)
    if (line === null) return false
    // 复读就跳过（不清缓冲：后面还有别的可用）
    if (state.message !== null && state.message.text === line) return false

    const emotion = proactiveEmotion(line)
    state.revision += 1
    state.message = {
      id: state.revision,
      text: line,
      emotion,
      emotionLabel: EMOTION_LABELS.get(emotion) ?? emotion,
      mode: REASONING.mode,
      sticky: false,
      at: now,
    }
    proactive.lastAt = now
    proactive.stamps.push(now)
    proactive.jitterMs = Math.floor(Math.random() * PROACTIVE.spanMs)
    reasoningStat.spoken += 1
    enqueueSpeech(state.message)
    return true
  }

  /** 取一个可用路由（provider/model）。没有活跃 Agent 时返回 null。 */
  function activeAgent() {
    const agents = ctx.get('agents')
    if (agents === undefined) return null
    try {
      const list = typeof agents.list === 'function' ? agents.list() : null
      if (!Array.isArray(list) || list.length === 0) return null
      // 优先正在跑的那个：它手上的任务最值得说
      return list.find((a) => a?.status === 'running') ?? list[0]
    } catch {
      return null
    }
  }

  /**
   * 会话标题 —— 「某某任务」的来源。
   *
   * `stateOf` 的返回形状在不同版本可能是裸值，也可能是 `{ ver, seq, val }`
   * （投影缓存里存的是后者），两种都认，认不出就当没有。
   */
  function sessionTitle(agent) {
    try {
      const projections = ctx.get('sessionProjections')
      const raw = projections?.stateOf?.(agent.session, 'title')
      if (typeof raw === 'string' && raw.length > 0) return raw
      if (raw !== null && typeof raw === 'object' && typeof raw.val === 'string' && raw.val.length > 0) return raw.val
    } catch { /* 投影不可用就当没有标题 */ }
    return null
  }

  /** 采集「现在 DSH 里在发生什么」，交给模型当事实依据。 */
  function proactiveFacts() {
    const agents = ctx.get('agents')
    let list = []
    try {
      const raw = typeof agents?.list === 'function' ? agents.list() : null
      if (Array.isArray(raw)) list = raw
    } catch { /* 取不到就报空 */ }

    const items = list.slice(0, 6).map((agent) => ({
      title: sessionTitle(agent),
      running: agent?.status === 'running',
    }))
    return {
      tasks: items,
      runningCount: items.filter((i) => i.running).length,
      lastSaid: state.message === null ? null : { text: state.message.text, mode: state.message.mode },
    }
  }

  /** 把事实渲染成提示词里的一段，尽量具体、可引用。 */
  function proactiveBrief(facts) {
    const lines = []
    if (facts.tasks.length === 0) {
      lines.push('现在 DSH 里没有任何会话。')
    } else {
      lines.push('现在 DSH 里有这些任务：')
      for (const t of facts.tasks) {
        const name = t.title === null ? '（一个还没起名字的任务）' : `「${t.title}」`
        lines.push(`- ${name}：${t.running ? '正在跑' : '闲着'}`)
      }
    }
    if (facts.lastSaid !== null) {
      lines.push(`你上一句说的是：「${facts.lastSaid.text}」（${facts.lastSaid.mode}）`)
    }
    return lines.join('\n')
  }

  /** 按语气挑表情。生成不出语气就中性，别让脸和话对不上。 */
  function proactiveEmotion(text) {
    if (/[？?]|难|卡|烦|糟糕|坏/.test(text)) return 'confused'
    if (/[！!]|太好了|终于|顺|搞定|不错/.test(text)) return 'happy'
    if (/累|困|唉|算了|不想/.test(text)) return 'gloomy'
    if (/担心|紧张|怕|不安/.test(text)) return 'nervous'
    return 'neutral'
  }

  // ── 任务完成后说话 ──────────────────────────────────────────────────────
  /**
   * 「任务完成后也要说话」。
   *
   * 触发点是 `agent/status` 的 running → idle 转变 —— 那意味着一个回合结束了。
   * 和「主动说话」的区别在于**时机由事件驱动**，不是等定时器：
   * 刚干完一件事正是最该有反应的时候，等 90 秒再说就凉了。
   *
   * 所以这里的闸门比主动说话宽松（`minGapMs` 小得多），但仍然：
   *   - 太短的回合不说（一句话的闲聊不值得感慨）；
   *   - 与上一次说话至少隔一会儿（避免刚说完又接一句）；
   *   - 共用同一份每小时预算，不会因为多了这条线就变话痨。
   */
  const COMPLETION = {
    mode: 'done',
    minTurnMs: 20_000,   // 回合短于这个时长就不说
    minGapMs: 8_000,     // 与上一次说话的最小间隔
    maxTokens: 160,
  }
  /** agentId → { startedAt } —— 用来算这一回合干了多久 */
  const turnState = new Map()
  const completionStat = { detected: 0, spoken: 0, skippedShort: 0 }

  /** 完成时该不该开口。比 proactiveDue 宽松，但共用预算。 */
  function completionDue(now) {
    if (proactive.busy) return false
    if (proactive.timer === null) return false
    if (proactive.lastAt !== 0 && now - proactive.lastAt < COMPLETION.minGapMs) return false
    proactive.stamps = proactive.stamps.filter((t) => now - t < 3_600_000)
    if (proactive.stamps.length >= PROACTIVE.hourlyBudget) return false
    return true
  }

  /** 刚干完一件事 —— 说一句。 */
  async function speakCompletion(agentId, durationMs) {
    const now = Date.now()
    if (!completionDue(now)) return
    const agents = ctx.get('agents')
    let agent = null
    try { agent = agents?.get?.(agentId) ?? null } catch { /* 拿不到就用活跃的 */ }
    const title = agent === null ? null : sessionTitle(agent)
    const minutes = Math.max(1, Math.round(durationMs / 60_000))

    proactive.busy = true
    let line = null
    try {
      line = await composeProactiveLine('completion', { title: title ?? '刚才那件事', minutes })
    } finally {
      proactive.busy = false
    }
    if (line === null) return
    if (state.message !== null && state.message.text === line.text) return

    const at = Date.now()
    state.revision += 1
    state.message = {
      id: state.revision,
      text: line.text.slice(0, 200),
      emotion: line.emotion,
      emotionLabel: EMOTION_LABELS.get(line.emotion) ?? line.emotion,
      mode: COMPLETION.mode,
      sticky: false,
      at,
    }
    proactive.lastAt = at
    proactive.stamps.push(at)
    proactive.jitterMs = Math.floor(Math.random() * PROACTIVE.spanMs)
    completionStat.spoken += 1
    enqueueSpeech(state.message)
  }

  /** 现在该不该开口。 */
  function proactiveDue(now) {    if (proactive.busy) return false
    if (proactive.timer === null) return false
    // 3. 让路：刚有真实表达就先安静
    if (state.message !== null && now - state.message.at < PROACTIVE.quietAfterExpressMs) return false
    // 启动后先安静一会儿：`lastAt === 0` 时不能直接放行，否则一重载就开腔
    if (proactive.lastAt === 0) return now - proactive.startedAt >= PROACTIVE.firstDelayMs
    // 1. 最小间隔 + 随机抖动
    const gap = PROACTIVE.minGapMs + (proactive.jitterMs ?? 0)
    if (now - proactive.lastAt < gap) return false
    // 2. 每小时预算
    proactive.stamps = proactive.stamps.filter((t) => now - t < 3_600_000)
    if (proactive.stamps.length >= PROACTIVE.hourlyBudget) return false
    return true
  }

  /**
   * 生成一句（不写 state）。
   *
   * 拆出来是为了让诊断端点能在**不打扰桌宠**的前提下按需触发一次，
   * 否则最小间隔 90 秒，没法验证标题解析和提示词质量。
   *
   * @returns `{ text, emotion, brief, provider, model }`；任何一步不成立都返回 null。
   */
  async function composeProactiveLine(kind = 'proactive', detail = null) {
    const agent = activeAgent()
    if (agent === null) return null
    const llm = ctx.get('llm')
    if (llm === undefined) return null

    const header = agent.session?.requestHeader?.()?.config
    const provider = header?.provider ?? agent.options?.provider
    const model = header?.model ?? agent.options?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return null

    const facts = proactiveFacts()
    const brief = proactiveBrief(facts)
    const instruction = kind === 'completion'
      ? [
        '你是一个 Live2D 虚拟形象。你刚帮用户干完一件事，现在停下手喘口气。',
        detail === null ? '' : `刚做完的是：「${detail.title}」，花了大约 ${detail.minutes} 分钟。`,
        brief,
        '',
        '请说一句第一人称、口语化的感想。要求：',
        '- 25 字以内，像真的松了口气、或者有点小得意，**不是汇报工作**；',
        '- 尽量点到刚做完那件事的名字；',
        '- 不要客套，不要「已完成任务」这种公文腔，不要复述上面的列表；',
        '- 不要和上一句重复。',
        '只输出这一句话，不要引号，不要任何额外文字。',
      ].join('\n')
      : [
        '你是一个 Live2D 虚拟形象，正在用户桌面上待机。你会时不时自己嘀咕一句。',
        brief,
        '',
        '请说一句第一人称、口语化的自言自语。要求：',
        '- 25 字以内，像真的在心里嘀咕，不是在汇报工作；',
        '- 如果上面有任务，尽量点到**具体那个任务的名字**，说说它做到哪了、难不难、你着不着急；',
        '- 不要客套，不要「我会继续努力」这类空话，不要复述上面的列表；',
        '- 不要和上一句重复。',
        '只输出这一句话，不要引号，不要任何额外文字。',
      ].join('\n')

    let text = ''
    try {
      const options = {
        provider,
        model,
        messages: [{
          id: `live2d-${kind}-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: instruction }],
          source: { kind: 'plugin', plugin: 'dsh-live2d-avatar' },
        }],
        maxTokens: PROACTIVE.maxTokens,
        sessionId: agent.session.id,
      }
      for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          proactive.lastError = String(chunk.reason.error?.message ?? 'error-finish')
          return null
        }
      }
    } catch (error) {
      proactive.lastError = error instanceof Error ? error.message : String(error)
      return null
    }

    const cleaned = text.replace(/^["「『]|["」』]$/g, '').replace(/\s+/g, ' ').trim()
    if (cleaned.length === 0) return null
    proactive.lastError = null
    return {
      text: cleaned,
      emotion: proactiveEmotion(cleaned),
      brief,
      facts,
      provider,
      model,
    }
  }

  /** 现场生成一句，成功就写进 state。失败保持沉默。 */
  async function proactiveSpeak() {
    proactive.busy = true
    let line = null
    try {
      line = await composeProactiveLine()
    } finally {
      proactive.busy = false
    }
    if (line === null) return
    // 和上一句雷同就丢掉，避免复读
    if (state.message !== null && state.message.text === line.text) return

    state.revision += 1
    state.message = {
      id: state.revision,
      text: line.text.slice(0, 200),
      emotion: line.emotion,
      emotionLabel: EMOTION_LABELS.get(line.emotion) ?? line.emotion,
      mode: PROACTIVE.mode,
      sticky: false,
      at: Date.now(),
    }
    proactive.lastAt = state.message.at
    proactive.stamps.push(state.message.at)
    proactive.spoken += 1
    proactive.jitterMs = Math.floor(Math.random() * PROACTIVE.spanMs)
    enqueueSpeech(state.message)
  }

  /**
   * 优先说思维链，没有可用的才退回「另写一句」。
   *
   * 用户要的是**思维链里的东西**，所以生成那条只是兜底 ——
   * 例如空闲很久、模型没有在思考时，总不能一直不说话。
   */
  async function speakBest() {
    const now = Date.now()
    if (!proactiveDue(now)) return
    // 1) 思维链优先（精炼成一句，不是摘抄）
    for (const agentId of reasoningBuf.keys()) {
      if (await speakReasoning(agentId, now)) return
    }
    // 2) 兜底：现场生成一句
    await proactiveSpeak()
  }

  // 采集思维链。agent 作用域事件 → 必须 global。
  ctx.on('agent/assistant-stream', (payload) => {
    const agent = payload?.agent
    const frame = payload?.frame
    if (agent === undefined || frame === undefined) return
    const id = String(agent.id)
    reasoningStat.frames += 1
    if (frame.type === 'chunk' && frame.chunk?.type !== undefined) {
      // block-start 要带上块类型 —— 「有没有推理块」和「有块但没增量」
      // 是两种完全不同的故障，只看 'block-start' 分不出来。
      const key = frame.chunk.type === 'block-start'
        ? `block-start:${String(frame.chunk.blockType)}`
        : frame.chunk.type
      reasoningStat.kinds[key] = (reasoningStat.kinds[key] ?? 0) + 1
    } else {
      reasoningStat.kinds[frame.type] = (reasoningStat.kinds[frame.type] ?? 0) + 1
    }
    if (frame.type === 'start') {
      // **不清空**缓冲：每一步开始都清一次的话，轮到定时器或步末要说话时
      // 缓冲往往正好是空的（实测 buffers=1 但 chunks=0 就是这个原因）。
      // 保留成滚动的最近思考，长度由 bufferLimit 兜住。
      if (!reasoningBuf.has(id)) reasoningBuf.set(id, '')
      return
    }
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        const prev = reasoningBuf.get(id) ?? ''
        const next = (prev + chunk.text).slice(-REASONING.bufferLimit)
        reasoningBuf.set(id, next)
        reasoningStat.chunks += 1
        reasoningStat.chars += chunk.text.length
      }
      return
    }
    if (frame.type === 'end') {
      // 一步结束：此刻的思维链最完整，尝试精炼一句
      const now = Date.now()
      if (proactiveDue(now)) {
        void speakReasoning(id, now).catch((error) => {
          reasoningStat.distillFailed += 1
          reasoningStat.lastError = error instanceof Error ? error.message : String(error)
        })
      }
    }
  }, { global: true })


  /** 诊断用：按需跑一次完整流程，但**不写 state**（不打扰桌宠）。 */
  async function probeProactive() {
    proactive.busy = true
    let line = null
    try {
      line = await composeProactiveLine()
    } finally {
      proactive.busy = false
    }
    if (line === null) {
      return { ok: false, error: proactive.lastError ?? 'no-line', ...proactiveFacts() }
    }
    return {
      ok: true,
      text: line.text,
      emotion: line.emotion,
      provider: line.provider,
      model: line.model,
      brief: line.brief,
      tasks: line.facts.tasks,
    }
  }

  /**
   * 启动主动说话的定时器。返回停止函数。
   *
   * 刻意用「定时轮询 + 闸门」而不是「一次性 setTimeout 链」：
   * 闸门要同时看预算、让路和随机间隔，轮询让这些条件每轮重新算，
   * 不会因为某次条件不满足就把整条链断掉。
   */
  function startProactive() {
    if (proactive.timer !== null) return () => {}
    proactive.startedAt = Date.now()
    proactive.jitterMs = Math.floor(Math.random() * PROACTIVE.spanMs)
    // 插件可能在回合中途加载：此刻已经在跑的 agent 补记一个开始时间，
    // 这样它结束时能算出（略微低估的）时长，而不是当成「没见过开头」。
    try {
      const agents = ctx.get('agents')
      const list = typeof agents?.list === 'function' ? agents.list() : null
      if (Array.isArray(list)) {
        const now = Date.now()
        for (const agent of list) {
          if (agent?.status === 'running' && agent?.id !== undefined) {
            turnState.set(String(agent.id), { startedAt: now })
          }
        }
      }
    } catch { /* 取不到就算了，idle 那侧还有兜底 */ }
    proactive.timer = setInterval(() => {
      const now = Date.now()
      if (!proactiveDue(now)) return
      void speakBest().catch((error) => {
        proactive.lastError = error instanceof Error ? error.message : String(error)
      })
    }, PROACTIVE.tickMs)
    // 定时器不该拖住进程退出
    if (typeof proactive.timer.unref === 'function') proactive.timer.unref()
    return () => {
      if (proactive.timer !== null) clearInterval(proactive.timer)
      proactive.timer = null
    }
  }

  // ── 桌面桌宠 ────────────────────────────────────────────────────────────
  /**
   * 拉起桌面桌宠。
   *
   * 桌宠是独立进程，网页无法唤起它 —— 所以「DSH 开着时桌面上一直有它」这件事
   * 只能由 Host 在启动时做。进程与 Host 解绑（unref），所以 DSH 退出后它也不会
   * 变成僵尸：外壳自己有 5 秒心跳，探到 DSH 离线就自己退场。
   */
  const petStatus = { mode: 'off', state: 'idle', pid: null, detail: '' }

  function launchPet() {
    const setting = config?.desktopPet ?? 'auto'
    if (setting === 'off' || setting === false) {
      petStatus.mode = 'off'
      petStatus.detail = '配置为 off，不拉起'
      return
    }
    const script = join(HERE, PET_SCRIPT)
    if (!existsSync(script)) {
      petStatus.state = 'failed'
      petStatus.detail = `找不到 ${script}`
      console.warn(`[dsh-live2d] 桌宠未启动：${petStatus.detail}`)
      return
    }
    const pwsh = findPwsh()
    if (pwsh === null) {
      petStatus.state = 'failed'
      petStatus.detail = '找不到 pwsh 的绝对路径（PowerShell 7）'
      console.warn(`[dsh-live2d] 桌宠未启动：${petStatus.detail}。安装： winget install Microsoft.PowerShell`)
      return
    }
    petStatus.mode = setting === true || setting === 'on' ? 'on' : 'auto'
    // 端口要如实取：webServer 可能监听 0（由系统分配），此时用实际绑定值。
    // 拿不到就退回 3080，并把这件事记进 detail，别静默猜。
    const port = ctx.webServer.port
    const usablePort = Number.isInteger(port) && port > 0 ? port : 3080
    if (usablePort !== port) petStatus.detail = `webServer.port=${String(port)}，改用 ${usablePort}`
    try {
      // 子进程输出写到日志文件，而不是丢进 'ignore'。
      // 之前用 stdio:'ignore' 时，桌宠静默退出、我完全看不到原因 ——
      // 一个连失败都不留痕的守护进程等于没有。
      const logPath = join(tmpdir(), 'dsh-live2d-pet-launch.log')
      let logFd = null
      try {
        logFd = openSync(logPath, 'a')
        writeSync(logFd, `\n--- ${new Date().toISOString()} launch url=http://127.0.0.1:${usablePort} pwsh=${pwsh} ---\n`)
      } catch { logFd = null }
      const child = spawn(pwsh, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-Url', `http://127.0.0.1:${usablePort}`,
      ], {
        // 刻意 **不** detached。Windows 上 detached + stdio:'ignore' 会让 pwsh
        // 完全不执行就报 exit 0（实测三条 detached 配置全部如此，非 detached 三条全成功）。
        // 桌宠不是靠 detached 存活的：它由 WebView2 消息循环自己撑着，
        // 且外壳有 5 秒心跳，DSH 一停就自行退场，不需要父进程托管。
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
        windowsHide: true,
      })
      // 父进程这边的副本可以关掉了：子进程持有自己的句柄。
      if (logFd !== null) { try { closeSync(logFd) } catch { /* 已关 */ } }
      petStatus.log = logPath
      child.on('error', (error) => {
        petStatus.state = 'failed'
        petStatus.detail = `拉起失败：${error.message}`
        console.warn(`[dsh-live2d] 桌宠${petStatus.detail}`)
      })
      child.on('exit', (code) => {
        // 外壳自己退场（用户 Esc / DSH 离线）后不再重生 —— 尊重用户的关闭动作。
        if (petStatus.state === 'running') {
          petStatus.state = 'exited'
          petStatus.detail = `桌宠已退出（code ${code ?? 'null'}）`
        }
      })
      petStatus.state = 'running'
      petStatus.pid = child.pid ?? null
      // 不 unref：非 detached 的子进程需要父进程的事件循环保持引用才稳定存活。
      // 代价是 DSH 退出时子进程可能被带走 —— 这正是我们要的语义：
      // 「只有 DSH 开着才醒」。桌宠那边的心跳是第二道保险。
      console.log(`[dsh-live2d] 已拉起桌宠（pid ${petStatus.pid}）`)
    } catch (error) {
      petStatus.state = 'failed'
      petStatus.detail = `拉起异常：${error instanceof Error ? error.message : String(error)}`
      console.warn(`[dsh-live2d] 桌宠${petStatus.detail}`)
    }
  }

  /**
   * 插件停用时收掉自己拉起的桌宠。
   *
   * 原先这里**故意不杀**，理由是「它有心跳，DSH 一停就自行退场」。那话只对
   * 「DSH 整个退出」成立 —— 那时这段代码根本不会执行。插件重载时 DSH 还活着，
   * 心跳当然不会触发，于是老桌宠留在屏幕上，新的 `apply()` 又拉起一只，
   * 结果就是两个窗口叠在一起（实测重载两次攒出 pid 24160 + 4188 两个）。
   *
   * 语义应该是：谁拉起的谁负责收。DSH 整个退出时子进程被带走 + 心跳兜底，
   * 那是另一条路，不归这里管。
   */
  function stopPet() {
    const pid = petStatus.pid
    const state = petStatus.state
    petStatus.pid = null
    if (state !== 'running' || typeof pid !== 'number') return
    // 先确认这个 pid 还是我们的桌宠：pid 会被系统回收给别人，
    // 盲杀就可能杀掉无辜进程。
    let owned = false
    const queryPwsh = findPwsh()
    if (queryPwsh !== null) {
      try {
        const out = execFileSync(queryPwsh, [
          '-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ], { encoding: 'utf8', timeout: 5000, windowsHide: true })
        owned = typeof out === 'string' && out.includes('dsh-pet.ps1')
      } catch {
        // 查不出来（进程已退、或 pwsh 不可用）→ 不冒杀错的风险
        owned = false
      }
    }
    if (!owned) {
      petStatus.state = 'exited'
      petStatus.detail = '插件已停用；桌宠进程已不在（或 pid 已被回收，不盲杀）'
      return
    }
    // 杀整棵树：桌宠自己会起 msedgewebview2 的子进程，只杀 pwsh 会留下它们。
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      })
      petStatus.state = 'exited'
      petStatus.detail = `插件已停用，已收掉桌宠（pid ${pid}）`
    } catch {
      petStatus.state = 'exited'
      petStatus.detail = `插件已停用，收桌宠失败（pid ${pid}）`
    }
  }

  ctx.effect(() => {
    launchPet()
    return () => {
      // 谁拉起的谁负责收 —— 否则插件每次重载都会在屏幕上多叠一只。
      stopPet()
      // 语音工作进程也必须收掉：它没有心跳，会一直占着几百 MB 内存当孤儿。
      stopWorker()
    }
  }, 'dsh-live2d: desktop pet')

  // 主动说话：桌宠开着才有意义 —— 没有窗口时说话也没人看得见。
  // 配置成 off 就不启动，省掉那些模型调用。
  ctx.effect(() => {
    const setting = config?.desktopPet ?? 'auto'
    if (setting === 'off' || setting === false) return () => {}
    return startProactive()
  }, 'dsh-live2d: proactive speech')

  // 状态判定：**直接查 agents 服务**，不依赖事件。
  //
  // 我试过两条事件路线都不通：
  //   1. `payload.agent.session.id` —— 真实 payload 是 `{ agent, status }`，取错了层；
  //   2. 改成 `payload.agent.id` 并加 `{ global: true }` 后，根级监听**仍然收不到**
  //      （agent/status 是按 agent 作用域派发的）。
  // 与其继续和派发规则纠缠，不如改成拉取式：Agent 自己有 `status` getter，
  // 每次读状态时现问一遍。既准确又不依赖任何事件语义。
  //
  // 事件监听仍然保留（若将来作用域行为变化，它能提供更快的更新），
  // 但快照结果以**查询**为准。
  const running = new Set()

  /**
   * 现问一遍：此刻有任何一个 Agent 在跑吗？
   *
   * 用 `list()`（全部活跃 Agent）而不是 `roots()`（仅顶层）。
   * 实测这两者结果不同：诊断显示 `list()` 有 2 个 running，而按 `roots()` 判定
   * 得到的是 idle —— 这正是「状态永远待机」的最后一层原因。
   */
  function anyAgentRunning() {
    const agents = ctx.get('agents')
    if (agents === undefined) return null
    try {
      const list = typeof agents.list === 'function' ? agents.list() : null
      if (!Array.isArray(list)) return null
      return list.some((agent) => agent?.status === 'running')
    } catch {
      return null
    }
  }

  ctx.on('agent/status', (payload) => {
    const id = payload?.agent?.id
    if (id === undefined) return
    const key = String(id)
    if (payload.status === 'running') {
      running.add(key)
      // 记下这一回合是什么时候开始的，完成时用它算「干了多久」
      const prev = turnState.get(key)
      if (prev?.startedAt === undefined) turnState.set(key, { startedAt: Date.now() })
    } else {
      running.delete(key)
      // running → idle：一个回合结束了。
      //
      // 时长取不到时按「刚好够格」处理，而不是直接跳过：
      // 插件可能在回合中途才加载，那时 `running` 事件早已过去 ——
      // 实测就是这样漏掉了整回合（detected 一直是 0）。
      // 一个已经结束的回合就是发生过的事，不该因为没看到开头就装作没有。
      const startedAt = turnState.get(key)?.startedAt
      turnState.set(key, { startedAt: undefined })
      const duration = startedAt === undefined ? COMPLETION.minTurnMs : Date.now() - startedAt
      completionStat.detected += 1
      // 回合结束 = 任务完成 → 状态灯转绿（限时，见 STATUS.doneHoldMs）。
      // 放在时长判断**之前**：哪怕这个回合太短不值得说话，「做完了」这件事也该被看见。
      markDone()
      if (duration >= COMPLETION.minTurnMs) {
        void speakCompletion(key, duration).catch((error) => {
          proactive.lastError = error instanceof Error ? error.message : String(error)
        })
      } else {
        completionStat.skippedShort += 1
      }
    }
  }, { global: true })
  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (id !== undefined) {
      running.delete(String(id))
      turnState.delete(String(id))
    }
  }, { global: true })

  // ── 状态：等你操作 / 刚完成 ────────────────────────────────────────────
  /**
   * 除了「思考中 / 待机」，还有两个更该被看见的时刻：
   *   waiting —— 权限申请、问卷。这时 Agent 卡在等人，用户不点就永远不动。
   *   done    —— 任务刚完成。用户最想知道的就是「好了没」。
   *
   * done 是**限时**的：亮一小会儿就回到 idle，否则会一直绿着，反而失去信息量。
   */
  const STATUS = {
    doneHoldMs: Number.isFinite(config?.doneHoldMs) ? config.doneHoldMs : 30_000,
  }
  const statusPhase = {
    waiting: 0, doneAt: 0,
    // 可观测性：黄灯平时很难碰巧看到，必须能查出「事件到底有没有来」
    approvalsSeen: 0, lastApprovalAt: 0, waitErrors: [],
    // 兜底回收计数：tools/result 没来的话黄灯靠这个自愈，不为 0 就说明漏了
    askStale: 0,
    // 真机证据：preExecuteSeen 不涨 = tools/pre-execute 根本没派发到根监听，
    // 那黄灯就只能靠 approval/request 那条路，得换方案。
    preExecuteSeen: 0, kindsSeen: {},
  }

  /** 进入「等你操作」。用计数而不是布尔：并发的多个申请不能互相抵消。 */
  function enterWaiting() { statusPhase.waiting += 1 }
  function leaveWaiting() { statusPhase.waiting = Math.max(0, statusPhase.waiting - 1) }
  function markDone() { statusPhase.doneAt = Date.now() }

  function statusSnapshot() {
    // 优先级：等你操作 > 正在干活 > 刚完成 > 待机。
    //
    // 「正在干活」必须高于「刚完成」：done 会亮 30 秒，如果这期间又开了新任务，
    // 绿灯还压着蓝灯就成了误导（实测被测试抓出来）。
    if (statusPhase.waiting > 0) return 'waiting'
    const live = anyAgentRunning()
    const running_ = live !== null ? live : running.size > 0
    if (running_) {
      // 重新开工就清掉 done —— 否则它会在 30 秒窗口里阴魂不散
      statusPhase.doneAt = 0
      return 'thinking'
    }
    if (statusPhase.doneAt > 0 && Date.now() - statusPhase.doneAt < STATUS.doneHoldMs) return 'done'
    return 'idle'
  }

  // ── 状态也要出声 ────────────────────────────────────────────────────────
  /**
   * 状态是每 900ms 算一次的标签，直接照念会没完没了（idle↔thinking 一天能翻几百次）。
   * 所以：只在**真的变化**时说，且两次之间至少隔 STATUS_SPEECH.minGapMs。
   */
  const STATUS_SPEECH = {
    minGapMs: Number.isFinite(config?.statusSpeechMinGapMs) ? config.statusSpeechMinGapMs : 25_000,
    lines: {
      thinking: ['我开始干活了。', '嗯，动起来了。', '有活了，忙起来。'],
      idle: ['我这边闲下来了。', '暂时没事做了。', '歇一会儿。'],
    },
  }
  const statusSpeech = { last: null, lastAt: 0, spoken: 0, skippedGap: 0 }

  function maybeSpeakStatus(status) {
    if (!SPEECH.enabled) return
    if (status === statusSpeech.last) return
    const previous = statusSpeech.last
    statusSpeech.last = status
    if (previous === null) return                       // 首次只是记录，别一开机就说话
    const now = Date.now()
    if (now - statusSpeech.lastAt < STATUS_SPEECH.minGapMs) {
      statusSpeech.skippedGap += 1                      // 被节流挡下，可观测
      return
    }
    const pool = STATUS_SPEECH.lines[status]
    if (pool === undefined) return
    statusSpeech.lastAt = now
    statusSpeech.spoken += 1
    const text = pool[Math.floor(Math.random() * pool.length)]
    enqueueSpeech({ id: `status-${now}`, text, mode: 'status', emotion: 'neutral', at: now }, true)
  }

  /** 每次被页面轮询时看一眼状态，需要的话让它出声。 */
  function noteStatusForSpeech(status) {
    try { maybeSpeakStatus(status) } catch { /* 状态语音失败不该影响状态查询 */ }
  }

  function stateSnapshot() {
    // 诊断字段：把「插件看到了什么」如实带出来，免得只能靠猜。
    // 这条曾经直接指出问题：agents 里明明有 running，status 却是 idle ——
    // 说明查询函数没被真正执行（后来查出是两个同名函数后者覆盖前者）。
    // 只报计数与运行数，不带 session id（这个接口虽然只在回环地址，也不该外泄标识）。
    let debug
    try {
      const agents = ctx.get('agents')
      const list = agents === undefined ? null : (typeof agents.list === 'function' ? agents.list() : null)
      debug = {
        hasAgents: agents !== undefined,
        agentCount: Array.isArray(list) ? list.length : null,
        runningCount: Array.isArray(list) ? list.filter(a => a?.status === 'running').length : null,
        eventRunningCount: running.size,
        // 主动说话的可观测状态：不暴露内容，只报节奏与最近一次失败原因。
        proactive: {
          enabled: proactive.timer !== null,
          spoken: proactive.spoken,
          lastAt: proactive.lastAt === 0 ? null : proactive.lastAt,
          budgetUsed: proactive.stamps.length,
          lastError: proactive.lastError,
        },
        // 思维链采集状态：chunks 一直为 0 说明该路由没有 reasoning 输出
        reasoning: {
          buffers: reasoningBuf.size,
          chunks: reasoningStat.chunks,
          chars: reasoningStat.chars,
          spoken: reasoningStat.spoken,
          frames: reasoningStat.frames,
          kinds: reasoningStat.kinds,
          // 精炼失败计数：spoken 不涨而 distillFailed 在涨，说明模型调用有问题
          distillFailed: reasoningStat.distillFailed,
          lastError: reasoningStat.lastError,
        },
        // 任务完成说话的统计：detected 有值而 spoken 一直是 0，
        // 说明回合都没到 minTurnMs（或者生成失败）。
        completion: {
          detected: completionStat.detected,
          spoken: completionStat.spoken,
          skippedShort: completionStat.skippedShort,
          tracking: turnState.size,
        },
        // 语音：busy 一直是 true 说明合成卡住；failed 持续增长看 lastError。
        speech: {
          enabled: SPEECH.enabled,
          busy: speech.busy,
          pending: speech.pending !== null,
          spoken: speech.spoken,
          failed: speech.failed,
          dropped: speech.dropped,
          lastError: speech.lastError,
          // 页面回执：ok=false 且 detail 提到 autoplay/gesture，就是自动播放策略拦住了
          playback: speech.playback ?? null,
          // 开了语音但 missing 非空，就是配置没齐 —— 直接照这个清单补
          dir: SPEECH.dir,
          missing: speechMissing(),
        },
        // 状态语音：状态翻转才触发，且被节流。spoken=0 且 skippedGap 在涨，
        // 说明状态确实在翻，只是被 minGapMs 挡下了（这是预期行为，不是坏了）。
        statusSpeech: {
          current: statusSpeech.last,
          spoken: statusSpeech.spoken,
          skippedGap: statusSpeech.skippedGap,
          minGapMs: STATUS_SPEECH.minGapMs,
        },
        // 黄灯的可观测性：approvalsSeen 一直是 0 就说明审批事件根本没到我这儿
        // （而不是「到了但没点亮」）—— 这两种故障的修法完全不同。
        phase: {
          waiting: statusPhase.waiting,
          doneAt: statusPhase.doneAt === 0 ? null : statusPhase.doneAt,
          approvalsSeen: statusPhase.approvalsSeen,
          lastApprovalAt: statusPhase.lastApprovalAt === 0 ? null : statusPhase.lastApprovalAt,
          waitErrors: statusPhase.waitErrors.slice(-3),
          askStale: statusPhase.askStale,
          pendingAsks: pendingAsks.size,
          preExecuteSeen: statusPhase.preExecuteSeen,
          kindsSeen: { ...statusPhase.kindsSeen },
        },
      }
    } catch (error) {
      debug = { error: error instanceof Error ? error.message : String(error) }
    }
    return {
      revision: state.revision,
      status: statusSnapshot(),
      message: state.message,
      updatedAt: state.message === null ? null : state.message.at,
      // 页面靠 audio.id 变化触发播放；没有音频时为 null。
      audio: state.audio ?? null,
      debug,
    }
  }

  // 需要用户操作的两种情形。都是 waterfall —— 我们只旁观，不改变决策，
  // 但必须把 next() 的 promise 原样返回，否则会把整条审批链掐断。
  //
  // `global: true` 是因为这两个事件是 agent 作用域的。
  // `prepend: true` 是**必须的**：waterfall 的实现是
  //     const next = () => (cbs.shift() ?? inner)(...args)
  // 前面的监听器不调 next() 就返回的话，后面的监听器**根本不会被调用**。
  // 而 `approval/request` 的第一个回答者（远程转发到浏览器那个）就是直接
  // return 自己的结果的 —— 不 prepend 就永远轮不到我。
  for (const eventName of ['approval/request', 'user-questions/request']) {
    ctx.on(eventName, async (...args) => {
      const next = args[args.length - 1]
      statusPhase.approvalsSeen += 1
      statusPhase.lastApprovalAt = Date.now()
      if (typeof next !== 'function') {
        // 形状不对就说出来 —— 静默失败的话现象只是「黄灯不亮」，查不出原因
        statusPhase.waitErrors.push(`${eventName}: next 不是函数（收到 ${args.length} 个参数）`)
        return undefined
      }
      enterWaiting()
      try {
        return await next()
      } catch (error) {
        statusPhase.waitErrors.push(`${eventName}: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      } finally {
        leaveWaiting()
      }
    }, { global: true, prepend: true })
  }


  // ── 「等你操作」的第二个信号源 ──────────────────────────────────────────
  /**
   * 真实场景里弹审批的是 **auto-review**（`@deepseek-ai/dsh-experimental-auto-review`）。
   * 它的注释写得很明白：「Install the Auto preset and its **prepended** per-call
   * review gate」，源码里 `askUser()` 返回的就是 `{ kind: 'ask', reason, displayReason }`。
   *
   * 也就是说它 **prepend** 了，跑在所有普通监听器前面，而且**不调 next() 就返回**。
   * 而 waterfall 的实现是：
   *     const next = () => (cbs.shift() ?? inner)(...args)
   * —— 前面的人不调 next()，后面的人根本不会被调用。所以「先返回 ask 的那个人」
   * 会把整条链截断，我这边的监听器**永远收不到那个 ask**。
   *
   * 实测数据佐证：`kindsSeen` 攒到 `{"allow":141}`，141 次真实调用**一次 ask 都没有**，
   * 而用户明明看到了审批弹窗。
   *
   * 所以这里也必须 `prepend: true`，把自己排到 auto-review 前面，
   * 先调 next() 把决策链走完，再回看它返回了什么。
   *
   * 进场时机是 `gate.kind === 'ask'`（此刻用户马上要看到弹窗），
   * 出场靠 `tools/result`（签名 (exec, result)，被拒的调用也会走到这里）。
   */
  const pendingAsks = new Map()

  // 兜底：万一某次调用的 tools/result 没来，黄灯不能永久卡住。
  const ASK_STALE_MS = 5 * 60_000
  const reapStaleAsks = (now) => {
    for (const [key, at] of pendingAsks) {
      if (now - at <= ASK_STALE_MS) continue
      pendingAsks.delete(key)
      leaveWaiting()
      statusPhase.askStale += 1
    }
  }

  /**
   * `tools/pre-execute` 的监听器：决策是 `{ kind: 'allow' | 'ask' | 'deny' | 'cancel' }`，
   * 源码里写死的是 `gate.kind === 'ask'`。只认精确相等，不认「包含 ask」，
   * 免得把别的词（比如某个叫 task 的 kind）误当成审批。
   */
  async function preExecuteAsk(exec, next) {
    const decision = await next()
    // 计数放在最前面：探针是直接调这个函数的，绕过事件系统，
    // 所以只有真机调用才会推高这两个数 —— 它们才能回答
    // 「事件到底有没有派发到我的监听器上」。
    statusPhase.preExecuteSeen += 1
    const kind = decision?.kind
    if (typeof kind === 'string') {
      statusPhase.kindsSeen[kind] = (statusPhase.kindsSeen[kind] ?? 0) + 1
    }
    if (kind === 'ask') {
      // 真正的关联键是 callId（`const { name: toolName, callId } = exec`）。
      const key = exec?.callId ?? `ask-${Date.now()}`
      if (!pendingAsks.has(key)) {
        pendingAsks.set(key, Date.now())
        statusPhase.approvalsSeen += 1
        statusPhase.lastApprovalAt = Date.now()
        enterWaiting()
      }
    }
    return decision
  }

  // 留一个 disposer：下面的排序探针要把它重新注册一遍，好模拟线上顺序。
  let preExecuteDisposer = ctx.on('tools/pre-execute', preExecuteAsk, { global: true, prepend: true })

  // 工具跑完 = 用户已经点过了 → 黄灯熄灭。被拒/被取消的调用同样会走到这里。
  const onToolResult = (exec) => {
    const key = exec?.callId
    if (key !== undefined && pendingAsks.has(key)) {
      pendingAsks.delete(key)
      leaveWaiting()
    }
  }
  ctx.on('tools/result', onToolResult, { global: true })

  // 探针用：跑的是上面这两个**真身**，不是另写一份模拟逻辑 ——
  // 否则探针绿了也不能说明线上这条链是通的。
  const askProbe = {
    fire: (callId, decision = { kind: 'ask' }) =>
      preExecuteAsk({ callId, name: 'probe' }, () => Promise.resolve(decision)),
    settle: (callId) => onToolResult({ callId, name: 'probe' }),

    /**
     * 走**真实事件总线**验证 prepend 排序，而不是直接调函数。
     *
     * 造一个和 auto-review 一样的监听器：prepend + 不调 next() 就返回 ask。
     * waterfall 是 `(cbs.shift() ?? inner)(...args)`，所以它会截断后面所有人。
     *
     * `mineAhead` 控制我排它前面还是后面：
     *   true  → 我 prepend 在后注册 → unshift 到最前 → 我先跑、调 next() → 我看到 ask ✓
     *   false → 它 prepend 在后注册 → 它先跑、直接返回 → 我被跳过 ✗
     * 这两种顺序都要能复现，否则「修好了」和「碰巧」分不清。
     */
    async ordering(mineAhead) {
      const sim = ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'ask' }),
        { global: true, prepend: true })
      preExecuteDisposer()
      if (mineAhead) {
        // 后注册 = unshift 到最前 = 等同线上的顺序（插件比 auto-review 晚加载）
        preExecuteDisposer = ctx.on('tools/pre-execute', preExecuteAsk, { global: true, prepend: true })
      }
      const seenBefore = statusPhase.preExecuteSeen
      const callId = `sim-${mineAhead ? 'ahead' : 'behind'}-${Date.now()}`
      try {
        await ctx.waterfall(ctx, 'tools/pre-execute',
          { callId, name: 'sim' },
          () => Promise.resolve({ kind: 'allow' }))
      } catch { /* 探针不该把错误吞掉，但也不该让路由 500 */ }
      const observed = statusPhase.preExecuteSeen > seenBefore
      // 复原：先收掉 sim，再把我的监听器放回去（保持线上那份配置）
      sim()
      if (!mineAhead) {
        preExecuteDisposer()
        preExecuteDisposer = ctx.on('tools/pre-execute', preExecuteAsk, { global: true, prepend: true })
      }
      // 探针自己造的 ask 要自己收尾 —— 否则会在 pendingAsks 里留一笔，
      // 黄灯亮着不灭，看起来跟真出了 bug 一模一样（上一版就留过）。
      onToolResult({ callId, name: 'sim' })
      return { observed }
    },

    /**
     * 备用路：审批服务派发 `approval/request` 时，我的监听器到底收不收得到。
     *
     * 这条是**排序无关的兜底** —— 不管是谁返回的 ask，只要它走 serviceAsk，
     * 就一定会经过审批服务的 `ctx.waterfall(..., 'approval/request', ...)`。
     * 这里用真实总线派一次，看 `approvalsSeen` 涨不涨。
     */
    async approvalPath() {
      const seenBefore = statusPhase.approvalsSeen
      try {
        await ctx.waterfall(ctx, 'approval/request', { kind: 'probe' },
          () => Promise.resolve('unavailable'))
      } catch { /* 探针不该让路由 500 */ }
      return { observed: statusPhase.approvalsSeen > seenBefore }
    },
  }


  /**
   * 让模型为「被戳了一下」这个瞬间现场生成一句话。
   *
   * 为什么不用预设词条：预设是死的，点第二次就会重复，而且和 Agent 当前在做的事
   * 毫无关系。这里把「它现在正在做什么」作为上下文交给模型，让它就着眼前这件事说。
   *
   * 拿最近一条真实表达当作「它此刻在想什么」的线索 —— 那是 Agent 自己最近推的，
   * 比任何猜测都准。生成失败时返回 null，由调用方退回一句简短的状态话，
   * 绝不让点击变成没反应。
   *
   * @param agent - 当前活跃的 Agent，用来取模型路由与最近的表达。
   * @param signal - 取消信号（客户端断开时中止）。
   * @returns 生成的一句话与表情；无法生成时 null。
   */
  async function generateReaction(agent, signal) {
    const llm = ctx.get('llm')
    if (llm === undefined) return null
    const latest = agent.session.requestHeader?.()?.config
    const provider = latest?.provider ?? agent.options?.provider
    const model = latest?.model ?? agent.options?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return null

    const recent = state.message
    const context = recent === null
      ? '你此刻没有正在说的话。'
      : `你最近一次说出口的是：「${recent.text}」（${recent.mode}）。`

    const instruction = [
      '你是一个 Live2D 虚拟形象，刚刚被人用鼠标戳了一下。',
      context,
      '请就着这一下，用第一人称说一句话作为即时反应。',
      '要求：口语、简短（30 字以内）、有真实情绪；可以是惊讶、抗议、害羞、敷衍、走神、回神。',
      '不要客套、不要解释你在做什么、不要复述上面那句话、不要提到「被戳」这个动作本身超过一次。',
      '只输出这一句话，不要引号、不要任何额外文字。',
    ].join('\n')

    const messages = [{
      id: `live2d-poke-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'plugin', plugin: 'dsh-live2d-avatar' },
    }]

    let text = ''
    try {
      const options = {
        provider,
        model,
        messages,
        maxTokens: 120,
        sessionId: agent.session.id,
        ...(signal === undefined ? {} : { signal }),
      }
      for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') continue
        else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') return null
      }
    } catch (error) {
      console.warn('[dsh-live2d] 生成点击反应失败：', error instanceof Error ? error.message : error)
      return null
    }

    const cleaned = text.replace(/^["「『]|["」』]$/g, '').replace(/\s+/g, ' ').trim()
    if (cleaned.length === 0) return null
    return cleaned.slice(0, 120)
  }

  /** 挑一个与语气相配的表情。生成失败时用中性的，别让脸和话对不上。 */
  function reactionEmotion(text) {
    if (/[？！!]|吓|惊/.test(text)) return 'shocked'
    if (/别|不要|烦|讨厌/.test(text)) return 'angry'
    if (/嘿|嘻嘻|才|嘛/.test(text)) return 'playful'
    if (/害羞|脸红|不好意思/.test(text)) return 'shy'
    if (/困|累|懒得|唉/.test(text)) return 'gloomy'
    return 'happy'
  }

  // ── HTTP 路由 ───────────────────────────────────────────────────────────
  async function handleRoute(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return sendJson(res, 400, { error: 'malformed percent-encoding in path' })
    }

    if (pathname === '/live2d/state') {
      // 页面每几百毫秒来一次，正好当兜底回收的时钟用，不用额外开定时器。
      reapStaleAsks(Date.now())
      const snap = stateSnapshot()
      noteStatusForSpeech(snap.status)
      return sendJson(res, 200, snap)
    }

    // 语音 wav。只允许读 speechDir 下的文件，且名字必须是纯文件名 ——
    // 不做这个检查的话 `../` 就能读到任意路径（前缀路由没有鉴权中间件）。
    if (pathname.startsWith('/live2d/audio/')) {
      const name = decodeURIComponent(pathname.slice('/live2d/audio/'.length))
      if (name.length === 0 || name !== basename(name) || !name.endsWith('.wav')) {
        return sendJson(res, 400, { error: 'bad audio name' })
      }
      const file = join(speechDir(), name)
      if (!existsSync(file)) return sendJson(res, 404, { error: 'no such audio' })
      return sendFile(res, file, 'no-store')
    }

    // 诊断：强制切到某个状态，验证四盏灯的颜色/文案。
    // 绿（完成）只在回合结束瞬间亮、黄（等你操作）要真有人申请权限才亮 ——
    // 没有这个端点就只能靠「等」去碰，等于不可验证。
    if (pathname === '/live2d/probe-status') {
      const url = new URL(req.url, 'http://localhost')
      const want = url.searchParams.get('set')
      if (want === 'waiting') statusPhase.waiting += 1
      else if (want === 'unwaiting') statusPhase.waiting = 0
      else if (want === 'done') statusPhase.doneAt = Date.now()
      else if (want === 'clear') { statusPhase.waiting = 0; statusPhase.doneAt = 0 }
      // 走真正的 tools/pre-execute + tools/result 监听器，验证「审批 → 黄灯」
      // 这条链在真机事件形状下是通的（不是直接改状态糊弄过去）。
      else if (want === 'ask') await askProbe.fire(url.searchParams.get('callId') ?? 'probe-ask')
      else if (want === 'ask-settle') askProbe.settle(url.searchParams.get('callId') ?? 'probe-ask')
      // next() 返回 allow，不该亮灯 —— 反向用例，防止「任何工具调用都变黄」
      else if (want === 'ask-allow') await askProbe.fire('probe-allow', { kind: 'allow' })
      // 走真实事件总线验证 prepend 排序（见 askProbe.ordering 的注释）
      else if (want === 'order-ahead') await askProbe.ordering(true)
      else if (want === 'order-behind') await askProbe.ordering(false)
      // 备用路：approval/request 是否真的能派发到我的监听器上
      else if (want === 'order-approval') await askProbe.approvalPath()
      return sendJson(res, 200, {
        ok: true,
        status: statusSnapshot(),
        phase: {
          waiting: statusPhase.waiting,
          doneAt: statusPhase.doneAt === 0 ? null : statusPhase.doneAt,
          approvalsSeen: statusPhase.approvalsSeen,
          askStale: statusPhase.askStale,
          pendingAsks: pendingAsks.size,
          preExecuteSeen: statusPhase.preExecuteSeen,
          kindsSeen: { ...statusPhase.kindsSeen },
        },
        doneHoldMs: STATUS.doneHoldMs,
      })
    }

    // 碎碎念的语音。页面侧自己决定念什么（那是它的兜底逻辑），
    // 但合成要交给常驻 worker —— 所以走这条上报通道。
    if (pathname === '/live2d/murmur') {
      const url = new URL(req.url, 'http://localhost')
      const text = (url.searchParams.get('text') ?? '').trim()
      if (text.length === 0) return sendJson(res, 400, { error: 'empty text' })
      enqueueSpeech({ id: `murmur-${Date.now()}`, text, mode: 'murmur', emotion: 'neutral', at: Date.now() }, true)
      return sendJson(res, 200, { ok: true })
    }

    // 页面回报的播放结果。没有它就只能猜「到底响没响」。
    if (pathname === '/live2d/audio-status') {
      const url = new URL(req.url, 'http://localhost')
      speech.playback = {
        id: url.searchParams.get('id'),
        ok: url.searchParams.get('ok') === '1',
        detail: url.searchParams.get('detail'),
        at: Date.now(),
      }
      return sendJson(res, 200, { ok: true })
    }

    // 诊断：按需念一句（走完整流水线），用于验证语音链路而不必等气泡。
    if (pathname === '/live2d/probe-speak') {
      const url = new URL(req.url, 'http://localhost')
      const text = url.searchParams.get('text') ?? '这是一句语音测试。'
      const file = join(speechDir(), `probe_${Date.now()}.wav`)
      const started = Date.now()
      try {
        await runSpeechScript(text, file)
        return sendJson(res, 200, {
          ok: true, text, elapsedMs: Date.now() - started,
          url: `/live2d/audio/${basename(file)}`,
          bytes: (() => { try { return statSync(file).size } catch { return null } })(),
        })
      } catch (error) {
        return sendJson(res, 200, {
          ok: false, text, elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // 点击反应：页面戳到身体时调它，由 Agent 现场生成一句话。
    // 用 POST 语义上更准确，但页面用 GET 更简单（无 body、无 CSRF 面）。
    if (pathname === '/live2d/poke') {
      const agents = ctx.get('agents')
      const agent = agents?.roots?.()[0] ?? agents?.list?.()[0]
      if (agent === undefined) {
        return sendJson(res, 200, { ok: false, reason: 'no-agent', text: null, emotion: null })
      }
      const controller = new AbortController()
      req.on('close', () => controller.abort())
      const text = await generateReaction(agent, controller.signal)
      if (text === null) {
        return sendJson(res, 200, { ok: false, reason: 'generation-failed', text: null, emotion: null })
      }
      const emotion = reactionEmotion(text)
      // 点击反应也是「说话」，同样要有声音。它不走 state.message（直接回给页面），
      // 所以用 standalone 排队，跳过防错位检查。
      // 注意用字面量 'poke'：`REACTION_MODE` 是 engine.js 里的常量、只注入到**页面**作用域，
      // 在 Host 这边引用它是 ReferenceError（会把整条 poke 路由打崩）。
      enqueueSpeech({ id: `poke-${Date.now()}`, text, mode: 'poke', emotion, at: Date.now() }, true)
      return sendJson(res, 200, { ok: true, text, emotion })
    }

    // 诊断：看一眼思维链采集到的原文，以及会挑中哪一句。
    // 挑句规则很容易挑出「不像人话」的片段，这个端点让规则可验证而不是靠感觉。
    //
    //   ?seed=<文本>  用给定文本走一遍挑选（验证切句/过滤规则，不改状态）
    //   ?speak=1      把挑中的那句真的写进 state（验证端到端显示，绕过节流）
    //
    // 为什么需要 seed：推理只在部分步骤流出（实测多数工具步骤只有 tool-call 块），
    // 而每次重载插件都会清空缓冲 —— 没有 seed 就没法确定性地验证规则本身。
    if (pathname === '/live2d/probe-reasoning') {
      const url = new URL(req.url, 'http://localhost')
      const full = url.searchParams.get('full') === '1'
      const seed = url.searchParams.get('seed')
      if (seed !== null && seed.length > 0) {
        // picked 是「旧做法会截出的那句」（保留下来做对照）；
        // distilled 才是现在真正会说的话 —— 读懂之后重新说一遍。
        const picked = pickReasoningSentence(seed)
        const distilled = await distillReasoning(seed)
        let spoken = null
        if (url.searchParams.get('speak') === '1' && distilled !== null) {
          const now = Date.now()
          const emotion = proactiveEmotion(distilled)
          state.revision += 1
          state.message = {
            id: state.revision,
            text: distilled,
            emotion,
            emotionLabel: EMOTION_LABELS.get(emotion) ?? emotion,
            mode: REASONING.mode,
            sticky: false,
            at: now,
          }
          spoken = state.message
          enqueueSpeech(state.message)
        }
        return sendJson(res, 200, { ok: true, seeded: seed.length, picked, distilled, spoken })
      }
      const items = []
      for (const [id, raw] of reasoningBuf.entries()) {
        items.push({
          agent: id,
          chars: raw.length,
          picked: pickReasoningSentence(raw),
          sample: full ? raw : raw.slice(-400),
        })
      }
      return sendJson(res, 200, { ok: true, stats: reasoningStat, buffers: items })
    }

    // 诊断：按需跑一次「任务完成」的话，但**不写 state**。
    // 完成说话由回合结束触发，没法手工制造一个 20 秒的回合来验，所以留这个口子。
    if (pathname === '/live2d/probe-done') {
      const url = new URL(req.url, 'http://localhost')
      const title = url.searchParams.get('title')
      const minutes = Number(url.searchParams.get('minutes') ?? '3')
      const agent = activeAgent()
      const line = await composeProactiveLine('completion', {
        title: title ?? (agent === null ? '刚才那件事' : (sessionTitle(agent) ?? '刚才那件事')),
        minutes: Number.isFinite(minutes) ? minutes : 3,
      })
      if (line === null) return sendJson(res, 200, { ok: false, error: proactive.lastError ?? 'no-line' })
      return sendJson(res, 200, {
        ok: true, text: line.text, emotion: line.emotion, provider: line.provider, model: line.model,
        brief: line.brief, gate: { minTurnMs: COMPLETION.minTurnMs, minGapMs: COMPLETION.minGapMs },
        stats: completionStat,
      })
    }

    // 诊断：按需跑一次主动说话，但**不写 state**（不打扰桌宠）。
    // 主动说话最小间隔 90 秒，没有这个端点就没法立刻验证标题解析与提示词质量。
    if (pathname === '/live2d/probe-proactive') {
      const result = await probeProactive()
      return sendJson(res, 200, result)
    }

    // 临时诊断：复现「auto-review 审查器」的请求形状（关键是不带 sessionId），
    // 用来验证 OpenCode 网关是否接受。验证完会移除。
    if (pathname === '/live2d/probe-route') {
      const llm = ctx.get('llm')
      if (llm === undefined) return sendJson(res, 200, { ok: false, reason: 'no-llm' })
      const url = new URL(req.url, 'http://localhost')
      const provider = url.searchParams.get('provider') ?? 'opencode-go'
      const model = url.searchParams.get('model') ?? 'deepseek-v4.1-flash'
      const withSession = url.searchParams.get('session') === '1'
      const options = {
        provider,
        model,
        system: 'You are a review classifier. Reply with JSON only.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION: {"name":"read","arguments":{"path":"x"}}\nReply {"risk":"low","decision":"allow"}' }] }],
        temperature: 0,
        ...(withSession ? { sessionId: 'probe-session-0001' } : {}),
      }
      const started = Date.now()
      let text = ''
      let error = null
      let detail = null
      try {
        for await (const chunk of llm.stream(options)) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
            const err = chunk.reason.error
            error = String(err?.message ?? err ?? 'error-finish')
            // 尽量把结构化字段也带出来：网关的 400 细节藏在 code/data 里
            try { detail = JSON.stringify(chunk.reason).slice(0, 800) } catch { detail = null }
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        try { detail = JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 800) } catch { detail = null }
      }
      return sendJson(res, 200, {
        ok: error === null,
        provider,
        model,
        sentSessionId: withSession,
        elapsedMs: Date.now() - started,
        text: text.slice(0, 300),
        error,
        detail,
      })
    }


    // 见 pet/dsh-pet.ps1；页面通过 postMessage 把拖动/缩放交给外壳。
    if (pathname === '/live2d/pet') {
      const model = await ensureModel()
      if (model === null) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(cachedError)
        return
      }
      const engine = engineSource()
      if (engine === null) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('engine.js 缺少必需符号或有重复声明，无法渲染宠物页')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(petPage(engine))
      return
    }

    if (pathname === '/live2d/manifest') {
      const model = await ensureModel()
      if (model === null) {
        return sendJson(res, 200, {
          ok: false,
          error: cachedError,
          candidates: modelDirCandidates(config),
          modelUrl: null,
          expressions: [],
        })
      }
      return sendJson(res, 200, {
        ok: true,
        modelName: model.name,
        modelDir: model.dir,
        modelUrl: `/live2d/model/${encodeURIComponent(model.settingsFile)}`,
        expressions: model.expressions,
        modes: MODES,
        statuses: ['idle', 'thinking'],
        // 桌宠是可诊断的：状态、pid、失败原因都如实报出来，
        // 免得再出现「以为它在跑、其实没启动」这种只能靠猜的情况。
        desktopPet: { ...petStatus },
      })
    }

    if (pathname.startsWith('/live2d/lib/')) {
      const name = pathname.slice('/live2d/lib/'.length)
      if (!Object.hasOwn(LIBS, name)) return sendJson(res, 404, { error: `unknown runtime ${name}` })
      return sendFile(res, join(VENDOR_DIR, name), 'no-cache')
    }

    if (pathname.startsWith('/live2d/model/')) {
      const relative = pathname.slice('/live2d/model/'.length)
      const model = await ensureModel()
      if (model === null) return sendJson(res, 404, { error: cachedError })
      // 生成的那份设置文件优先于磁盘上的同名文件。
      if (relative === model.settingsFile) return sendJson(res, 200, model.settings)
      if (relative.length === 0 || relative.includes('..') || relative.startsWith('/') || relative.includes('\\')) {
        return sendJson(res, 400, { error: 'invalid asset path' })
      }
      if (!ASSET_EXTENSIONS.has(extname(relative).toLowerCase())) {
        return sendJson(res, 403, { error: `asset extension not served: ${extname(relative)}` })
      }
      const absolute = resolve(model.dir, relative)
      if (absolute !== model.dir && !absolute.startsWith(model.dir + sep)) {
        return sendJson(res, 403, { error: 'asset escapes the model directory' })
      }
      // 表情文件补一个 FadeInTime：模型里的 exp3 都没写，而 pixi-live2d-display 的
      // createExpression(json, definition) 会丢掉 definition，只看 exp3 自己 ——
      // 于是所有表情都按 0.5s 的默认淡入，换脸有点生硬。
      // 注意用 endsWith：extname('x.exp3.json') 只给出 '.json'。
      if (relative.toLowerCase().endsWith(EXPRESSION_SUFFIX)) {
        const rewritten = expressionCache.get(relative)
        if (rewritten !== undefined) return sendJson(res, 200, rewritten)
        try {
          const parsed = JSON.parse(await readFile(absolute, 'utf8'))
          if (typeof parsed.FadeInTime !== 'number') parsed.FadeInTime = EXPRESSION_FADE_SECONDS
          expressionCache.set(relative, parsed)
          return sendJson(res, 200, parsed)
        } catch {
          // 解析不了就照原样发，表情本身还能用。
        }
      }
      return sendFile(res, absolute, 'max-age=300')
    }

    return sendJson(res, 404, { error: 'unknown live2d route', pathname })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/live2d',
    handler: (req, res) => {
      void handleRoute(req, res).catch((error) => {
        console.error('[dsh-live2d] route failed:', error)
        if (res.headersSent) {
          res.destroy()
          return
        }
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    },
  }), 'dsh-live2d: routes')

  // ── 提示词 ──────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:live2d',
    order: 100,
    text: [
      '你的桌面上有一个 Live2D 形象（独立窗口，不在网页里），它会同步展示你此刻的表情和一句话。',
      '当你想让人看见「没说出口的心里话」时，调用 live2d_express：内心吐槽、对当前任务的判断、做完一件事后的感想、短暂的闲聊都算。',
      '要真实，不要预设。写你**此刻**真的在想的东西，而且必须是这一轮才产生的、跟眼前这件事绑定的念头：',
      '- 具体到当下：不是「这个任务有点难」而是「这个正则我试了三遍还是没匹配上，有点烦」；',
      '- 允许负面和琐碎：卡住了、觉得这活真难、做得顺、有点得意、无语、发现自己搞错了心里发虚、觉得用户的要求有点怪；',
      '- 允许没有情绪：想不出说什么就别调用这个工具。空着比硬凑一条强。',
      '不要写：任务小结（「已完成 X 并验证 Y」）、礼貌话术、复述正文结论、放在任何任务里都成立的通用感想。',
      '判断标准：这句话如果换个任务也说得通，那它就是预设的，不要发。气泡是情绪，不是进度报告。',
      '用法：text 用第一人称的一两句口语；emotion 选最贴近的表情；mode 说明是 thought（内心想法）、opinion（对任务的看法）、chat（闲聊）还是 status（状态播报）。text 用中文，除非用户在用别的语言。',
      '克制使用：一个阶段或一个转折点一次即可，不要每个工具调用都发；正文照常在回复里说，不要把正常回答搬进气泡。',
    ].join('\n'),
  }), 'dsh-live2d: prompt')

  // ── 工具 ────────────────────────────────────────────────────────────────
  // 注意：这里是原生 `ctx.tools.register`，`parameters` 必须是真正的 JSON Schema
  // （顶层 type: 'object'）。作者 DSL（在每个属性上写 required: true）只在
  // `defineTool()` 里成立，装出来的 bundle 里没有它可导入。
  const parameters = {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '气泡里显示的一句话，第一人称、口语化，1-2 句（建议 40 字以内）。',
      },
      emotion: {
        type: 'string',
        enum: [...EMOTION_IDS],
        description: '表情。neutral 平静 / happy 开心 / sad 难过 / angry 生气 / cry 哭了 / shy 害羞 / sparkle 眼冒星星 / confused 困惑 / nervous 冒汗 / dizzy 晕乎乎 / love 满眼爱心 / gloomy 阴郁 / playful 调皮 / cool 耍酷 / tongue 吐舌 / shocked 震惊 / exhausted 灵魂出窍 / blank 发呆。默认 neutral。',
      },
      mode: {
        type: 'string',
        enum: [...MODES],
        description: 'thought 内心想法 / opinion 对任务的看法 / chat 闲聊 / status 状态播报。默认 thought。',
      },
      sticky: {
        type: 'boolean',
        description: 'true 表示这条一直留着直到下一条，适合「当前任务结论」这类长期态度；默认 false（十几秒后自动隐藏）。',
      },
    },
    required: ['text'],
  }
  // 上游会拒绝任何非 object 根的 parameters，而且失败发生在每一次模型请求上。
  // 与其等到用户会话报 400，不如在注册时就喊出来。
  if (parameters.type !== 'object') {
    throw new Error('live2d_express: parameters 必须是 object 根的 JSON Schema')
  }

  ctx.effect(() => ctx.tools.register({
    name: 'live2d_express',
    description: '通过 Live2D 虚拟形象表达你自己：气泡里的一句话 + 一个表情。用于心里想法、对任务的看法、闲聊或状态播报；不要用它代替正常回复。',
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'emotion', 'emotionLabel', 'mode', 'revision'],
        properties: {
          ok: { type: 'boolean' },
          emotion: { type: 'string' },
          emotionLabel: { type: 'string' },
          mode: { type: 'string' },
          revision: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Live2D 形象已更新：表情「${value.emotionLabel}」，模式 ${value.mode}。形象浮层会显示这条表达。`,
      }],
    },
    execute(args) {
      const requested = typeof args === 'object' && args !== null ? args : {}
      const emotion = EMOTION_IDS.includes(requested.emotion) ? requested.emotion : 'neutral'
      const mode = MODES.includes(requested.mode) ? requested.mode : 'thought'
      const text = typeof requested.text === 'string' ? requested.text.trim() : ''
      if (text.length === 0) throw new Error('live2d_express 需要非空的 text')
      state.revision += 1
      state.message = {
        id: state.revision,
        text: text.slice(0, 400),
        emotion,
        emotionLabel: EMOTION_LABELS.get(emotion) ?? emotion,
        mode,
        sticky: requested.sticky === true,
        at: Date.now(),
      }
      enqueueSpeech(state.message)
      return Promise.resolve({
        ok: true,
        emotion,
        emotionLabel: state.message.emotionLabel,
        mode,
        revision: state.revision,
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Live2D 表达', kind: 'other', rawInput: args }),
  }), 'dsh-live2d: tool')
}
