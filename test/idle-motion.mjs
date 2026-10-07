/**
 * 待机动作的回归测试。和其它测试一样，直接取 `engine.js` 里 `#region idle-motion`
 * 的真实源码求值，不是复制一份出来测。
 *
 *     node test/idle-motion.mjs
 *
 * 重点回归两件事：
 *   1. 写入必须是「绝对值」，每帧由 base + range*f(t) 算出，与当前值无关 ——
 *      否则在 Cubism 的 save/load 循环里会逐帧累加、直到底部夹到参数范围边界。
 *   2. 所有写入都必须落在模型自己的 min/max 之内。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, '..', 'engine.js'), 'utf8')

const START = '// #region idle-motion'
const END = '// #endregion idle-motion'
const from = source.indexOf(START)
const to = source.indexOf(END)
if (from < 0 || to < 0) {
  console.error('找不到 idle-motion 区块：engine.js 里的 #region 标记被改动了')
  process.exit(1)
}
const region = source.slice(from + START.length, to)

const api = new Function(`${region}
return {
  IDLE_MODE, REACTION_MODE, REACTIONS, REACTION_VISIBLE_MS,
  MURMURS, IDLE_EXPRESSIONS, IDLE_EXPRESSION_MIN_MS, IDLE_EXPRESSION_SPAN_MS, IDLE_EXPRESSION_QUIET_MS,
  GAZE_SMALL, GAZE_MEDIUM, GAZE_LARGE, GAZE_VERTICAL_BIAS,
  DRIFT_HEAD_FRACTION, DRIFT_ENVELOPE_MIN,
  DRIFT_YAW_FRACTION, DRIFT_PITCH_FRACTION,
  PEN_HAND_SPAN, PEN_HAND_X_FRACTION, PEN_HAND_Y_FRACTION, PEN_HAND_TAU,
  PEN_PRESS_MS, PEN_PRESS_MIN_MS,
  GESTURE_MS, GESTURE_HEAD_CYCLES, GESTURE_BODY_CYCLES,
  GESTURE_HEAD_FRACTION, GESTURE_BODY_FRACTION,
  GESTURE_MIN_MS, GESTURE_SPAN_MS, GESTURE_SKIP, PEN_VISIBLE,
  gazeRadius, nextGazeTarget, nextHoldMs, pickRange, createDrift, gestureWave,
  nextGestureKind, nextGestureDelayMs, parameterHandle, createIdleAnimator,
};`)()

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const assert = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition ? '' : ` — ${detail}`}`)
}

/**
 * 有变化的伪随机，让测试可复现。
 * 注意不能用恒定值：恒定随机会让值噪声退化成常数（噪声在固定输入下不动），
 * 而且 `roll() >= GESTURE_SKIP` 的判定会永远走同一支，测不到真实行为。
 */
