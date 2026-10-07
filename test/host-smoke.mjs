/**
 * Host 半边的冒烟测试：用一个假 Context 驱动 `host.js`，不需要启动 Harness。
 *
 *     node test/host-smoke.mjs
 *
 * 覆盖：路由注册、动态生成的 model3.json、模型文件读取、路径越界防护、
 * 状态机（agent/status → thinking/idle）、live2d_express 工具的参数校验与输出。
 */
import { Writable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = process.env.DSH_LIVE2D_MODEL_DIR ?? join(HERE, '..', '..', '..', 'DS面捕版')

const { apply } = await import(pathToFileURL(join(HERE, '..', 'host.js')).href)

const captured = { routes: [], tools: [], sections: [], events: new Map() }
const ctx = {
  on(name, listener) { captured.events.set(name, listener); return () => {} },
  effect(callback) { callback(); return () => {} },
  // 插件通过 ctx.get 取 llm / agents；测试里返回 undefined，
  // 于是 /live2d/poke 走「没有可用 Agent」分支 —— 这条分支本身也要能正确应答。
  get() { return undefined },
  tools: { register(definition) { captured.tools.push(definition); return () => {} } },
  // 需要 port：桌宠拉起要用它拼 URL。
  webServer: { port: 3080, register(route) { captured.routes.push(route); return () => {} } },
  systemPrompt: { section(section) { captured.sections.push(section); return () => {} } },
}

// 测试里不能真去起桌宠窗口：用配置把它关掉，同时单独断言这条分支的行为。
// doneHoldMs: 0 —— 「刚完成」的绿灯默认亮 30 秒，会盖住后面那些期待 idle 的断言。
// 这里关掉限时态，只测状态机本身；绿灯窗口另有一条断言单独守。
await apply(ctx, { modelDir: MODEL_DIR, desktopPet: 'off', doneHoldMs: 0 })

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
/** 布尔断言：条件本身就是要验证的事实。 */
const assert = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition ? '' : ` — ${detail}`}`)
}

const route = captured.routes[0]
async function call(url) {
  const chunks = []
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } })
  res.statusCode = 0
  res.headers = null
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers ?? {}; return res }
  const finished = new Promise(resolve => res.on('finish', resolve))
  await route.handler({ url }, res)
  await finished
  const body = Buffer.concat(chunks)
  return { status: res.statusCode, headers: res.headers, body }
}
const json = async (url) => JSON.parse((await call(url)).body.toString('utf8'))

console.log('— 注册 —')
check('route', captured.routes.map(r => `${r.kind} ${r.path}`), ['prefix /live2d'])
check('tool', captured.tools.map(tool => tool.name), ['live2d_express'])
check('prompt section', captured.sections.map(section => section.name), ['tool:live2d'])
// agent/assistant-stream 是思维链来源。按集合比较，不依赖注册顺序。
// agent/assistant-stream 是思维链来源；approval/request 与 user-questions/request
// 是「需要你操作」的信号（黄灯）。tools/pre-execute + tools/result 是第二条独立
// 信号路径：审批事件在部分 DSH 版本里不冒泡到根作用域，靠工具调用自身兜底。
// 按集合比较，不依赖注册顺序。
check('events', [...captured.events.keys()].sort(), [
  'agent/assistant-stream', 'agent/disposed', 'agent/status',
  'approval/request', 'tools/pre-execute', 'tools/result',
  'user-questions/request',
])

console.log('\n— 提示词必须给出「真实」的标准，而不只是发送节奏 —')
const promptText = captured.sections[0].text
check('要求真实、且明确反对预设', promptText.includes('要真实，不要预设'), true)
check('要求「此刻 + 绑定眼前这件事」', promptText.includes('此刻') && promptText.includes('跟眼前这件事绑定'), true)
check('要求具体到当下（给了对照例子）', promptText.includes('这个正则我试了三遍'), true)
check('允许负面与琐碎', promptText.includes('允许负面和琐碎'), true)
check('允许没有情绪（可以不发）', promptText.includes('想不出说什么就别调用'), true)
check('禁止写成任务小结', promptText.includes('任务小结'), true)
check('禁止复述正文结论', promptText.includes('复述正文结论'), true)
check('禁止通用感想', promptText.includes('放在任何任务里都成立'), true)
check('给出可操作的判断标准（换任务也说得通=预设）',
  promptText.includes('换个任务也说得通'), true)
check('气泡是情绪而非进度报告', promptText.includes('不是进度报告'), true)
check('仍然规定节奏（阶段/转折点一次）', promptText.includes('一个阶段或一个转折点一次'), true)
check('仍然要求中文', promptText.includes('text 用中文'), true)
check('不再说「浮层」（形象在桌面窗口）', !promptText.includes('浮层'), true)

console.log('\n— 工具参数必须是 object 根 JSON Schema（上游会拒绝其他形态）—')
const parameters = captured.tools[0].parameters
check('parameters.type', parameters.type, 'object')
check('parameters.required', parameters.required, ['text'])
check('emotion enum 覆盖 18 种表情', parameters.properties.emotion.enum.length, 18)

console.log('\n— 资源路由 —')
const manifest = await json('/live2d/manifest')
check('manifest ok', manifest.ok, true)
check('manifest 表情数', manifest.expressions.length, 17)
check('表情下标连续', manifest.expressions.map(expression => expression.index), manifest.expressions.map((_, index) => index))

const settings = await json('/live2d/model/c_0120.model3.json')
check('settings moc', settings.FileReferences.Moc, 'c_0120.moc3')
check('settings 贴图数', settings.FileReferences.Textures.length, 2)
check('settings 表情已登记', settings.FileReferences.Expressions.length, 17)
check('settings Idle 动作已登记', settings.FileReferences.Motions.Idle.length, 1)

const moc = await call('/live2d/model/c_0120.moc3')
check('moc3 状态', moc.status, 200)
check('moc3 magic', moc.body.subarray(0, 4).toString('ascii'), 'MOC3')
check('moc3 类型', moc.headers['content-type'], 'application/octet-stream')

const texture = await call('/live2d/model/' + encodeURIComponent('c_0120.2048/texture_00.png'))
check('贴图状态', texture.status, 200)
check('贴图类型', texture.headers['content-type'], 'image/png')

const expression = await call('/live2d/model/' + encodeURIComponent('开心兴奋.exp3.json'))
check('表情文件状态', expression.status, 200)
{
  // exp3 里补的 FadeInTime 必须真的出现在响应体里 —— pixi-live2d-display 只看 exp3
  // 自己，model3.json 上的 FadeInTime 会被丢掉。
  const body = JSON.parse(expression.body.toString('utf8'))
  check('表情响应补上了 FadeInTime', typeof body.FadeInTime, 'number')
  check('淡入比默认的 0.5s 更缓', body.FadeInTime > 0.5, true)
  check('表情参数没被改动', body.Parameters.length, 12)
  check('Type 字段保留', body.Type, 'Live2D Expression')
}
{
  // 同一个文件重复请求必须一致（走了缓存），不能一次有一个没有。
  const again = JSON.parse((await call('/live2d/model/' + encodeURIComponent('开心兴奋.exp3.json'))).body.toString('utf8'))
  const first = JSON.parse(expression.body.toString('utf8'))
  check('重复请求结果一致（缓存没串味）', again, first)
}
{
  // 非表情的 json 不该被加 FadeInTime。
  const physics = JSON.parse((await call('/live2d/model/c_0120.physics3.json')).body.toString('utf8'))
  check('physics3.json 未被注入 FadeInTime', 'FadeInTime' in physics, false)
}

const motion = await call('/live2d/model/' + encodeURIComponent('motions/idle.motion3.json'))
check('动作文件状态', motion.status, 200)

for (const library of ['pixi.min.js', 'live2dcubismcore.min.js', 'cubism4.min.js']) {
  const response = await call('/live2d/lib/' + library)
  check(`运行时 ${library}`, [response.status, response.headers['content-type']], [200, 'text/javascript; charset=utf-8'])
}

console.log('\n— 宠物页（桌宠与画中画共用）—')
{
  const page = await call('/live2d/pet')
  check('宠物页状态', page.status, 200)
  check('宠物页类型', page.headers['content-type'], 'text/html; charset=utf-8')
  const html = page.body.toString('utf8')
  assert('宠物页是完整 HTML', html.startsWith('<!doctype html>') && html.includes('</html>'))
  // 回归：曾经把 </style> 丢掉，导致 <style> 不闭合、body 与所有 <script> 被吞掉，
  // 页面在 WebView2 里是空白的。这几条断言专治这类「标签没闭合」。
  assert('style 标签已闭合', /<\/style>/.test(html))
  assert('没有残留的占位注释', !html.includes('STYLE_END'))
  assert('body 标签存在', /<\/?body/.test(html))
  assert('闭括号数量匹配', (html.match(/<style>/g) || []).length === (html.match(/<\/style>/g) || []).length)
  assert('script 标签成对', (html.match(/<script/g) || []).length === (html.match(/<\/script>/g) || []).length)
  assert('至少有一个内联脚本', (html.match(/<script>/g) || []).length >= 1)
  assert('页面长度合理（> 3KB）', html.length > 3000, `实际 ${html.length}`)
  assert('#stage 容器存在', html.includes('id="stage"'))
  assert('#hint 容器存在', html.includes('id="hint"'))
  assert('#bubble 容器存在', html.includes('id="bubble"'))
  assert('背景透明（两个宿主都要看到桌面）', html.includes('background: transparent'))
  assert('加载三个运行时', ['pixi.min.js', 'live2dcubismcore.min.js', 'cubism4.min.js'].every(n => html.includes(n)))
  assert('画面尺寸只用 CSS 逻辑像素', /element \? element\.clientWidth/.test(html))
  assert('刻意不用 renderer.width 适配', !/app\.renderer\.width/.test(html))
  assert('读真实表达', html.includes('/live2d/state'))
  assert('会换表情', html.includes('expressionManager') && html.includes('resetExpression'))
  assert('模型取固有尺寸', html.includes('internalModel.width'))

  // 清晰度：真正的根因是**进程 DPI 感知**，不是采样率。
  // 未声明 DPI 感知时 Windows 会把整个窗口位图拉伸（实测桌面真实 1920×1200
  // 被 WinForms 报成 1280×800，即 150% 缩放），超采样越多反而越糊一层。
  // 所以外壳声明 Per-Monitor V2，页面侧用原版精度（1 CSS 像素 = 1 物理像素）。
  assert('宠物页用原版精度（不人为超采样）', html.includes('var SUPERSAMPLE = 1'))
  assert('仍尊重真实 devicePixelRatio', html.includes('Math.max(SUPERSAMPLE, dpr)'))
  assert('开启 mipmap', html.includes('MIPMAP_MODES') && html.includes('baseTexture.mipmap'))
  assert('有状态指示元素', html.includes('id="status"') && html.includes('id="statusText"'))
  assert('状态有 待机/思考中 两态', html.includes('思考中') && html.includes('待机'))
  assert('状态由 /live2d/state 驱动', html.includes('setStatus(s.status)'))

  // 与浮层功能对齐
  assert('待机动作已接上', html.includes('createIdleAnimator(model, {})') && html.includes("on('afterMotionUpdate'"))
  assert('待机换脸', html.includes('scheduleIdleExpression') && html.includes('IDLE_EXPRESSIONS'))
  assert('碎碎念', html.includes('scheduleMurmur') && html.includes('MURMURS'))
  assert('点击反应', html.includes('REACTIONS') && html.includes('animator.poke()'))
  assert('只认身体本体', html.includes('function onModel(') && html.includes('model.getBounds()'))

  // 宠物页内嵌 `engine.js` 整份源码。历史上有两次它整块作废：
  // 一次是切分只取常量导致 `fitModel is not defined`；
  // 一次是整块与常量同时交付导致 `IDLE_MODE has already been declared`。
  // 浏览器里一个语法错误会让整个 script 块失效，所以必须**逐块做语法检查** ——
  // 只断言「字符串在页面里」是不够的，我第一次就是这么漏掉的。
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  assert('宠物页至少两个内联脚本块', blocks.length >= 2, `实际 ${blocks.length}`)
  const engineBlock = blocks[0]
  assert('引擎块非空', engineBlock.length > 1000, `${engineBlock.length} 字符`)
  for (const required of [
    'function fitModel(', 'function viewportOf(', 'function computeFit(', 'function intrinsicSize(',
    'function createIdleAnimator(', 'function createDrift(', 'function gestureWave(', 'function advanceFollower(',
    'const IDLE_MODE', 'const MURMURS', 'const REACTIONS', 'const IDLE_EXPRESSIONS',
  ]) {
    assert(`引擎块含 ${required}`, engineBlock.includes(required))
  }
  // engine.js 是独立文件，顶层声明在**第 0 列**；缩进的是函数体内部，
  // 那里的局部变量重名是合法的。
  const declared = [...engineBlock.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
  const seen = new Set()
  const dupes = new Set()
  for (const name of declared) {
    if (seen.has(name)) dupes.add(name)
    seen.add(name)
  }
  assert('引擎块没有重复的顶层声明', dupes.size === 0, `重复: ${[...dupes].join(', ')}`)
  assert('确实识别到了顶层声明（断言本身有效）', declared.length >= 40, `declared=${declared.length}`)
  const tmp = join(tmpdir(), `dsh-pet-block-${process.pid}`)
  mkdirSync(tmp, { recursive: true })
  try {
    for (const [index, code] of blocks.entries()) {
      const file = join(tmp, `block-${index}.mjs`)
      writeFileSync(file, code)
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
        assert(`脚本块 ${index} 语法通过`, true)
      } catch (error) {
        const detail = String(error.stderr ?? '').split('\n').filter(Boolean).slice(0, 3).join(' | ')
        assert(`脚本块 ${index} 语法通过`, false, detail)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

check('未知路由 404', (await call('/live2d/nope')).status, 404)
check('URL 编码越界 400', (await call('/live2d/model/..%2F..%2Fwin.ini')).status, 400)
check('非白名单后缀 403', (await call('/live2d/model/icon.exe')).status, 403)
check('拼写越界 400', (await call('/live2d/model/....//....//win.ini')).status, 400)

console.log('\n— 桌宠可诊断（它曾经「以为在跑、其实没启动」）—')
{
  const manifest = await json('/live2d/manifest')
  assert('manifest 里有 desktopPet 状态', manifest.desktopPet !== undefined)
  check('配置 off 时如实报告', manifest.desktopPet.mode, 'off')
  assert('off 时给出原因', typeof manifest.desktopPet.detail === 'string' && manifest.desktopPet.detail.length > 0,
    JSON.stringify(manifest.desktopPet))
  assert('off 时不会声称在运行', manifest.desktopPet.state !== 'running', String(manifest.desktopPet.state))
}

console.log('\n— /live2d/poke 在无可用 Agent 时也要正确应答 —')
{
  // 没有活跃会话时不能 500、不能挂住 —— 页面靠这个响应决定退回哪句话。
  const response = await call('/live2d/poke')
  check('状态 200（不是 500）', response.status, 200)
  const body = JSON.parse(response.body.toString('utf8'))
  check('ok=false', body.ok, false)
  check('reason=no-agent', body.reason, 'no-agent')
  check('text 为 null（页面据此退回）', body.text, null)
}

console.log('\n— 桌宠外壳：DPI 感知必须在建窗之前声明 —')
{
  // 这是「桌宠很糊」的真正修复点。DPI UNAWARE 的进程会被 Windows 位图拉伸，
  // 任何页面侧的超采样都救不回来。所以这条断言守的是根因，不是表面参数。
  const shell = readFileSync(join(HERE, '..', 'pet', 'dsh-pet.ps1'), 'utf8')
  assert('声明了 Per-Monitor V2 DPI 感知', shell.includes('SetProcessDpiAwarenessContext'))
  assert('有老系统回退路径', shell.includes('SetProcessDpiAwareness(2)'))
  const dpiAt = shell.indexOf('SetProcessDpiAwarenessContext')
  const formAt = shell.indexOf('New-Object System.Windows.Forms.Form')
  assert('DPI 声明在建窗之前', dpiAt > 0 && formAt > 0 && dpiAt < formAt, `dpi@${dpiAt} form@${formAt}`)
  assert('窗口尺寸按 DPI 缩放（维持视觉大小）', shell.includes('$Width * $scale') && shell.includes('$Height * $scale'))
  assert('日志里报告 DPI 状态', shell.includes('实际感知'))
}

console.log('\n— 拖动与缩放（由页面 postMessage 发起）—')
{
  // 为什么必须走 postMessage：WebView2 控制器铺满客户区，会吃掉所有鼠标事件，
  // WinForms 的 Form.MouseDown 永远不触发 —— 早先挂在 Form 上的拖动从未生效过。
  const html2 = (await call('/live2d/pet')).body.toString('utf8')
  assert('页面有 postMessage 通道', html2.includes('chrome.webview') && html2.includes('postMessage'))
  assert('拖动用 screenX/screenY（屏幕物理坐标，避免 DPI 漂移）',
    html2.includes('event.screenX') && html2.includes('event.screenY'))
  assert('发出 drag 消息', html2.includes("post('drag'"))
  assert('发出 zoom 消息', html2.includes("post('zoom'"))
  assert('指针捕获（拖出窗口也跟手）', html2.includes('setPointerCapture'))
  assert('拖动时不误触发戳击', html2.includes('> 8) return'))
  assert('滚轮阻止页面滚动', html2.includes("passive: false"))

  const shell = readFileSync(join(HERE, '..', 'pet', 'dsh-pet.ps1'), 'utf8')
  assert('外壳监听 WebMessageReceived', shell.includes('Add_WebMessageReceived'))
  assert('外壳处理 drag', shell.includes("'drag'"))
  assert('外壳处理 zoom', shell.includes("'zoom'"))
  assert('外壳不再依赖 Form 的鼠标事件', !shell.includes('$form.Add_MouseDown'))
  assert('拖动日志有节流（不刷爆日志）', shell.includes('lastDragLog'))
}

console.log('\n— 输入可达性：透明改用 DWM，绝不用 TransparencyKey —')
{
  // 这是「鼠标放到身上会点到下一层」的根因，代价最大的一条：
  // TransparencyKey 让窗口成为 WS_EX_LAYERED 分层窗口，而 Windows 对分层窗口的
  // 鼠标命中测试**按 GDI 位图**判断；WebView2 内容走 GPU 合成、不进 GDI 位图，
  // 于是整个窗口被视为全透明 → 每一次点击都穿透。
  // 修法：窗口保持非分层，透明改用 DWM 合成（DwmExtendFrameIntoClientArea）。
  const shell = readFileSync(join(HERE, '..', 'pet', 'dsh-pet.ps1'), 'utf8')
  const code = shell.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert('代码里不再设置 TransparencyKey', !/TransparencyKey\s*=/.test(code))
  assert('用 DWM 实现透明', shell.includes('DwmExtendFrameIntoClientArea'))
  assert('窗口背景是实色（保持非分层）', code.includes('$form.BackColor = [System.Drawing.Color]::Black'))
  assert('透明仍由 WebView2 负责', shell.includes('DefaultBackgroundColor'))
  assert('注释里记录了这条根因（防回归时被误解）', shell.includes('命中测试'))
  assert('DWM 调用在窗口显示之后',
    shell.indexOf('$form.Show()') < shell.indexOf('[Dsh.Top]::DwmExtendFrameIntoClientArea('))
  // 置顶要真的做，且不能加 WS_EX_NOACTIVATE（加了 topmost 会被前台窗口压回）
  assert('显式 SetWindowPos(HWND_TOPMOST)', shell.includes('HWND_TOPMOST'))
  assert('心跳里重申置顶', shell.includes("Assert-TopMost '被其它窗口盖住'"))
  assert('不加 WS_EX_NOACTIVATE（否则置顶失效）', !/WS_EX_NOACTIVATE\s*-bor/.test(shell))
}

console.log('\n— 只有按在身体上才能拖动 —')
{
  const html4 = (await call('/live2d/pet')).body.toString('utf8')
  // 要求：拖窗口不该在任何地方都能拖；空白处按下不移动窗口，只有碰到身体才拖。
  const from = html4.indexOf("addEventListener('pointerdown'")
  const handler = html4.slice(from, html4.indexOf('});', from))
  assert('pointerdown 里先判定是否在身体上', handler.includes('onModel(event.clientX, event.clientY)'))
  assert('不在身上就 return（不进入拖动状态）',
    /if \(!onModel\(event\.clientX, event\.clientY\)\) return;/.test(handler))
  assert('判定在置位 dragging 之前', handler.indexOf('onModel(') < handler.indexOf('dragging = true'))
  assert('仍复用同一个包围盒判据', html4.includes('function onModel(') && html4.includes('model.getBounds()'))
}

console.log('\n— 状态栏贴近形象 —')
{
  const html5 = (await call('/live2d/pet')).body.toString('utf8')
  assert('状态栏存在', html5.includes('id="status"') && html5.includes('id="statusText"'))
  // 要求「靠近形象一点」：不能是固定死值，要依模型包围盒实时定位
  assert('有 placeStatus 依模型定位', html5.includes('function placeStatus()'))
  assert('用了模型的包围盒（头顶往上）', /b\.y - 30/.test(html5))
  assert('左侧也跟着模型走', /b\.x \+ 6/.test(html5))
  assert('fit 时一并定位', html5.includes('fitModel(model, app, stage); placeStatus();'))
  assert('不越出窗口上沿', html5.includes('Math.max(8, b.y - 30)'))
}

console.log('\n— 网页浮层已移除（所有交互都在桌宠）—')
{
  assert('client.js 已删除', !existsSync(join(HERE, '..', 'client.js')))
  const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
  assert('package.json 不再声明 dsh.client', manifest.dsh.client === undefined)
  assert('exports 不再暴露 ./client', manifest.exports['./client'] === undefined)
  assert('exports 暴露 ./engine', manifest.exports['./engine'] === './engine.js')
  assert('files 含 engine.js', manifest.files.includes('engine.js'))
  assert('files 不含 client.js', !manifest.files.includes('client.js'))
  const shellSrc = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  assert('host.js 不再读 client.js', !shellSrc.includes("'client.js'"))
  assert('host.js 读 engine.js', shellSrc.includes("'engine.js'"))
}

console.log('\n— 宠物页脚本不得引用 engine.js 未定义的符号 —')
{
  // 这条守的是一次真实事故：MURMUR_MIN_MS 等三个碎碎念节流常量原本在旧 client.js
  // 的文件顶部、不在被抽取的 region 里，于是没进 engine.js。结果宠物页在
  // scheduleMurmur() 处抛 `MURMUR_MIN_MS is not defined`，boot() 中断，
  // **后面的状态轮询从未注册** —— 状态栏永远停在初始「待机」，
  // 看上去像「没连上 DSH」，实际是漏搬了三个常量。
  const html = (await call('/live2d/pet')).body.toString('utf8')
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  const pageBlock = blocks[blocks.length - 1]
  const engine = readFileSync(join(HERE, '..', 'engine.js'), 'utf8')

  // 页面自己声明的（含 var/const/let/function）+ 引擎声明的 = 可用符号
  const declaredIn = (src) => [
    ...src.matchAll(/(?:^|\s)(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g),
  ].map(m => m[1])
  const available = new Set([...declaredIn(pageBlock), ...declaredIn(engine)])
  // 浏览器/JS 内置与属性名不算
  for (const builtin of ['JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise',
    'Date', 'Error', 'Set', 'Map', 'URL', 'Infinity', 'NaN', 'undefined', 'window', 'document',
    'performance', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'ResizeObserver', 'PointerEvent', 'Event', 'console', 'isNaN', 'parseInt', 'parseFloat']) {
    available.add(builtin)
  }

  // 只看**代码里**的常量引用，排除注释与字符串 ——
  // 否则 `UNAWARE`（注释里的一个词）会被当成未定义符号误报。
  const code = pageBlock
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))   // 去掉整行注释
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')                    // 去掉块注释
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")                 // 去掉单引号字符串
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')                 // 去掉双引号字符串
  const used = new Set(
    [...code.matchAll(/(?<![.\w'"])([A-Z][A-Z0-9_]{3,})\b/g)].map(m => m[1]),
  )
  const missing = [...used].filter(name => !available.has(name)).sort()
  assert('页面引用的常量在 engine.js 或页面里都有定义', missing.length === 0,
    `未定义: ${missing.join(', ')}`)

  // 直接点名那几个常量，防止断言因正则失效而空转
  for (const name of ['MURMUR_MIN_MS', 'MURMUR_SPAN_MS', 'MURMUR_VISIBLE_MS',
    'IDLE_MODE', 'MURMURS', 'REACTIONS', 'REACTION_MODE', 'REACTION_VISIBLE_MS',
    'IDLE_EXPRESSIONS', 'IDLE_EXPRESSION_MIN_MS', 'IDLE_EXPRESSION_SPAN_MS', 'IDLE_EXPRESSION_QUIET_MS']) {
    assert(`engine.js 定义了 ${name}`, new RegExp(`const ${name}\\b`).test(engine))
  }
  assert('确实扫到了被引用的常量（断言本身有效）', used.size >= 5, `used=${used.size}`)
}

console.log('\n— 点击反应是现场生成的，不是预设 —')
{
  const html = (await call('/live2d/pet')).body.toString('utf8')
  // 页面侧：不再从 REACTIONS 里随机挑，而是问 Host 要
  assert('页面调用 /live2d/poke', html.includes("fetch('/live2d/poke'"))
  assert('页面不再随机挑预设词条', !html.includes('REACTIONS[Math.floor'))
  assert('连点不叠加请求', html.includes('pokeBusy'))
  assert('生成失败也有反应（不沉默）', html.includes("'……嗯？'"))

  // Host 侧：有生成逻辑，且真的走 llm
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  assert('Host 有 /live2d/poke 路由', src.includes("'/live2d/poke'"))
  assert('Host 有 generateReaction', src.includes('async function generateReaction'))
  assert('用 llm 服务生成', src.includes("ctx.get('llm')") && src.includes('llm.stream('))
  assert('把最近的表达作为上下文', src.includes('recent.text'))
  assert('生成失败返回 null 而不是抛', src.includes('return null'))
  assert('有按语气配表情', src.includes('function reactionEmotion'))
}

console.log('\n— 状态机（payload 形状必须与真实事件一致）—')
const tool = captured.tools[0]
{
  const initial = await json('/live2d/state')
  check('初始 status', initial.status, 'idle')
  check('初始 revision', initial.revision, 0)
  check('初始 message', initial.message, null)
  check('初始 updatedAt', initial.updatedAt, null)
  assert('带 debug 字段（诊断「插件看到了什么」）', initial.debug !== undefined)
}

// 真实 payload 是 `{ agent, status }`，agent 直接挂在顶层、id 在 `agent.id`。
// 我最初写的是 `agent.session.id`，于是真实事件里永远是 undefined → 恒为「待机」。
// 而这个测试当时伪造的也是 `agent.session.id`，所以照着错误假设一路绿灯 ——
// 现在按真实形状构造，两种写法只有一种能通过。
const statusListener = captured.events.get('agent/status')
const agentA = { id: 'agent-a' }
const agentB = { id: 'agent-b' }
statusListener({ agent: agentA, status: 'running' })
check('running → thinking', (await json('/live2d/state')).status, 'thinking')
statusListener({ agent: agentB, status: 'running' })
statusListener({ agent: agentA, status: 'idle' })
check('仍有会话在跑 → thinking', (await json('/live2d/state')).status, 'thinking')
statusListener({ agent: agentB, status: 'idle' })
check('全部停下 → idle', (await json('/live2d/state')).status, 'idle')

// 反向护栏：payload 里没有 agent 时不能把状态搞乱，也不能把 '' 当成会话
statusListener({ status: 'running' })
check('缺 agent 的 payload 被忽略', (await json('/live2d/state')).status, 'idle')
statusListener({ agent: agentA, status: 'running' })
check('恢复 running', (await json('/live2d/state')).status, 'thinking')
statusListener({ agent: agentA, status: 'idle' })
check('停回 idle', (await json('/live2d/state')).status, 'idle')

// disposed 也要用同一个 id 键
const disposedListener = captured.events.get('agent/disposed')
statusListener({ agent: agentA, status: 'running' })
disposedListener({ agent: agentA })
check('agent/disposed 按 agent.id 清理', (await json('/live2d/state')).status, 'idle')

// 最关键的一条：agent/status 是**按 agent 作用域派发**的，根级监听必须声明
// `{ global: true }` 才收得到。漏了它监听**永远不会触发** —— 而只测 listener 函数
// 本身发现不了（测试直接调用函数，绕过了真实派发）。所以必须对着源码断言注册选项。
{
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  const grab = (anchor) => {
    const from = src.indexOf(anchor)
    if (from < 0) return ''
    const to = src.indexOf('}, {', from)
    return to < 0 ? '' : src.slice(to, src.indexOf('\n', to))
  }
  assert('agent/status 监听声明了 global: true（否则根级收不到）',
    /global:\s*true/.test(grab("ctx.on('agent/status'")))
  assert('agent/disposed 监听声明了 global: true',
    /global:\s*true/.test(grab("ctx.on('agent/disposed'")))
  assert('取的是 agent.id 而不是 agent.session.id',
    src.includes('payload?.agent?.id') && !src.includes('payload?.agent?.session?.id'))
}

console.log('\n— host.js 里不得有重复的函数声明 —')
{
  // 这类 bug 会**静默**覆盖：JS 函数声明会提升，后声明的赢。
  // 我加新的 statusSnapshot 时忘了删旧的，于是生效的一直是「只看事件集合」的旧版，
  // 而那个集合是空的 → 状态永远待机。诊断字段明明看到 agents 在跑也没用，
  // 因为被覆盖的那个函数根本没去查。
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  const declared = [...src.matchAll(/^ {2}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
  const seen = new Set()
  const dupes = new Set()
  for (const name of declared) {
    if (seen.has(name)) dupes.add(name)
    seen.add(name)
  }
  assert('apply 内部没有重复的函数声明', dupes.size === 0, `重复: ${[...dupes].join(', ')}`)
  assert('确实扫到了函数声明（断言本身有效）', declared.length >= 8, `declared=${declared.length}`)
  assert('查询用的是 list()，不是 roots()',
    src.includes('agents.list()') && !src.includes('agents.roots()'))
}

console.log('\n— 主动说话：她自己开口，且必须是现场生成的 —')
{
  const html = await (await call('/live2d/pet')).body.toString('utf8')
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')

  // 气泡标签：页面靠 LABEL[mode] 显示，漏了会退化成直接显示英文 mode
  assert('页面 LABEL 有 proactive', /proactive:\s*'[^']+'/.test(html))

  // 生成链路
  assert('有主动说话实现', src.includes('async function proactiveSpeak'))
  assert('生成与写入拆开（诊断端点要能不写 state）', src.includes('async function composeProactiveLine'))
  assert('诊断端点存在且不写 state', src.includes("'/live2d/probe-proactive'") && src.includes('async function probeProactive'))
  assert('走 llm 现场生成', src.includes('llm.stream(options)'))
  assert('失败不退回预设（保持沉默）', src.includes('生成失败就**不说话**'))

  // 上下文必须落到「具体任务」——会话标题是「某某任务」的来源
  assert('读了会话标题', src.includes("stateOf?.(agent.session, 'title')"))
  assert('标题两种形状都认（裸值 / {val}）', src.includes('raw.val'))
  assert('提示词要求点到具体任务名', src.includes('尽量点到**具体那个任务的名字**'))
  assert('提示词禁止复述列表', src.includes('不要复述上面的列表'))

  // 三条节流规矩
  assert('有最小间隔', /minGapMs:\s*\d/.test(src))
  assert('启动后先安静（不能一重载就开腔）', /firstDelayMs:\s*\d/.test(src) && src.includes('proactive.lastAt === 0) return now - proactive.startedAt'))
  assert('有随机抖动', src.includes('jitterMs'))
  assert('有每小时预算', /hourlyBudget:\s*\d/.test(src))
  assert('真实表达后让路', /quietAfterExpressMs:\s*\d/.test(src))
  assert('防复读（与上一句雷同就丢）', src.includes('state.message.text === line.text'))
  assert('定时器 unref（不拖住进程退出）', src.includes('proactive.timer.unref'))

  // 开关与清理
  assert('有独立的 effect 管理生命周期', src.includes('dsh-live2d: proactive speech'))
  assert('定时器可停止', src.includes('clearInterval(proactive.timer)'))

  // 可观测
  assert('debug 暴露主动说话状态', src.includes('proactive: {') && src.includes('budgetUsed'))
  assert('debug 不泄露会话内容', !/proactive:\s*\{[^}]*\btext:/.test(src))
}

console.log('\n— 思维链：说的是模型真实的思考片段 —')
{
  const html = await (await call('/live2d/pet')).body.toString('utf8')
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')

  assert('页面 LABEL 有 reasoning', /reasoning:\s*'[^']+'/.test(html))

  // 来源必须是 assistant-stream 的 reasoning-delta
  assert('监听 agent/assistant-stream', src.includes("ctx.on('agent/assistant-stream'"))
  assert('读 reasoning-delta', src.includes("chunk?.type === 'reasoning-delta'"))
  // agent 作用域事件 → 必须 global（和 agent/status 同一个坑）
  {
    const from = src.indexOf("ctx.on('agent/assistant-stream'")
    const to = src.indexOf('}, {', from)
    assert('该监听声明了 global: true', /global:\s*true/.test(src.slice(to, src.indexOf('\n', to))))
  }

  // 挑句规则：必须真的过滤，不能整段贴
  assert('有挑句函数', src.includes('function pickReasoningSentence'))
  assert('中文句末标点切句', src.includes('(?<=[。！？；;])'))
  // 英文句号只在后面是空白/中文时才切 —— 否则 1.5、node.js 会被切断
  assert('英文句号按上下文切（不切小数与文件名）', src.includes('(?<=[.!?])(?=\\s|[\\u4e00-\\u9fff])'))
  assert('剥掉 Markdown 标记', src.includes("replace(/[*_`~>#]/g, '')"))
  assert('去掉句子两端引号', src.includes("replace(/^[\"'「『]+|[\"'」』]+$/g, '')"))
  // 实测挑出过 `"block-start:reasoning": 2, ← 推理块出现了！` —— 以 ！结尾骗过了句末检查
  assert('拒绝含引号/反引号的句子（引用代码的痕迹）', src.includes('/["`]/.test(s)'))
  assert('允许 don\'t 这类撇号', src.includes("/\\w'\\w/"))
  assert('拒绝以 , : " 收尾的截断代码', src.includes('/[":,]\\s*$/.test(s)'))
  assert('过滤 JSON 片段', src.includes('/^[[{<]/.test(s)'))
  assert('过滤链接', src.includes('https?:\\/\\/|www\\.'))
  assert('过滤纯路径/标识符', src.includes('纯标识符或路径'))
  assert('有长度上下限', /minChars:\s*\d/.test(src) && /maxChars:\s*\d/.test(src))
  assert('缓冲有上限（不吃满内存）', /bufferLimit:\s*\d/.test(src))
  assert('start 不清空缓冲（否则要说话时正好是空的）',
    src.includes('**不清空**缓冲') && src.includes('if (!reasoningBuf.has(id)) reasoningBuf.set(id'))
  assert('从靠后的句子挑（贴近当下思路）', src.includes('REASONING.tailWindow'))
  assert('有随机（避免每次都同一句）', src.includes('tail[Math.floor(Math.random()'))
  // 思维链语言未必与用户一致，中文优先但不因语言而沉默
  assert('中文优先', src.includes('cjk.length > 0 ? cjk : usable'))
  assert('全是英文时仍照发', src.includes('那是它真实的思考'))

  // 优先级：思维链优先，生成只兜底
  assert('有统一的说话入口', src.includes('async function speakBest'))
  assert('思维链优先于生成', src.indexOf('speakReasoning(agentId, now)') < src.indexOf('await proactiveSpeak()'))
  assert('一步结束时会尝试说', src.includes("frame.type === 'end'") && src.includes('speakReasoning(id, now)'))
  assert('定时器走统一入口', src.includes('void speakBest()'))

  // 可观测
  assert('debug 暴露思维链采集量', src.includes('reasoningStat.chunks') && src.includes('chunks: reasoningStat.chunks'))
  assert('有思维链诊断端点', src.includes("'/live2d/probe-reasoning'"))
}

