/**
 * 缩放适配的回归测试：直接取 `engine.js` 里 `#region fit-math` 的真实源码求值，
 * 不是复制一份出来测。
 *
 *     node test/zoom-fit.mjs
 *
 * 回归的是这个缺陷：适配时用了 canvas 的物理像素（`renderer.width` = CSS 宽 × resolution），
 * 而 resolution 取自 devicePixelRatio —— 于是模型大小随浏览器缩放漂移，
 * 出现「90% 正常、100% 过大」。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, '..', 'engine.js'), 'utf8')

const START = '// #region fit-math'
const END = '// #endregion fit-math'
const from = source.indexOf(START)
const to = source.indexOf(END)
if (from < 0 || to < 0) {
  console.error('找不到 fit-math 区块：engine.js 里的 #region 标记被改动了')
  process.exit(1)
}
const region = source.slice(from + START.length, to)
// 区块里只有常量与函数声明，没有浏览器 API，可以直接求值。
const { FILL, viewportOf, intrinsicSize, computeFit } =
  new Function(`${region}\nreturn { FILL, viewportOf, intrinsicSize, computeFit };`)()

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const near = (label, actual, expected, tolerance = 1e-9) => {
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${actual}, want ${expected}`}`)
}

// 一个假模型：固有 1200×1500 的舞台尺寸，与容器 scale 无关。
const model = { internalModel: { width: 1200, height: 1500 }, width: 1200, height: 1500 }
// 一个假 Application：canvas 后备缓冲是物理像素，screen 是逻辑像素。
const appAt = (cssWidth, cssHeight, resolution) => ({
  renderer: {
    width: cssWidth * resolution,
    height: cssHeight * resolution,
    screen: { width: cssWidth, height: cssHeight },
  },
})

console.log('— 视口必须取 CSS 逻辑像素，而不是 canvas 后备缓冲 —')
const host = { clientWidth: 300, clientHeight: 330 }
const physical = appAt(300, 330, 1.25)
check('host 存在时用 host 的 CSS 尺寸', viewportOf(physical, host), { width: 300, height: 330 })
check('没有 host 时退回 renderer.screen', viewportOf(physical, null), { width: 300, height: 330 })
check('renderer.width 确实是物理像素（说明为何不能用它）', [physical.renderer.width, physical.renderer.height], [375, 412.5])

console.log('\n— 固有尺寸不随容器 scale 变化（fit 必须幂等）—')
check('scale=1 时的固有尺寸', intrinsicSize(model), { width: 1200, height: 1500 })
// PIXI 的 Container.width 会乘上 scale：模拟 fit 之后的模型对象。
const scaled = { internalModel: { width: 1200, height: 1500 }, width: 1200 * 0.22, height: 1500 * 0.22 }
check('scale 之后依然读到固有尺寸', intrinsicSize(scaled), { width: 1200, height: 1500 })
const noInternal = { width: 640, height: 800 }
check('缺少 internalModel 时退回 model.width', intrinsicSize(noInternal), { width: 640, height: 800 })

console.log('\n— 各种缩放级别下，模型尺寸必须完全一致 —')
const hostSize = { clientWidth: 300, clientHeight: 330 }
// 现实场景：操作系统 125% 缩放，浏览器再缩放 zoom。
// 于是 100% 时 dpr = 1.25，80% 时 dpr = 1.0，90% 时 dpr = 1.125 —— dpr 在 1 两侧都有。
const OS_SCALE = 1.25
const zooms = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 3]
const scales = []
const legacyScales = []
for (const zoom of zooms) {
  const dpr = OS_SCALE * zoom
  const viewport = viewportOf(appAt(hostSize.clientWidth, hostSize.clientHeight, dpr), hostSize)
  const fit = computeFit(1200, 1500, viewport.width, viewport.height, FILL)
  scales.push(fit.scale)
  // 修复前的算法：拿 canvas 物理像素适配，并额外乘 1.06。
  const legacy = Math.min(
    hostSize.clientWidth * dpr / 1200,
    hostSize.clientHeight * dpr / 1500,
  ) * 1.06
  legacyScales.push(legacy)
  const overflow = legacy / (Math.min(300 / 1200, 330 / 1500))
  console.log(`     zoom ${String(Math.round(zoom * 100)).padStart(3)}%  dpr ${dpr.toFixed(3)}  → scale ${fit.scale.toFixed(6)}   （修复前 ${legacy.toFixed(6)}，即 contain 的 ${(overflow * 100).toFixed(0)}%）`)
}
const first = scales[0]
check('所有缩放级别下 scale 相同', scales.every(scale => Math.abs(scale - first) < 1e-12), true)
const uniqueLegacy = new Set(legacyScales.map(scale => scale.toFixed(6)))
check('对照：修复前的 scale 随缩放漂移（说明本测试能抓到这个 bug）', uniqueLegacy.size > 1, true)
check('对照：修复前在 90% 与 100% 明显不同', Math.abs(legacyScales[3] - legacyScales[4]) > 1e-6, true)

console.log('\n— contain 保证：模型不越出视口 —')
const fit = computeFit(1200, 1500, 300, 330, FILL)
near('scale = min(300/1200, 330/1500)', fit.scale, Math.min(300 / 1200, 330 / 1500))
near('缩放后的宽 ≤ 视口宽', 1200 * fit.scale, 264)
near('缩放后的高 ≤ 视口高', 1500 * fit.scale, 330)
check('中心点 = 视口中心', [fit.x, fit.y], [150, 165])

console.log('\n— 填满比例只是缩放系数 —')
near('FILL=2 时 scale 翻倍', computeFit(1200, 1500, 300, 330, 2).scale, fit.scale * 2)

console.log('\n— 退化输入不产生 NaN / 负值 —')
const degenerate = [
  intrinsicSize({ internalModel: { width: 0, height: 0 }, width: 0, height: 0 }),
  intrinsicSize({}),
  viewportOf(null, null),
]
check('零尺寸回落为 1', degenerate[0], { width: 1, height: 1 })
check('空对象回落为 1', degenerate[1], { width: 1, height: 1 })
check('无 app / host 时视口为 0（调用方会跳过这一帧）', degenerate[2], { width: 0, height: 0 })

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exitCode = failures === 0 ? 0 : 1