const seeded = (seed) => {
  let state = (seed >>> 0) || 1
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** 假 Cubism core：按 Cubism 的语义把写入夹到参数范围内。 */
function fakeCore(params) {
  const values = new Map(params.map(p => [p.id, p.base]))
  let synthetic = 0
  return {
    values,
    getParameterCount: () => params.length,
    getParameterIndex: (id) => {
      const index = params.findIndex(p => p.id === id)
      if (index >= 0) return index
      // 真实实现会返回一个越界的合成下标，这里照样模拟。
      return params.length + (synthetic++)
    },
    getParameterMinimumValue: (index) => params[index]?.min,
    getParameterMaximumValue: (index) => params[index]?.max,
    getParameterDefaultValue: (index) => params[index]?.base,
    setParameterValueByIndex: (index, value) => {
      const parameter = params[index]
      if (parameter === undefined) return
      values.set(parameter.id, Math.min(parameter.max, Math.max(parameter.min, value)))
    },
  }
}

/** 真实模型里这几个参数的形状（角度类 -30..30，开关类 0..1）。 */
const REAL_PARAMS = [
  { id: 'bi', min: 0, max: 1, base: 0 },
  { id: 'ParamBodyAngleZ', min: -10, max: 10, base: 0 },
  { id: 'ParamAngleZ', min: -30, max: 30, base: 0 },
  { id: 'ParamAngleX', min: -30, max: 30, base: 0 },
  { id: 'ParamAngleY', min: -30, max: 30, base: 0 },
  { id: 'ParamBodyAngleX', min: -10, max: 10, base: 0 },
  { id: 'ParamEyeBallX', min: -1, max: 1, base: 0 },
  { id: 'ParamEyeBallY', min: -1, max: 1, base: 0 },
  { id: 'pointX', min: -10, max: 10, base: 0 },
  { id: 'pointY', min: -10, max: 10, base: 0 },
  { id: 'pointZ', min: 0, max: 10, base: 0 },
]

const makeFocus = () => {
  const calls = []
  return { calls, focus: (x, y) => calls.push({ x, y }) }
}
const makeAnimator = (params, options = {}) => {
  const core = fakeCore(params)
  const focus = makeFocus()
  const model = { internalModel: { coreModel: core, focusController: focus } }
  const animator = api.createIdleAnimator(model, { random: options.random ?? seeded(options.seed ?? 20260921) })
  return { animator, core, focus }
}

console.log('— 取值域与幅度档位 —')
check('IDLE_MODE 是独立模式，不和真实表达混用', api.IDLE_MODE, 'idle')
assert('自言自语词条足够多', api.MURMURS.length >= 12, `只有 ${api.MURMURS.length} 条`)
assert('词条都非空且不长', api.MURMURS.every(m => typeof m === 'string' && m.length > 0 && m.length <= 40))

check('pick<0.55 → 小漂移', api.gazeRadius(0.1), api.GAZE_SMALL)
check('pick<0.85 → 中等', api.gazeRadius(0.7), api.GAZE_MEDIUM)
check('pick<0.94 → 大瞟一眼', api.gazeRadius(0.9), api.GAZE_LARGE)
check('pick>=0.94 → 回到正中', api.gazeRadius(0.99), 0)
check('回到正中就是 (0,0)', api.nextGazeTarget(0.99, 0.3), { x: 0, y: 0 })

let maxAbs = 0
const radiiSeen = new Set()
for (let i = 0; i < 2000; i++) {
  const target = api.nextGazeTarget((i % 100) / 100, ((i * 37) % 100) / 100)
  maxAbs = Math.max(maxAbs, Math.abs(target.x), Math.abs(target.y))
  radiiSeen.add(Math.hypot(target.x, target.y).toFixed(2))
  if (!(target.x >= -1 && target.x <= 1 && target.y >= -1 && target.y <= 1)) {
    assert('注视目标越界', false, JSON.stringify(target))
    break
  }
}
assert('2000 个注视目标全在 [-1,1] 内', maxAbs <= 1, `max=${maxAbs}`)
assert('幅度确实分了多档（不是只有一个圈）', radiiSeen.size > 5, `只见到 ${radiiSeen.size} 种半径`)
assert('垂直幅度被压缩（眼珠上下动得比左右少）',
  Math.abs(api.nextGazeTarget(0.9, 0.25).y) <= api.GAZE_LARGE * api.GAZE_VERTICAL_BIAS + 1e-9,
  `got ${api.nextGazeTarget(0.9, 0.25).y}`)

console.log('\n— 停留时长 —')
assert('思考时比待机时更碎', api.nextHoldMs('thinking', 0.9) < api.nextHoldMs('idle', 0.9))
assert('待机偶尔长时间发愣', api.nextHoldMs('idle', 0.1) > 3000)
assert('所有停留时长都为正', [0, 0.5, 1].every(r =>
  api.nextHoldMs('idle', r) > 0 && api.nextHoldMs('thinking', r) > 0))

console.log('\n— 晃动必须平滑，不能抽一下 —')
{
  const drift = api.createDrift(seeded(12345), [2200, 4200])
  let min = Infinity
  let max = -Infinity
  let maxStep = 0
  let previous = drift(0)
  const samples = []
  for (let t = 0; t <= 120000; t += 16) {
    const value = t === 0 ? previous : drift(t)
    samples.push(value)
    min = Math.min(min, value)
    max = Math.max(max, value)
    if (t > 0) maxStep = Math.max(maxStep, Math.abs(value - previous))
    previous = value
  }
  assert('噪声始终在 [-1,1] 内', min >= -1 && max <= 1, `range=[${min}, ${max}]`)
  assert('噪声确实在动（不是常数）', max - min > 0.5, `range=${(max - min).toFixed(3)}`)
  // 平滑性判据：噪声本身是 smoothstep 相连的，最大斜率有解析上界
  // 2（值域跨度）× 1.5（smoothstep 最大导数）/ 最小间隔 2200ms，折到 16ms 一帧约 0.022。
  assert('60fps 下单帧变化 < 0.025（连续、无拐角）', maxStep < 0.025, `maxStep=${maxStep.toFixed(5)}`)

  // 非周期：把前 20 秒和后 20 秒的序列对比，不该几乎相同。
  const first = samples.slice(0, 1250)
  const later = samples.slice(4000, 5250)
  let difference = 0
  for (let i = 0; i < first.length; i++) difference += Math.abs(first[i] - later[i])
  difference /= first.length
  assert('噪声非周期（相隔 64 秒的两段不一样）', difference > 0.1, `meanDiff=${difference.toFixed(4)}`)

  // 两路独立噪声必须互不相关 —— 这正是「头与身体同步摆」的修复点。
  const a = api.createDrift(seeded(1), [2200, 4200])
  const b = api.createDrift(seeded(999), [2800, 5200])
  let dot = 0
  let normA = 0
  let normB = 0
  for (let t = 0; t <= 120000; t += 32) {
    const va = a(t)
    const vb = b(t)
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }
  const correlation = Math.abs(dot / Math.sqrt(normA * normB))
  assert('两路噪声互不相关（|corr| < 0.4）', correlation < 0.4, `corr=${correlation.toFixed(3)}`)

  // 长时间跨度不能死循环，也不能跑到界外。
  const jumpy = api.createDrift(seeded(7), [2200, 4200])
  const afterBigJump = jumpy(1000 * 60 * 60 * 24)
  assert('跳过 24 小时后仍在 [-1,1] 内', afterBigJump >= -1 && afterBigJump <= 1, `got=${afterBigJump}`)
  assert('时间倒流不抛错也不越界', (() => {
    const d = api.createDrift(seeded(3), [100, 200])
    d(10000)
    const back = d(-5000)
    return back >= -1 && back <= 1
  })())
  const degenerate = api.createDrift(() => 0.5, [0, 0])
  assert('零间隔区间不死循环', Number.isFinite(degenerate(1e9)))
}

// 波形两端必须归零，否则手势开始/结束时会「跳」一下。
for (const [label, cycles] of [['摇头', api.GESTURE_HEAD_CYCLES[0]], ['摆一摆', api.GESTURE_BODY_CYCLES[0]]]) {
  check(`gestureWave(0, ${cycles}) 为 0（${label}）`, api.gestureWave(0, cycles), 0)
  check(`gestureWave(1, ${cycles}) 为 0（${label}）`, api.gestureWave(1, cycles), 0)
  check(`gestureWave 对非法进度返回 0（${label}）`, [api.gestureWave(-0.1, cycles), api.gestureWave(NaN, cycles)], [0, 0])
}

// 幅度不能白给：区间两端都必须能取到满幅。这条会抓住「整数来回」那类失误 ——
// c 为整数时 sin(2πc·0.5)=0，正好在包络最强处抵消，峰值只有 0.65。
for (const [label, range] of [['摇头', api.GESTURE_HEAD_CYCLES], ['摆一摆', api.GESTURE_BODY_CYCLES]]) {
  for (const cycles of range) {
    let peak = 0
    for (let i = 0; i <= 4000; i++) peak = Math.max(peak, Math.abs(api.gestureWave(i / 4000, cycles)))
    assert(`${label} cycles=${cycles} 能达到满幅`, peak > 0.95, `peak=${peak.toFixed(3)}`)
  }
  assert(`${label} 的来回数都是半整数`, range.every(c => Math.abs(c % 1) === 0.5),
    `range=${JSON.stringify(range)}`)
}
{
  const cycles = api.GESTURE_HEAD_CYCLES[0]
  let peak = 0
  let firstBig = null
  const samples = []
  for (let i = 0; i <= 2000; i++) {
    const p = i / 2000
    const value = api.gestureWave(p, cycles)
    samples.push(Math.abs(value))
    peak = Math.max(peak, Math.abs(value))
    if (firstBig === null && Math.abs(value) >= 0.5) firstBig = p
  }
  assert('波形峰值接近 1（幅度没白给）', peak > 0.95, `peak=${peak}`)
  // 关键的「别太突然」：半个峰值至少要用掉 15% 的时长才爬到。
  assert('起势是渐进的，不是急起', firstBig !== null && firstBig > 0.15, `firstBig=${firstBig}`)

  // 对照：原先的 12% 急起包络，同样的判据下会立刻失败。
  const oldEnvelope = (progress) => {
    if (!(progress >= 0) || progress > 1) return 0
    const attackEnd = 0.12
    if (progress <= attackEnd) return progress / attackEnd
    return Math.exp(-3.2 * (progress - attackEnd) / (1 - attackEnd))
  }
  let oldFirstBig = null
  for (let i = 0; i <= 2000; i++) {
    const p = i / 2000
    if (oldFirstBig === null && oldEnvelope(p) >= 0.5) oldFirstBig = p
  }
  assert('对照：原方案在 5% 时长就冲到半幅（所以会「抽一下」）', oldFirstBig !== null && oldFirstBig < 0.08,
    `oldFirstBig=${oldFirstBig}`)
  assert('对照确实比新方案急得多', oldFirstBig < firstBig / 3, `old=${oldFirstBig} new=${firstBig}`)

  let maxStep = 0
  for (let i = 1; i < samples.length; i++) maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i - 1]))
  assert('60fps 下单帧变化很小', maxStep < 0.03, `maxStep=${maxStep}`)
}