console.log('\n— 状态灯：绿=完成 / 黄=等你操作 —')
{
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  const html = await (await call('/live2d/pet')).body.toString('utf8')

  // 四态与配色
  assert('有 waiting/done 两个新态', src.includes("return 'waiting'") && src.includes("return 'done'"))
  assert('绿灯样式', html.includes('#status.done .dot') && html.includes('#34c77b'))
  assert('黄灯样式（脉冲，比思考中更抓眼）', html.includes('#status.waiting .dot') && html.includes('#f0b429'))
  assert('页面文案四态齐全', html.includes('等你操作') && html.includes('完成了'))
  assert('切换时清掉旧 class（不然会串色）',
    html.includes("classList.remove('thinking', 'waiting', 'done')"))

  // 「需要你操作」的两个来源
  assert('监听权限申请', src.includes("'approval/request'"))
  assert('监听问卷', src.includes("'user-questions/request'"))
  assert('用计数而非布尔（并发申请不能互相抵消）', src.includes('statusPhase.waiting += 1'))
  // waterfall 必须把 next() 的结果原样返回，否则掐断审批链
  assert('不掐断 waterfall（原样返回 next()）', src.includes('return await next()'))
  // 这两个事件是 agent 作用域的，根监听收不到
  {
    const from = src.indexOf("'approval/request', 'user-questions/request'")
    const to = src.indexOf(')', src.indexOf('{ global: true }', from))
    assert('两个监听都声明了 global: true', /global:\s*true/.test(src.slice(from, to)))
  }

  // 完成 → 绿
  assert('回合结束就转绿（哪怕太短不值得说话）', src.includes('markDone()'))
  assert('绿灯是限时的（一直绿就没信息量了）', src.includes('doneHoldMs'))

  // 优先级：正在干活要压过刚完成的绿灯（实测被测试抓出来的错序）
  assert('优先级：干活 > 刚完成', src.includes('if (running_)') && src.includes('statusPhase.doneAt = 0'))
}

