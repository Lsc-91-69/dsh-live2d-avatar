// pet-coldstart.mjs — 真的把一个桌宠进程冷启动一次，断言它能活到正常收尾。
//
// 为什么必须有这条：
//
//   之前出过一次事故 —— 每次开机都弹「应用程序的组件中发生了未经处理的异常」，
//   原因是点击穿透的计时器写在它要调用的函数**定义之前**。所有静态断言、
//   所有模拟测试都看不见这个 bug，因为：
//     · 热重载时函数早就定义了，根本不会触发；
//     · 模拟测试不真的起进程。
//
//   冷启动是唯一能暴露它的路径。所以这条测试不 mock 任何东西：真的 spawn、
//   真的建窗、真的等它自己走完自检再退出。
//
// 怎么判断「挂住了」：
//   那个 bug 的表现是弹出**模态**对话框 —— 它会卡住 WinForms 的消息循环，
//   于是自检的定时器永远不触发、进程永远不退出。所以「没在限定时间内退出」
//   本身就是失败的判据，不需要额外去检测对话框。
//
// 用法：
//   node test/pet-coldstart.mjs            # 默认自检 5 秒
//   node test/pet-coldstart.mjs --ms=8000
//   非 Windows / 缺 pwsh / 缺 WebView2 时自动 SKIP（CI 在 Linux 上跑）。

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const WV2 = join(ROOT, 'pet', 'lib', 'Microsoft.Web.WebView2.Core.dll')

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]
}))
const PET = args.pet ? join(ROOT, args.pet) : join(ROOT, 'pet', 'dsh-pet.ps1')
const SELFTEST_MS = Number(args.ms) || 5000

let pass = 0, fail = 0
const assert = (name, ok, detail) => {
  if (ok) { pass++; console.log('ok   ' + name) }
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : ' — ' + detail)) }
}

function skip(reason) {
  console.log('SKIP ' + reason)
  process.exit(0)
}

if (process.platform !== 'win32') skip('不是 Windows（桌宠外壳依赖 WebView2 + WinForms）')
if (!existsSync(PET)) skip('找不到 pet/dsh-pet.ps1')
if (!existsSync(WV2)) skip('缺 WebView2 程序集（pet/lib/），先跑一次插件安装')

// pwsh 7 的常见位置
const PWSH = [
  process.env.DSH_PWSH,
  'C:/Program Files/PowerShell/7/pwsh.exe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
].filter(p => p && existsSync(p))[0]
if (!PWSH) skip('找不到 pwsh 7')

// ── 假 DSH：只回答桌宠启动时会打的那几个端点 ──────────────────────────────
const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/live2d/manifest') {
    // ok:true 让外壳继续往下走。modelUrl 故意指向不存在的路径 ——
    // 这条测试验的是**外壳**能不能活下来，不是模型能不能加载。
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, modelUrl: '/no-model.json', expressions: [], motions: [] }))
    return
  }
  if (url === '/live2d/state') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ revision: 1, status: 'idle', message: null, audio: null }))
    return
  }
  if (url === '/live2d/pet') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body style="background:transparent">'
      + '<div id="status"><span id="statusText">待机</span></div>'
      + '<div id="bubble"></div><div id="hint"></div></body></html>')
    return
  }
  res.writeHead(404); res.end()
})

await new Promise(ok => server.listen(0, '127.0.0.1', ok))
const port = server.address().port

// 自检文件路径在外壳里是写死的，先清掉免得读到上一次的残留
const selftestFile = join(tmpdir(), 'dsh-live2d-pet-selftest.txt')
try { rmSync(selftestFile, { force: true }) } catch { }
const logFile = join(tmpdir(), `dsh-live2d-coldstart-${process.pid}.log`)
try { rmSync(logFile, { force: true }) } catch { }

console.log('— 真启动一次桌宠（自检 ' + SELFTEST_MS + 'ms）—')

const child = spawn(PWSH, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', PET,
  '-Url', `http://127.0.0.1:${port}`,
  '-SelfTestMs', String(SELFTEST_MS),
], {
  env: { ...process.env, DSH_LIVE2D_PET_LOG: logFile },
  stdio: 'ignore',
  windowsHide: true,
})

// 超时兜底：正常路径下它会自己在 SelfTestMs + 若干秒内退出
const HARD_TIMEOUT = SELFTEST_MS + 40000
const startedAt = Date.now()

const outcome = await new Promise(resolve => {
  const timer = setTimeout(() => resolve({ kind: 'timeout' }), HARD_TIMEOUT)
  child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ kind: 'exit', code, signal }) })
  child.on('error', (e) => { clearTimeout(timer); resolve({ kind: 'error', error: e.message }) })
})
const elapsed = Date.now() - startedAt

// 兜底：不管怎么结束，把进程树清掉（WebView2 子进程不能留）
try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { }
server.close()

// ── 断言 ────────────────────────────────────────────────────────────────
assert('冷启动后进程自己退出（没卡在模态框里）', outcome.kind === 'exit', JSON.stringify(outcome))
assert('退出码为 0', outcome.kind === 'exit' && outcome.code === 0, outcome.kind === 'exit' ? 'code=' + outcome.code : '')
assert('在合理时间内退出', elapsed < HARD_TIMEOUT, elapsed + 'ms')

const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
assert('写了启动日志', log.length > 0, log.length + ' 字节')
assert('走到了「桌宠已就位」', log.includes('桌宠已就位'))

// 这几条是踩过的坑，任何一条出现都说明又坏了
const BAD = [
  ['未经处理', '未捕获异常（会弹模态框）'],
  ['CommandNotFound', '调用了不存在的函数（计时器早于定义就是这个症状）'],
  ['装界面线程兜底失败', '全局异常兜底没装上'],
  ['界面线程异常', '界面线程里抛过异常（被兜底吞了，但说明有 bug）'],
  ['参数', '启动参数解析失败'],
]
for (const [marker, why] of BAD) {
  assert(`日志里没有「${marker}」`, !log.includes(marker), why)
}

const self = existsSync(selftestFile) ? readFileSync(selftestFile, 'utf8') : ''
assert('自检文件已写出', self.length > 0, self.length + ' 字节')
assert('窗口确实建出来了', self.includes('window='))
if (self.includes('PROBE_FAILED')) assert('DOM 探针没有失败', false, (self.match(/PROBE_FAILED=(.*)/) || [])[1])
else assert('DOM 探针没有失败', self.includes('DOM='))
assert('截图没有失败', !self.includes('CAPTURE_FAILED'), (self.match(/CAPTURE_FAILED=(.*)/) || [])[1])

// DOM 探针里至少应该确认页面跑起来了（PIXI 是 typeof 字符串）
if (self.includes('DOM=')) {
  const raw = self.slice(self.indexOf('DOM=') + 4).split('\n')[0]
  let dom = null
  try { dom = JSON.parse(JSON.parse(raw)) } catch { /* 解析失败下面会报 */ }
  assert('DOM 探针可解析', dom !== null, raw.slice(0, 80))
  if (dom) {
    assert('页面加载的是 /live2d/pet', String(dom.href || '').includes('/live2d/pet'), dom.href)
    // 这里刻意**不**断言 PIXI：本测试喂的是极简假页面，没有 vendor 脚本。
    // 要验的是外壳链路（建窗 → 加载 → 执行 JS → 读回结果）是通的。
    assert('能从页面读回 DOM', typeof dom.statusText === 'string', String(dom.statusText))
  }
}

console.log('')
console.log(pass + ' 通过 / ' + fail + ' 失败')
try { rmSync(logFile, { force: true }) } catch { }
process.exit(fail === 0 ? 0 : 1)