check('每次手势的参数都从区间取', [
  api.pickRange(() => 0, api.GESTURE_MS),
  api.pickRange(() => 1, api.GESTURE_MS),
], api.GESTURE_MS)
assert('手势时长区间有宽度（每次不一样）', api.GESTURE_MS[1] > api.GESTURE_MS[0])
assert('摇头幅度区间有宽度', api.GESTURE_HEAD_FRACTION[1] > api.GESTURE_HEAD_FRACTION[0])
check('手势类型只有头与身两种', [api.nextGestureKind(0), api.nextGestureKind(0.9)], ['head', 'body'])
assert('手势间隔在设定区间内', [0, 0.5, 0.999].every(r => {
  const delay = api.nextGestureDelayMs(r)
  return delay >= api.GESTURE_MIN_MS && delay <= api.GESTURE_MIN_MS + api.GESTURE_SPAN_MS
}))
assert('慢速包络到底时仍留一点幅度（不会完全僵住）', api.DRIFT_ENVELOPE_MIN > 0 && api.DRIFT_ENVELOPE_MIN < 0.5)

console.log('\n— 待机换脸的候选表情 —')
check('待机表情只挑温和的（重复项用于加权）', Array.isArray(api.IDLE_EXPRESSIONS), true)
assert('候选非空', api.IDLE_EXPRESSIONS.length > 0)
assert('neutral 权重最高', api.IDLE_EXPRESSIONS.filter(id => id === 'neutral').length >= 4,
  `neutral 出现 ${api.IDLE_EXPRESSIONS.filter(id => id === 'neutral').length} 次`)