console.log('\n— 黄灯：审批事件真的能点亮它吗 —')
{
  // 直接调用注册的监听器 —— 用户报过「审批时还显示思考中」，
  // 必须先确认「事件到了之后我这边会不会亮」，才能把「事件没到」和「到了没亮」分开。
  const approval = captured.events.get('approval/request')
  assert('注册了 approval/request 监听', typeof approval === 'function')

  let release = null
  const pending = new Promise((resolve) => { release = resolve })

  // 模拟一次审批：next() 挂着不返回 = 用户还没点
  const running = approval({ kind: 'approval' }, () => pending)

  const during = await json('/live2d/state')
  check('审批挂起时状态是 waiting', during.status, 'waiting')
  check('计数为 1', during.debug.phase.waiting, 1)
  check('记下了「见过一次审批」', during.debug.phase.approvalsSeen, 1)
  check('没有 waitErrors', during.debug.phase.waitErrors.length, 0)

  // 用户点了 → 恢复
  release({ kind: 'allow' })
  await running

  const after = await json('/live2d/state')
  // 测试环境里没有 agent 在跑，所以审批结束后落到 idle。
  // 真机上如果 agent 还在跑，会落到 thinking —— 那是 statusSnapshot 的优先级决定的。
  check('审批结束后黄灯熄灭', after.status, 'idle')
  check('计数归零', after.debug.phase.waiting, 0)

  assert('注册了 user-questions/request 监听',
    typeof captured.events.get('user-questions/request') === 'function')

  // next 形状不对时要留痕，而不是静默不亮
  await captured.events.get('approval/request')({ kind: 'approval' })
  const errState = await json('/live2d/state')
  assert('next 不是函数时留下 waitErrors', errState.debug.phase.waitErrors.length >= 1)
}