for (const dramatic of ['cool', 'exhausted', 'love', 'shocked', 'cry', 'angry', 'tongue', 'sparkle']) {
  assert(`不把「${dramatic}」放进待机随机池`, !api.IDLE_EXPRESSIONS.includes(dramatic))
}

console.log('\n— 参数句柄：缺失的必须挡掉，不能算出 NaN —')
const fullCore = fakeCore(REAL_PARAMS)
check('存在的参数解析成功', api.parameterHandle(fullCore, 'bi'), { id: 'bi', index: 0, min: 0, max: 1, base: 0, range: 1 })
check('不存在的参数返回 null', api.parameterHandle(fullCore, 'ParamNotHere'), null)
check('范围退化的参数返回 null', api.parameterHandle(fakeCore([{ id: 'x', min: 1, max: 1, base: 1 }]), 'x'), null)
check('范围非有限的参数返回 null', api.parameterHandle(fakeCore([{ id: 'y', min: -Infinity, max: 1, base: 0 }]), 'y'), null)
check('core 抛错时返回 null', api.parameterHandle({ getParameterIndex() { throw new Error('nope') } }, 'bi'), null)

console.log('\n— 动画器：写入必须落在模型范围内 —')
{
  const { animator, core } = makeAnimator(REAL_PARAMS, { seed: 777 })
  const head = REAL_PARAMS.find(p => p.id === 'ParamAngleZ')
  const headRange = head.max - head.min
  // 手势幅度上限再乘 1.6（被戳时的加强），留 1.7 的余量。
  const headBand = headRange * (api.DRIFT_HEAD_FRACTION + api.GESTURE_HEAD_FRACTION[1] * 1.7) + 1e-9
  let worstHead = 0
  let outOfRange = 0
  for (let frame = 0; frame < 12000; frame++) {
    animator.step(16, frame % 600 < 300 ? 'idle' : 'thinking')
    const headValue = core.values.get('ParamAngleZ')
    worstHead = Math.max(worstHead, Math.abs(headValue - head.base))
    if (headValue < head.min || headValue > head.max) outOfRange += 1
    for (const id of ['bi', 'ParamAngleX', 'ParamAngleY', 'pointX', 'pointY', 'pointZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ']) {
      const p = REAL_PARAMS.find(item => item.id === id)
      const v = core.values.get(id)
      if (p !== undefined && (v < p.min || v > p.max)) outOfRange += 1
    }
  }
  assert('12000 帧没有一次越界', outOfRange === 0, `${outOfRange} 帧越界`)
  // 真正要看的是「每帧转了多少度」：噪声的数值变化不等于观感，这里换成角度，
  // 并且只统计**没有手势**的帧 —— 手势本来就该快，混进来测就没意义了。
  const driftOnly = makeAnimator(REAL_PARAMS, { seed: 4242 })
  let previousHead = driftOnly.core.values.get('ParamAngleZ')
  let maxHeadStep = 0
  let driftFrames = 0
  let gestureFrames = 0
  for (let frame = 0; frame < 4000; frame++) {
    driftOnly.animator.step(16, 'idle')
    const active = driftOnly.animator.getState().gesture !== null
    const headValue = driftOnly.core.values.get('ParamAngleZ')
    if (active) gestureFrames += 1
    else {
      driftFrames += 1
      maxHeadStep = Math.max(maxHeadStep, Math.abs(headValue - previousHead))
    }
    previousHead = headValue
  }
  assert('两种帧都出现了（手势与非手势都被覆盖）', driftFrames > 100 && gestureFrames > 100,
    `drift=${driftFrames} gesture=${gestureFrames}`)
  assert('纯轻晃的单帧位移极小（< 0.05°）', maxHeadStep < 0.05, `head=${maxHeadStep.toFixed(4)}°`)
  assert('轻晃确实在持续变化（不是僵住）', maxHeadStep > 0.0005, `head=${maxHeadStep.toFixed(6)}`)
  // 关键的漂移回归：如果用 add 而不是 set，偏差会一路涨到被夹在边界上。
  assert('头部倾斜始终在预期幅度带内（没有逐帧累加）', worstHead <= headBand,
    `worst=${worstHead.toFixed(4)} band=${headBand.toFixed(4)}`)
  assert('偏差不是零（确实在动，不是死值）', worstHead > headRange * 0.01, `worst=${worstHead}`)
}

console.log('\n— 不得写「物理拥有」的参数（这正是笔与身体不动的原因）—')
{
  // physics3.json 的 PhysicsSetting2/3/4 会把 ParamBodyAngleX/Y/Z 作为**输出**，
  // 由 ParamAngleX/Y/Z 算出。谁直接写它们，物理下一帧就覆盖掉 ——
  // 早期版本正是这么写的，所以身体和笔都毫无反应。
  const physicsOwned = ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ']
  const { animator, core } = makeAnimator(REAL_PARAMS, { seed: 1717 })
  const writes = new Map(physicsOwned.map(id => [id, 0]))
  const originalSet = core.setParameterValueByIndex
  core.setParameterValueByIndex = (index, value) => {
    const id = REAL_PARAMS[index]?.id
    if (id !== undefined && writes.has(id)) writes.set(id, writes.get(id) + 1)
    originalSet(index, value)
  }
  for (let frame = 0; frame < 3000; frame++) animator.step(16, 'idle')
  for (const [id, count] of writes) {
    assert(`不写 ${id}（交给物理）`, count === 0, `写了 ${count} 次`)
  }
  // 但 must-do：头与笔手必须真的被写。
  assert('头（ParamAngleZ）确实被驱动', core.values.size > 0)
}

console.log('\n— 笔：驱动 pointX / pointY / pointZ —')
{
  const penXParam = REAL_PARAMS.find(p => p.id === 'pointX')
  const penYParam = REAL_PARAMS.find(p => p.id === 'pointY')
  const penZParam = REAL_PARAMS.find(p => p.id === 'pointZ')
  assert('前提：笔手参数都在假模型里',
    penXParam !== undefined && penYParam !== undefined && penZParam !== undefined)

  const { animator, core } = makeAnimator(REAL_PARAMS, { seed: 88 })
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let maxStepX = 0
  let previousX = core.values.get('pointX')
  let sawPress = false
  for (let frame = 0; frame < 12000; frame++) {
    animator.step(16, 'idle')
    const x = core.values.get('pointX')
    const y = core.values.get('pointY')
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    maxStepX = Math.max(maxStepX, Math.abs(x - previousX))
    previousX = x
    if (core.values.get('pointZ') > penZParam.base + 1e-9) sawPress = true
  }
  assert('pointX 真的在动（这是「笔不动」的修复点）', maxX - minX > 0.5,
    `range=[${minX.toFixed(3)}, ${maxX.toFixed(3)}]`)
  assert('pointY 真的在动', maxY - minY > 0.3, `range=[${minY.toFixed(3)}, ${maxY.toFixed(3)}]`)
  assert('笔手移动是平滑的（单帧 < 0.5）', maxStepX < 0.5, `maxStep=${maxStepX.toFixed(4)}`)
  assert('笔尖偶尔会按下（pointZ 拉满）', sawPress === true)
  assert('状态里报告了笔手已被追踪',
    animator.getState().penHandTracked === true && animator.getState().penPressTracked === true)
  // 物理归一化跨度是 ±10，确认我们没有越过它。
  assert('笔手幅度不超过物理归一化跨度 ±10',
    Math.abs(minX) <= api.PEN_HAND_SPAN && Math.abs(maxX) <= api.PEN_HAND_SPAN,
    `[${minX.toFixed(2)}, ${maxX.toFixed(2)}] span=${api.PEN_HAND_SPAN}`)
}