console.log('\n— 黄灯的第二条路：tools/pre-execute（不依赖审批事件）—')
{
  // 为什么需要这条：审批服务源码里 `decide()` 是
  //   if (policy === 'never') return 'rejected'
  //   const answer = ...waterfall(..., 'approval/request', ...)
  // 策略 never 时那行 waterfall 根本不执行，所以 approval/request 永远不来。
  // tools/pre-execute 在 decide 之前跑，必然跑，且决策形状写死是 gate.kind === 'ask'。
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  assert('监听 tools/pre-execute', src.includes("ctx.on('tools/pre-execute'"))
  assert('决策判定用精确相等', src.includes("if (kind === 'ask')"))
  assert('决策形状有真机证据（kindsSeen）', src.includes('kindsSeen[kind]'))
  assert('关联键是 callId（exec 上没有 id）', src.includes('const key = exec?.callId'))
  assert('tools/result 用 callId 对账', src.includes('const key = exec?.callId\n    if (key !== undefined && pendingAsks.has(key))'))
  assert('有兜底回收，黄灯不会永久卡住', src.includes('reapStaleAsks') && src.includes('ASK_STALE_MS'))

  // ── prepend 是必须的，不是优化 ──────────────────────────────────────────
  // 真实弹审批的是 auto-review，它注释里写着 "prepended per-call review gate"，
  // 返回 {kind:'ask'} 且**不调 next()**。而 waterfall 是
  //     const next = () => (cbs.shift() ?? inner)(...args)
  // —— 前面的人不调 next()，后面的人根本不会被调用。
  // 实测：kindsSeen 攒到 {"allow":141}，141 次真实调用一次 ask 都没有。
  assert('tools/pre-execute 必须 prepend（否则被 auto-review 截断）',
    src.includes("ctx.on('tools/pre-execute', preExecuteAsk, { global: true, prepend: true })"))
  assert('approval/request 也要 prepend（第一个回答者会直接 return）',
    src.includes("{ global: true, prepend: true }"))
  assert('有排序探针复现截断', src.includes('async ordering(mineAhead)'))
  assert('有备用路探针', src.includes('async approvalPath()'))

  await json('/live2d/probe-status?set=clear')
  const before = await json('/live2d/probe-status')
  const seenBefore = before.phase.approvalsSeen

  // 真身监听器：next() 返回 { kind: 'ask' }
  const asked = await json('/live2d/probe-status?set=ask&callId=smoke-1')
  check('ask 决策点亮黄灯', asked.status, 'waiting')
  check('waiting 计数为 1', asked.phase.waiting, 1)
  check('approvalsSeen 递增', asked.phase.approvalsSeen, seenBefore + 1)
  check('pendingAsks 挂着一笔', asked.phase.pendingAsks, 1)

  // 同一次调用重复派发不应重复计数
  const again = await json('/live2d/probe-status?set=ask&callId=smoke-1')
  check('同一 callId 不重复计数', again.phase.waiting, 1)
  check('approvalsSeen 不再涨', again.phase.approvalsSeen, seenBefore + 1)

  // 用户点了 → tools/result 到达 → 黄灯灭
  const settled = await json('/live2d/probe-status?set=ask-settle&callId=smoke-1')
  check('工具结束后黄灯熄灭', settled.phase.waiting, 0)
  check('pendingAsks 清空', settled.phase.pendingAsks, 0)

  // 反向用例：allow 决策绝不能亮灯（否则每个工具调用都会变黄）
  const allowed = await json('/live2d/probe-status?set=ask-allow')
  check('allow 决策不亮黄灯', allowed.phase.waiting, 0)
  check('allow 不计入 approvalsSeen', allowed.phase.approvalsSeen, seenBefore + 1)

  await json('/live2d/probe-status?set=clear')
}