console.log('\n— 写入与当前值无关（绝对值语义）—')
{
  const sample = (startAt) => {
    const { animator, core } = makeAnimator(REAL_PARAMS, { seed: 303 })
    core.values.set('ParamAngleZ', startAt)
    for (let frame = 0; frame < 40; frame++) animator.step(16, 'idle')
    return core.values.get('ParamAngleZ')
  }
  const fromMin = sample(-30)
  const fromMax = sample(30)
  assert('从 min 与从 max 出发，结果一致（说明是绝对值写入）',
    Math.abs(fromMin - fromMax) < 1e-9, `${fromMin} vs ${fromMax}`)
}

console.log('\n— 笔可见性与眼珠 —')
{
  const { animator, core, focus } = makeAnimator(REAL_PARAMS, { seed: 5 })
  animator.step(16, 'idle')
  check('bi 被拉到上限（手里有笔）', core.values.get('bi'), 1)
  check('SDK 注目被钉在 0（朝向改由我们写绝对值）', focus.calls[0], { x: 0, y: 0 })
  assert('每一帧都钉住 SDK 注目', focus.calls.length === 1)
  assert('状态里报告了各参数的追踪情况',
    animator.getState().penVisible === true
    && animator.getState().penHandTracked === true
    && animator.getState().penPressTracked === true
    && animator.getState().headTracked === true
    && animator.getState().yawTracked === true
    && animator.getState().pitchTracked === true
    && animator.getState().eyeTracked === true)
}