console.log('\n— 桌宠生命周期：谁拉起的谁负责收 —')
{
  // 原先 dispose 时故意不杀桌宠（理由是「它有心跳，DSH 一停就自行退场」）。
  // 那话只对「DSH 整个退出」成立 —— 那时这段代码根本不执行。插件重载时
  // DSH 还活着，心跳不会触发，于是老桌宠留在屏幕上，新的 apply() 又拉起一只，
  // 实测重载两次攒出 pid 24160 + 4188 两个窗口叠在一起。
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  assert('有 stopPet', src.includes('function stopPet()'))
  {
    const from = src.indexOf("ctx.effect(() => {\n    launchPet()")
    const to = src.indexOf('}, \'dsh-live2d: desktop pet\')', from)
    const body = src.slice(from, to)
    assert('dispose 时收掉桌宠', body.includes('stopPet()'))
    assert('dispose 时也收掉语音 worker', body.includes('stopWorker()'))
  }
  assert('杀之前先确认 pid 还是自己的（防 pid 回收误杀）',
    src.includes("out.includes('dsh-pet.ps1')"))
  assert('杀整棵进程树（WebView2 子进程不能留）',
    src.includes("spawn('taskkill', ['/PID', String(pid), '/T', '/F']"))
}

console.log('\n— 思维链要精炼，不是截取 —')
{
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  assert('有精炼函数', src.includes('async function distillReasoning('))
  // 旧做法（从思维链里挑一句贴上去）在气泡路径上必须已经不用了
  {
    const from = src.indexOf('async function speakReasoning(')
    const to = src.indexOf('\n  }', from)
    const body = src.slice(from, to)
    assert('说话走精炼，不走截取', body.includes('await distillReasoning(') && !body.includes('pickReasoningSentence('))
  }
  assert('提示词明确要求「读懂后重新说一遍」', src.includes('读懂之后重新说一遍，不是摘抄原句'))
  assert('提示词要求丢掉自我催促', src.includes('丢掉自我催促'))
  assert('输出要清洗（去引号/前缀）', src.includes('function sanitizeLine('))
  assert('精炼失败就沉默，不贴半句话', src.includes('if (line === null) return false'))
  assert('失败可观测', src.includes('distillFailed'))
  // 诊断端点要能对照「旧做法会截出什么」和「现在会说什么」
  assert('诊断同时给出 picked 与 distilled', src.includes('picked, distilled, spoken'))
}

console.log('\n— 语音：气泡 → 大肥鱼音色 wav → 页面播放 —')
{
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')
  const html = await (await call('/live2d/pet')).body.toString('utf8')

  assert('有语音子系统', src.includes('const SPEECH = {'))
  assert('走 speak.py 流水线', src.includes('speak.py') && src.includes('runSpeechScript'))
  assert('只念最新一条（不排队，避免语音滞后于气泡）', src.includes('speech.pending = standalone'))
  assert('按 mode 过滤', src.includes('SPEECH.modes.includes(message.mode)'))
  assert('可整体关掉', src.includes("(config?.speech ?? 'off') === 'on'"))
  // 明确要求：碎碎念、任务报告、闲聊、自己的想法、状态都要有声音。
  assert('默认全部 mode 都出声（含 status/murmur）',
    src.includes("'reasoning', 'done', 'idle', 'status', 'murmur'"))

  // 实测踩到的错位：合成十几秒，期间气泡换了好几轮，结果嘴念旧句。
  assert('合成后校验气泡是否仍是同一条（防错位）',
    src.includes('state.message.id !== job.id') && src.includes('speech.dropped += 1'))
  assert('错位的音频文件会被删掉', src.includes('unlinkSync(file)'))

  // 音频路由与路径穿越防护
  assert('有音频路由', src.includes("pathname.startsWith('/live2d/audio/')"))
  assert('拒绝非纯文件名（防 ../ 穿越）', src.includes('name !== basename(name)'))
  assert('只接受 .wav', src.includes("name.endsWith('.wav')"))
  assert('音频不缓存（每次不同名）', src.includes("sendFile(res, file, 'no-store')"))

  // 页面播放
  assert('页面有 playAudio', html.includes('function playAudio('))
  assert('按 audio.id 判重（不重播）', html.includes('audio.id === lastAudioId'))
  assert('播放失败不影响画面', html.includes('__lastAudioError'))
  // 音频与气泡是独立通道，不能绑在同一个 revision 上
  assert('音频与气泡各自判重', html.includes('playAudio(s.audio);'))

  assert('有按需诊断端点', src.includes("'/live2d/probe-speak'"))
  assert('debug 暴露语音状态', src.includes('speech.spoken') && src.includes('speech.dropped'))

  // 这条是实测踩出来的：WebView2 默认「没用户手势就不许出声」，
  // 而桌宠是主动说话的，永远等不到那个手势 —— 表现就是画面正常但永远静音。
  // 必须在外壳里放行，否则整条语音链路白做。
  const petShell = readFileSync(join(HERE, '..', 'pet', 'dsh-pet.ps1'), 'utf8')
  assert('外壳放行 WebView2 自动播放',
    petShell.includes('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS') &&
    petShell.includes('--autoplay-policy=no-user-gesture-required'))
  // 别退回 New-Object 那条路：这个 SDK 版本里它没有可用构造函数，会让桌宠直接起不来。
  assert('不用无构造函数的 EnvironmentOptions', !petShell.includes('New-Object Microsoft.Web.WebView2.Core.CoreWebView2EnvironmentOptions'))
  assert('页面把播放结果回报给 Host', src.includes("'/live2d/audio-status'"))

  // 这一轮补的：原先只有四条路径有声音，碎碎念/状态/点击反应都是哑的。
  assert('碎碎念上报给 Host', html.includes('requestMurmurSpeech') && src.includes("'/live2d/murmur'"))
  assert('点击反应也出声', src.includes("mode: 'poke'"))
  // 别把 engine.js 的常量用在 Host 作用域：它们只注入到页面，
  // 在 Host 这边引用是 ReferenceError，会把整条 poke 路由打崩（踩过）。
  {
    const lines = src.split('\n')
    const late = lines.slice(1750).join('\n')
    const stripped = late.replace(/\/\/[^\n]*/g, '')   // 去掉注释再查
    for (const sym of ['REACTION_MODE', 'REACTION_VISIBLE_MS', 'MURMUR_MIN_MS', 'IDLE_MODE', 'MURMURS']) {
      assert(`Host 路由区不引用页面专属常量 ${sym}`, !new RegExp(`\\b${sym}\\b`).test(stripped))
    }
  }
  assert('状态变化也出声（带节流）', src.includes('maybeSpeakStatus') && src.includes('STATUS_SPEECH'))
  // standalone 任务没有气泡可校验，必须跳过防错位检查，否则会被当过期丢掉
  assert('standalone 跳过防错位检查', src.includes("job.standalone !== true"))
  assert('standalone 用自己的 id 判重', src.includes('id: standalone ? job.id : state.revision'))
  // 音频要在每轮轮询都看：碎碎念不推 revision，绑在一起会漏播
  assert('音频每轮轮询都检查（碎碎念不推 revision）',
    src.includes('playAudio(s.audio);') && src.includes('不能只在 revision 变化时看'))

  // 常驻 worker：17s → 5s 的关键
  assert('用常驻语音进程', src.includes('speakViaWorker') && src.includes('ensureWorker'))
  // stderr 不排空会 64KB 填满 → worker 阻塞在写、Host 阻塞在读 → 死锁
  assert('持续排空 worker 的 stderr（防死锁）',
    src.includes("child.stderr.on('data'") && src.includes('必须消费'))
  assert('插件停用收掉 worker（不留孤儿）', src.includes('stopWorker()'))
  // 只杀 Python worker 不够：它还起着常驻 pwsh(SAPI)，Windows 上 kill() 不跑清理，
  // 那个 pwsh 就变孤儿了（实测攒出两个）。必须杀整棵树。
  assert('停用时杀整棵进程树', src.includes("taskkill") && src.includes("'/T', '/F'"))
}