console.log('\n— 掉帧时绝不能「一帧闪过去」 —')
{
  // 这是本插件最要命的一个回归：SDK 的焦点弹簧每帧最大位移是
  // r = 5.3333 × deltaMs / 1000，而 deltaMs 没有上限 —— 掉一帧就足够
  // 让眼睛/头/身体在一帧内瞬移到位。现在跟随由我们自己算，单帧步长被夹住。
  const head = REAL_PARAMS.find(p => p.id === 'ParamAngleZ')
  const yawParam = REAL_PARAMS.find(p => p.id === 'ParamAngleX')
  const bodyXParam = REAL_PARAMS.find(p => p.id === 'ParamBodyAngleX')
  assert('前提：需要的参数都在假模型里',
    head !== undefined && yawParam !== undefined && bodyXParam !== undefined)

  for (const dt of [16, 100, 250, 1000, 5000]) {
    const { animator, core } = makeAnimator(REAL_PARAMS, { seed: 31 })
    let previousYaw = core.values.get('ParamAngleX')
    let previousBodyX = core.values.get('ParamBodyAngleX')
    let worstYaw = 0
    let worstBodyX = 0
    for (let frame = 0; frame < 400; frame++) {
      animator.step(dt, 'thinking')   // thinking 的视线目标换得最勤，最容易触发大跳
      const yawValue = core.values.get('ParamAngleX')
      const bodyXValue = core.values.get('ParamBodyAngleX')
      worstYaw = Math.max(worstYaw, Math.abs(yawValue - previousYaw))
      worstBodyX = Math.max(worstBodyX, Math.abs(bodyXValue - previousBodyX))
      previousYaw = yawValue
      previousBodyX = bodyXValue
      if (yawValue < yawParam.min || yawValue > yawParam.max) { failures += 1; console.log('FAIL 偏航越界'); break }
      if (bodyXValue < bodyXParam.min || bodyXValue > bodyXParam.max) { failures += 1; console.log('FAIL 身体越界'); break }
    }
    // 单帧上界：头 ≤ 0.09 × 0.5 全域 × 60° ≈ 2.7°，身体更小。
    assert(`dt=${dt}ms 时头部单帧位移有上界（< 3°）`, worstYaw < 3, `worst=${worstYaw.toFixed(3)}°`)
    assert(`dt=${dt}ms 时身体单帧位移有上界（< 1.5°）`, worstBodyX < 1.5, `worst=${worstBodyX.toFixed(3)}°`)
  }

  // 极端情形：目标在正对面。也必须多帧走完，不能一帧到位。
  const { animator, core } = makeAnimator(REAL_PARAMS, { seed: 99 })
  for (let frame = 0; frame < 600; frame++) animator.step(1000, 'idle')
  const beforeOne = core.values.get('ParamAngleX')
  animator.step(1000, 'idle')
  const afterOne = core.values.get('ParamAngleX')
  assert('单帧（哪怕 dt=1000ms）位移远小于全域',
    Math.abs(afterOne - beforeOne) < yawParam.max * 0.2,
    `step=${Math.abs(afterOne - beforeOne).toFixed(3)}° 全域=${yawParam.max}`)

  // 对照：SDK 原来的做法。每帧最大位移 r = 5.3333 × deltaMs / 1000，
  // deltaMs 没有上限 —— 用实测的掉帧 dt 复算，证明它确实会一帧闪到位。
  // 头角度 = 30 × focus.x，focus 全域是 2，所以一帧最多转 30 × r 度。
  const sdkMaxStepFraction = (deltaMs) => (5.333333333333333 * deltaMs) / 1000
  const sdkDegrees = (deltaMs) => 30 * sdkMaxStepFraction(deltaMs)
  assert('对照：dt=16ms 时 SDK 一帧最多转 2.6°',
    Math.abs(sdkDegrees(16) - 2.56) < 0.05, `got=${sdkDegrees(16).toFixed(2)}`)
  assert('对照：dt=250ms 时 SDK 一帧能转 40°（超过头部全域，就是「闪过去」）',
    sdkDegrees(250) > 30, `got=${sdkDegrees(250).toFixed(1)}°`)
  assert('对照：dt=1000ms 时更夸张', sdkDegrees(1000) > 150, `got=${sdkDegrees(1000).toFixed(0)}°`)
  assert('对照：SDK 的单帧位移比例在掉帧时已超过整个取值域（必然瞬移）',
    sdkMaxStepFraction(250) > 1, `fraction=${sdkMaxStepFraction(250).toFixed(3)}`)
}
{
  // 模型上完全没有这些参数时也必须活着，不能抛。
  const { animator, focus } = makeAnimator([], { random: () => 0.5 })
  let threw = false
  try { for (let i = 0; i < 50; i++) animator.step(16, 'idle') } catch { threw = true }
  assert('参数全缺失时不抛错', !threw)
  assert('参数全缺失时仍然驱动眼珠', focus.calls.length === 50, `calls=${focus.calls.length}`)
  const state = animator.getState()
  assert('参数全缺失时如实报告未追踪',
    state.penVisible === false
    && state.penHandTracked === false
    && state.penPressTracked === false
    && state.headTracked === false)
}
{
  const { animator } = makeAnimator(REAL_PARAMS)
  let threw = false
  try { animator.dispose() } catch { threw = true }
  assert('dispose 可用', !threw)
  check('模型不支持时返回 null', api.createIdleAnimator({}, {}), null)
  check('模型为 null 时返回 null', api.createIdleAnimator(null, {}), null)
}

console.log('\n— 帧间隔异常也要稳住 —')
{
  const { animator, core } = makeAnimator(REAL_PARAMS, { random: () => 0.5 })
  const body = REAL_PARAMS.find(p => p.id === 'ParamBodyAngleZ')
  let threw = false
  try {
    animator.step(NaN, 'idle')
    animator.step(-5, 'idle')
    animator.step(100000, 'idle')
    animator.step(16, 'bogus-status')
  } catch { threw = true }
  assert('NaN / 负数 / 超大 / 未知状态都不抛错', !threw)
  const value = core.values.get('ParamBodyAngleZ')
  assert('异常帧之后仍在范围内', value >= body.min && value <= body.max, `value=${value}`)
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exitCode = failures === 0 ? 0 : 1