console.log('\n— 任务完成后说话 —')
{
  const html = await (await call('/live2d/pet')).body.toString('utf8')
  const src = readFileSync(join(HERE, '..', 'host.js'), 'utf8')

  assert('页面 LABEL 有 done', /done:\s*'[^']+'/.test(html))

  // 触发点是 running → idle（回合结束），不是等定时器
  assert('有完成说话实现', src.includes('async function speakCompletion'))
  assert('在 agent/status 里检测回合结束', src.includes('turnState.get(key)?.startedAt'))
  assert('running 时记录开始时间', src.includes('turnState.set(key, { startedAt: Date.now() })'))
  assert('idle 时算时长并触发', src.includes('const duration = startedAt === undefined ? COMPLETION.minTurnMs'))
  // 插件可能在回合中途加载，那时 running 事件早已过去 —— 不能因此漏掉整个回合
  assert('时长未知时按「刚好够格」处理（不漏整回合）',
    src.includes('时长取不到时按「刚好够格」处理'))
  assert('加载时给已在跑的 agent 补记开始时间',
    src.includes("turnState.set(String(agent.id), { startedAt: now })") && src.includes("agent?.status === 'running'"))

  // 闸门
  assert('太短的回合不说', /minTurnMs:\s*\d/.test(src) && src.includes('completionStat.skippedShort += 1'))
  assert('有独立的闸门函数', src.includes('function completionDue'))
  assert('共用每小时预算（不会因此变话痨）', src.includes('if (proactive.stamps.length >= PROACTIVE.hourlyBudget) return false'))

  // 提示词必须与「主动说话」不同：松口气/得意，不是汇报
  assert('完成有专门的提示词', src.includes("kind === 'completion'"))
  assert('提示词反对公文腔', src.includes('不要「已完成任务」这种公文腔'))
  assert('提示词要求点到刚做完的事', src.includes('尽量点到刚做完那件事的名字'))
  assert('提示词带上了耗时', src.includes('花了大约') && src.includes('minutes'))

  assert('disposed 时清理计时', src.includes('turnState.delete(String(id))'))

  // 可观测 + 诊断
  assert('debug 暴露完成统计', src.includes('completionStat.detected') && src.includes('skippedShort'))
  assert('有完成诊断端点', src.includes("'/live2d/probe-done'"))
}

console.log('\n— live2d_express —')
const updated = await tool.execute({ text: '  这句话会被 trim  ', emotion: 'happy', mode: 'opinion', sticky: true }, {})
check('工具输出', updated, { ok: true, emotion: 'happy', emotionLabel: '开心', mode: 'opinion', revision: 1 })
check('模型可见文案', tool.output.render({}, updated)[0].type, 'text')

const state = await json('/live2d/state')
check('气泡内容已 trim', state.message.text, '这句话会被 trim')
check('sticky 已记录', state.message.sticky, true)

check('未知表情回落到 neutral', (await tool.execute({ text: 'x', emotion: 'nope', mode: 'nope' }, {})).emotion, 'neutral')

let rejected = false
try { await tool.execute({ text: '   ' }, {}) } catch { rejected = true }
check('空文本被拒绝', rejected, true)

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exitCode = failures === 0 ? 0 : 1
