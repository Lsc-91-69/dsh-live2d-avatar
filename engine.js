/**
 * dsh-live2d 共享引擎。
 *
 * 这里是**唯一**的形象实现：适配、待机动作、手势、笔、情绪与行为常量。
 * 网页浮层与桌面桌宠都从这里取，所以两边行为必然一致，不存在两处漂移。
 *
 * 文件由 `host.js` 在运行时整段内嵌进宠物页（见 extractEngineRegions），
 * 因此这里不 import、不 export，只写纯 JavaScript 声明。
 */

// #region fit-math
/** 模型相对「刚好完整放入」的占比：1 = contain，>1 会略微裁切。 */
const FILL = 1;

/**
 * 视口尺寸，单位必须是 CSS 逻辑像素 —— 也就是舞台坐标系。
 *
 * 不能用 `renderer.width/height`：那是 canvas 的物理像素（CSS 宽 × resolution）。
 * 拿它适配会让模型大小随 devicePixelRatio 漂移，而浏览器缩放会改变
 * devicePixelRatio，于是 90% 正常、100% 被放大到溢出。
 * @param app - PIXI Application。
 * @param host - 承载 canvas 的元素。
 * @returns 逻辑像素尺寸；无法确定时为 0。
 */
function viewportOf(app, host) {
  const element = host || null;
  const screen = app && app.renderer ? app.renderer.screen : null;
  const elementWidth = element ? element.clientWidth : 0;
  const elementHeight = element ? element.clientHeight : 0;
  const width = elementWidth > 0 ? elementWidth : (screen && screen.width > 0 ? screen.width : 0);
  const height = elementHeight > 0 ? elementHeight : (screen && screen.height > 0 ? screen.height : 0);
  return { width, height };
}

/**
 * 模型的固有尺寸（容器 scale = 1 时的舞台尺寸）。
 *
 * Live2DModel 没有覆写 width/height，PIXI 的 `Container.width` 会把 scale 乘进去，
 * 所以「用 model.width 再算一次 scale」会基于上一次的结果继续缩放，重复 fit 不幂等。
 * `internalModel.width/height` 在 setupLayout() 里只设一次，与容器 scale 无关。
 * @param model - Live2D 模型实例。
 * @returns 固有尺寸，永远为正。
 */
function intrinsicSize(model) {
  const internal = model ? model.internalModel : null;
  const canvasWidth = internal ? internal.width : undefined;
  const canvasHeight = internal ? internal.height : undefined;
  const width = Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : model.width;
  const height = Number.isFinite(canvasHeight) && canvasHeight > 0 ? canvasHeight : model.height;
  return { width: width > 0 ? width : 1, height: height > 0 ? height : 1 };
}

/**
 * 把固有尺寸的内容完整放进视口的缩放与中心点。纯函数，便于按各种
 * 视口 / devicePixelRatio / 缩放组合在 Node 里验证。
 */
function computeFit(intrinsicWidth, intrinsicHeight, viewportWidth, viewportHeight, fill) {
  const ratio = Math.min(viewportWidth / intrinsicWidth, viewportHeight / intrinsicHeight);
  return { scale: ratio * fill, x: viewportWidth / 2, y: viewportHeight / 2 };
}

/**
 * 让模型适配当前视口。挂在 ResizeObserver 与 PIXI 自身的 resize 上，
 * 两条路径都会触发，所以必须是幂等的。
 *
 * 放在 fit-math 区块内，是为了让宠物页也能直接复用这一段 ——
 * 桌宠与网页浮层必须用同一套适配，否则尺寸口径会再次分叉。
 */
function fitModel(model, app, host) {
  if (!model || !model.internalModel) return;
  const viewport = viewportOf(app, host);
  if (viewport.width <= 0 || viewport.height <= 0) return;
  const intrinsic = intrinsicSize(model);
  const fit = computeFit(intrinsic.width, intrinsic.height, viewport.width, viewport.height, FILL);
  model.scale.set(fit.scale);
  model.anchor.set(0.5, 0.5);
  model.position.set(fit.x, fit.y);
}
// #endregion fit-math

// #region idle-motion
/**
 * 待机时它自己会做的事：眼珠到处瞟、身体轻晃带着手里的笔、偶尔自己抖一下笔。
 *
 * 全部参数取值范围都从模型自己读（getParameterMinimumValue 等），不写死数字；
 * 幅度一律按「范围的百分比」给，所以换模型也不会写出离谱的值。
 */

/**
 * 表情模式里额外的一种：自言自语。不是 Agent 的真实想法，
 * 所以气泡上单独标出来、样式也压暗，避免和 live2d_express 混淆。
 */
const IDLE_MODE = 'idle';

/** 待机自言自语。第一人称、口语，说的是「等着的时候」那点事。 */
const MURMURS = [
  '……没人说话的时候我就盯着笔发呆。',
  '这笔拿久了有点沉，我换个手。',
  '刚才那行代码，我总觉得还有个地方没想通。',
  '要不要装作在思考，其实在放空。',
  '眼睛有点干，眨两下。',
  '它要是再问我一遍，我就再讲一遍，我不嫌烦。',
  '手上的笔转一圈——没转起来。',
  '安静得能听见风扇声。',
  '我是不是该主动说点什么。',
  '算了，先不打扰它，等它叫我。',
  '这个角度看得见屏幕反光。',
  '嗯……刚才那个报错其实挺有意思的。',
  '打个哈欠应该没人看见吧。',
  '我把笔摆正一点，看着舒服。',
  '待机的意思是「随时可以开始」，不是「没事干」。',
  '偷偷把脚尖踮起来一点点。',
];

/**
 * 碎碎念的节流：间隔与停留时长。
 *
 * 这三个原本在旧 `client.js`（已移除的浏览器浮层版）的文件顶部，不在
 * `#region idle-motion` 里，
 * 所以抽取引擎时被漏掉了 —— 结果是宠物页在 `scheduleMurmur()` 处抛
 * `MURMUR_MIN_MS is not defined`，`boot()` 中断，**后面的状态轮询从未注册**，
 * 状态栏就永远停在初始的「待机」。一个常量漏搬，症状却表现得像「没连上 DSH」。
 * 测试里现在有一条断言专门守住这些名字，避免再漏。
 */
const MURMUR_MIN_MS = 22000;
const MURMUR_SPAN_MS = 45000;
const MURMUR_VISIBLE_MS = 7000;

/** 注视幅度档位：小漂移最多，大幅瞟一眼最少，偶尔回到正中（像在看你）。 */
const GAZE_SMALL = 0.18;
const GAZE_MEDIUM = 0.45;
const GAZE_LARGE = 0.85;
/** 眼珠上下比左右动得少。 */
const GAZE_VERTICAL_BIAS = 0.62;

/**
 * 待机时会自己换的表情。
 *
 * 只挑温和的脸：这里没有「满眼爱心」「灵魂出窍」「墨镜」这类，随机摆出来会莫名其妙。
 * neutral 重复多次用来加权——大部分时间它该是一张平静的脸。
 */
const IDLE_EXPRESSIONS = [
  'neutral', 'neutral', 'neutral', 'neutral',
  'happy', 'shy', 'confused', 'blank', 'gloomy', 'sad', 'nervous', 'playful',
];
/** 换脸的间隔区间。 */
const IDLE_EXPRESSION_MIN_MS = 14000;
const IDLE_EXPRESSION_SPAN_MS = 26000;
/** 真实表情（live2d_express 推来的）之后，安静这么久不去抢脸。 */
const IDLE_EXPRESSION_QUIET_MS = 25000;

/**
 * 被戳一下时的反应。和碎碎念一样是角色自己的话，不是 Agent 的真实想法，
 * 所以气泡上单独标出来。
 */
const REACTION_MODE = 'poke';
/** 每条反应：说什么 + 什么表情。表情只挑温和的，戳一下不该突然戴上墨镜。 */
const REACTIONS = [
  { text: '哎——？', emotion: 'shocked' },
  { text: '别戳我，痒。', emotion: 'shy' },
  { text: '干嘛呀，我正忙着发呆呢。', emotion: 'confused' },
  { text: '嘿嘿，再来一下。', emotion: 'playful' },
  { text: '……你戳我干什么。', emotion: 'blank' },
  { text: '我在呢，说吧。', emotion: 'happy' },
  { text: '吓我一跳！', emotion: 'shocked' },
  { text: '手别乱动，笔要掉了。', emotion: 'nervous' },
  { text: '嗯？轮到我了吗。', emotion: 'happy' },
  { text: '戳一下就要我说句话，这也太难为我了。', emotion: 'sad' },
];
/** 反应气泡停留多久。 */
const REACTION_VISIBLE_MS = 4500;

/**
 * 持续轻晃的幅度占参数范围的比例。
 *
 * 只驱动**头**（`ParamAngleZ`）。身体不写：`ParamBodyAngleX/Y/Z` 都是物理的输出
 * （physics3.json 的 PhysicsSetting2/3/4，由 `ParamAngleX/Y/Z` 算出），
 * 直接写会被物理下一帧覆盖 —— 早期版本就是这么写的，所以身体和笔都没反应。
 * 头一转，身体、头发、呆毛、蝴蝶结全部经物理跟着动。
 *
 * 早期版本还用「两个固定正弦相加」驱动，那是严格周期的，看久了必然是机械感。
 * 现在改成非周期噪声，见 createDrift。
 */
const DRIFT_HEAD_FRACTION = 0.03;
/** 头 / 身体漂移的转向间隔（毫秒），决定晃动快慢。 */
const DRIFT_HEAD_GAP_MS = [2200, 4200];
/** 慢速幅度包络：让晃动有强弱起伏，偶尔几乎停下来。 */
const DRIFT_ENVELOPE_GAP_MS = [6000, 12000];
const DRIFT_ENVELOPE_MIN = 0.22;
/**
 * 头部还有一点点与视线无关的偏航 / 俯仰漂移。
 *
 * 头若严格跟着眼珠转，是另一种「僵」——真人看东西时头有自己的惯性。
 * 这两路是**叠加**在 SDK 的 updateFocus 之上的（focus 在之后 add），幅度要留小，
 * 否则会和视线角度叠加到参数上限被夹住。
 */
const DRIFT_YAW_FRACTION = 0.03;
const DRIFT_PITCH_FRACTION = 0.025;
const DRIFT_YAW_GAP_MS = [3000, 6000];
const DRIFT_PITCH_GAP_MS = [3400, 6800];

/** 一次手势（摇头 / 摆一摆）的参数区间：每次都不一样，免得像节拍器。 */
const GESTURE_MS = [1500, 2900];
/**
 * 来回数必须是**半整数**。
 *
 * 波形是 sin²(πp)·sin(2πcp)：包络在正中（p=0.5）最强，而 sin(2πc·0.5)=sin(πc)
 * 只有在 c 为半整数时才取到 ±1 —— 整数来回会正好在中心抵消，峰值掉到 0.65，
 * 等于白丢三分之一幅度。区间端点都取半整数，幅度才给得实。
 */
const GESTURE_HEAD_CYCLES = [1.5, 2.5];
const GESTURE_BODY_CYCLES = [0.5, 1.5];
const GESTURE_HEAD_FRACTION = [0.05, 0.11];
const GESTURE_BODY_FRACTION = [0.04, 0.09];
/** 手势之间的间隔区间。 */
const GESTURE_MIN_MS = 6000;
const GESTURE_SPAN_MS = 9000;
/** 这个概率下这次什么都不做——偶尔漏一拍才不像节拍器。 */
const GESTURE_SKIP = 0.3;

/** 是否让模型「手里拿着笔」（bi 拉到上限）。不想要就把这里改成 false。 */
const PEN_VISIBLE = true;

const clampNumber = (value, min, max) => (value < min ? min : value > max ? max : value);

/** 在区间里取一个值。 */
function pickRange(random, range) {
  return range[0] + random() * (range[1] - range[0]);
}

/**
 * 平滑值噪声：在随机的时刻取随机的值，中间用 smoothstep 相连。
 *
 * 这是替掉「两个固定正弦相加」的关键：正弦和是严格周期的，看久了必然机械；
 * 值噪声非周期，而且 smoothstep 在节点处导数为 0 —— 曲线处处连续、没有拐角，
 * 所以既不会重复，也不会「抖」。
 * @param random - [0,1) 随机源。
 * @param gapRange - 相邻节点的时间间隔区间（毫秒）。
 * @returns 取样函数 (timeMs) => [-1, 1]。
 */
function createDrift(random, gapRange) {
  let fromTime = 0;
  let fromValue = 0;
  let toTime = 0;
  let toValue = 0;
  let started = false;
  const nextGap = () => gapRange[0] + random() * (gapRange[1] - gapRange[0]);

  return function driftAt(timeMs) {
    if (!started) {
      started = true;
      // 起点固定为 0：噪声本来会随机起步，那一帧会从 0 突然跳到随机值
      // （头部最大 ±1.8°），看起来就是开场的「一顿」。从 0 缓入就没有这一跳。
      fromValue = 0;
      toValue = random() * 2 - 1;
      toTime = nextGap();
    }
    // 长时间没有取样（比如标签页被挂起）时会一次跨过多个节点；上限防止死循环。
    let guard = 0;
    while (timeMs >= toTime && guard < 512) {
      fromTime = toTime;
      fromValue = toValue;
      toTime = toTime + nextGap();
      toValue = random() * 2 - 1;
      guard += 1;
    }
    const span = toTime - fromTime;
    if (!(span > 0)) return toValue;
    const progress = clampNumber((timeMs - fromTime) / span, 0, 1);
    const eased = progress * progress * (3 - 2 * progress);
    return fromValue + (toValue - fromValue) * eased;
  };
}

/**
 * 视线跟随的时间常数（秒）：眼睛最快，头慢一拍，身体再慢一拍。
 *
 * 为什么不交给 SDK 的 focusController：它每帧的最大位移是
 * `r = 5.3333 × deltaMs / 1000`，而那个 deltaMs 是**没有上限**的
 * （Live2DModel._render 直接传 this.deltaTime）。只要掉一帧，r 就超过整个
 * 取值域，眼睛/头/身体会在**一帧之内**跳到目标 —— 看起来就是「闪过去」。
 * 自己算就没有这个问题：单帧步长由 MAX_FOLLOW_STEP_MS 夹住。
 */
const GAZE_TAU = 0.1;
const HEAD_TAU = 0.42;
/** 跟随用的单帧 dt 上限（毫秒）。掉帧时按一帧算，绝不允许瞬移。 */
const MAX_FOLLOW_STEP_MS = 40;
/** 头部跟随视线的比例（占参数全域的比例）。留一点不跟满，才不像被磁铁吸住。 */
const GAZE_HEAD_FRACTION = 0.25;
/** 头部的俯仰比偏航跟得少。 */
const GAZE_HEAD_PITCH_RATIO = 0.7;
/** 眼珠跟随视线的比例（眼珠取值域是 -1..1，0.5 × 全域 = 满偏）。 */
const GAZE_EYE_FRACTION = 0.5;
const GAZE_EYE_PITCH_RATIO = 0.65;

/**
 * 笔（点菜手）的驱动。
 *
 * 这是「笔不动」的答案。查 physics3.json 的 PhysicsDictionary 可以确认：
 * `PhysicsSetting19 = 数位笔手X` 的**输入**是 `pointX`/`pointY`，输出 `pointY2`；
 * `PhysicsSetting20 = 数位笔手Z` 的输入是 `pointZ`。也就是说笔手是**被这些参数驱动**的。
 *
 * 反过来，`ParamBodyAngleX/Y/Z` 全都是物理的**输出**（PhysicsSetting2/3/4：
 * 由 `ParamAngleX/Y/Z` 算出）。所以直接写身体角度是白费力气——物理下一帧就算回去覆盖掉。
 * 之前两版就是这么写的，所以笔和身体都没反应。
 *
 * 幅度用物理自己的归一化跨度：PhysicsSetting19 的 Normalization.Position 是 ±10，
 * 所以 ±10 就是这套物理的满量程。最终仍会被夹到参数自身的 min/max。
 */
const PEN_HAND_SPAN = 10;
const PEN_HAND_X_FRACTION = 0.34;
const PEN_HAND_Y_FRACTION = 0.22;
/** 手 / 笔晃动的时间常数（秒）。比眼睛慢，像是在手里晃。 */
const PEN_HAND_TAU = 0.35;
/** 转动间隔（毫秒）。 */
const PEN_HAND_GAP_MS = [2600, 5200];
/** 偶尔按下笔尖：`pointZ` 拉满一小会儿，松手靠自己的漂移。 */
const PEN_PRESS_MS = 260;
const PEN_PRESS_MIN_MS = 7000;
const PEN_PRESS_SPAN_MS = 14000;

/** 按 roll 选幅度档位，越靠后的越少见。 */
function gazeRadius(pick) {
  if (pick < 0.55) return GAZE_SMALL;
  if (pick < 0.85) return GAZE_MEDIUM;
  if (pick < 0.94) return GAZE_LARGE;
  return 0;
}

/**
 * 指数趋近一步：`alpha = 1 - e^(-dt/τ)`。
 *
 * dt 已被调用方夹住，所以单帧位移有上界，绝不会有「一帧到位」的弹跳。
 * @param current - 当前值。
 * @param target - 目标值。
 * @param dtSeconds - 已夹住的步长（秒）。
 * @param tauSeconds - 时间常数，越小越快。
 * @returns 推进后的值。
 */
function advanceFollower(current, target, dtSeconds, tauSeconds) {
  if (!(dtSeconds > 0)) return current;
  const alpha = 1 - Math.exp(-dtSeconds / Math.max(1e-6, tauSeconds));
  return current + (target - current) * alpha;
}

/**
 * 下一个注视目标。取值域 [-1, 1]（focusController 自己也会夹一道）。
 * @param pick - [0,1) 决定幅度档位。
 * @param angle - [0,1) 决定方向。
 * @returns 目标点；回到正中时就是 {0,0}。
 */
function nextGazeTarget(pick, angle) {
  const radius = gazeRadius(pick);
  if (radius === 0) return { x: 0, y: 0 };
  const theta = angle * Math.PI * 2;
  return {
    x: clampNumber(Math.cos(theta) * radius, -1, 1),
    y: clampNumber(Math.sin(theta) * radius * GAZE_VERTICAL_BIAS, -1, 1),
  };
}

/**
 * 这个目标盯多久。思考时更碎更快；待机时更稳，偶尔长时间发愣。
 * @param status - 'idle' | 'thinking'
 * @param roll - [0,1)
 */
function nextHoldMs(status, roll) {
  if (status === 'thinking') return 420 + roll * 1100;
  if (roll < 0.18) return 3800 + roll * 4000;
  return 900 + roll * 2300;
}

/**
 * 一次手势的波形：两端为 0、中间平滑起落，期间摆动 cycles 个来回。
 *
 * 包络用 sin²(πp)，它在 p=0 和 p=1 处的导数都是 0 —— 也就是说动作是「缓缓起来、
 * 缓缓停下」，不会像原先的 12% 急起那样抽一下。这正是「别太突然」的数学表达。
 * @param progress - 0..1 的手势进度。
 * @param cycles - 期间摆动几个来回。
 * @returns [-1, 1] 的位移。
 */
function gestureWave(progress, cycles) {
  if (!(progress > 0) || progress >= 1) return 0;
  const envelope = Math.sin(Math.PI * progress);
  return envelope * envelope * Math.sin(Math.PI * 2 * cycles * progress);
}

/** 手势类型：摇头（头）或摆一摆（身体）。 */
function nextGestureKind(roll) {
  return roll < 0.55 ? 'head' : 'body';
}

/** 两次手势之间的间隔。 */
function nextGestureDelayMs(roll) {
  return GESTURE_MIN_MS + roll * GESTURE_SPAN_MS;
}

/** 参数句柄：把 id 解析成下标，并读出模型自己的范围。缺失则返回 null。 */
function parameterHandle(core, id) {
  let index;
  try {
    index = core.getParameterIndex(id);
  } catch {
    return null;
  }
  // getParameterIndex 对不存在的 id 会返回一个越界的合成下标，必须挡掉。
  if (!Number.isInteger(index) || index < 0 || index >= core.getParameterCount()) return null;
  const min = core.getParameterMinimumValue(index);
  const max = core.getParameterMaximumValue(index);
  const base = core.getParameterDefaultValue(index);
  if (![min, max, base].every(Number.isFinite) || !(max > min)) return null;
  return { id, index, min, max, base, range: max - min };
}

/**
 * 把待机动作绑到一个已 ready 的模型上。
 *
 * 写入时机是 `afterMotionUpdate` —— 这一帧里动作已经算完，但表达式、注目、
 * 物理、pose 都还没跑，所以：
 *   - 用 setParameterValueByIndex 写绝对值，不会被动作覆盖；
 *   - 物理跑在它之后，身体一转，手臂和笔会自己被带着甩（这正是 VTube Studio
 *     里鼠标带动笔的同一套机制）；
 *   - 每帧都写绝对值，所以不存在逐帧累加导致的漂移。
 *
 * @param model - Live2DModel 实例。
 * @param options - { random } 注入随机源，便于测试。
 * @returns 带 dispose 的控制器；模型不支持时返回 null。
 */
function createIdleAnimator(model, options) {
  const internal = model && model.internalModel;
  const core = internal && internal.coreModel;
  const focus = internal && internal.focusController;
  if (!core || !focus || typeof core.getParameterCount !== 'function') return null;

  const random = (options && options.random) || Math.random;
  const pen = PEN_VISIBLE ? parameterHandle(core, 'bi') : null;
  const headZ = parameterHandle(core, 'ParamAngleZ');
  const yaw = parameterHandle(core, 'ParamAngleX');
  const pitch = parameterHandle(core, 'ParamAngleY');
  const eyeX = parameterHandle(core, 'ParamEyeBallX');
  const eyeY = parameterHandle(core, 'ParamEyeBallY');
  // 笔手：这两（三）个参数才是笔的驱动（physics3.json 的 PhysicsSetting19/20）。
  const penX = parameterHandle(core, 'pointX');
  const penY = parameterHandle(core, 'pointY');
  const penZ = parameterHandle(core, 'pointZ');

  let status = 'idle';
  let elapsed = 0;
  let gaze = { x: 0, y: 0 };
  /** 已平滑的视线位置，眼睛直接用它。 */
  let gazeCurrent = { x: 0, y: 0 };
  /** 头 / 身体的跟随位置，各比上一级更慢。 */
  let headCurrent = { x: 0, y: 0 };
  /** 已平滑的笔手位置，量程 -1..1（乘上 PEN_HAND_SPAN 才是参数值）。 */
  let penCurrent = { x: 0, y: 0 };
  let nextGazeAt = 0;
  let activeGesture = null;
  let nextGestureAt = 0;
  let penPress = null;
  let nextPenPressAt = 0;
  let started = false;

  const roll = () => {
    const value = random();
    return Number.isFinite(value) ? clampNumber(value, 0, 0.999999) : 0.5;
  };

  // 每一路都有自己的噪声，互不相关；头与身体因此不会同步摆。
  const drifts = {
    head: createDrift(roll, DRIFT_HEAD_GAP_MS),
    envelope: createDrift(roll, DRIFT_ENVELOPE_GAP_MS),
    yaw: createDrift(roll, DRIFT_YAW_GAP_MS),
    pitch: createDrift(roll, DRIFT_PITCH_GAP_MS),
    penX: createDrift(roll, PEN_HAND_GAP_MS),
    penY: createDrift(roll, PEN_HAND_GAP_MS),
  };

  /** 每帧调用。dtMs 由调用方给（performance.now 差值）。 */
  function step(dtMs, nextStatus) {
    if (Number.isFinite(nextStatus)) status = nextStatus;
    const delta = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 0;
    elapsed += delta;

    if (!started) {
      started = true;
      nextGazeAt = 0;
      nextGestureAt = roll() * GESTURE_MIN_MS;
    }

    // 视线：到点换目标，跟随由下面的 advanceFollower 自己算（不交给 SDK 的弹簧）。
    if (elapsed >= nextGazeAt) {
      gaze = nextGazeTarget(roll(), roll());
      nextGazeAt = elapsed + nextHoldMs(status, roll());
    }

    // 接管 SDK 的注目：它每帧会把 focusController.x/y 加到眼珠、头和身体上，
    // 而被加的弹簧速度取决于一个没有上限的 dt。把它钉在 0，这些加数就都是 0，
    // 朝向完全由我们下面写的绝对值决定，也就没有「一帧闪过去」。
    focus.focus(0, 0, true);

    // 眼睛最快、头慢一拍、身体再慢一拍 —— 层层滞后才像活人。
    const followSeconds = Math.min(delta, MAX_FOLLOW_STEP_MS) / 1000;
    gazeCurrent = {
      x: advanceFollower(gazeCurrent.x, gaze.x, followSeconds, GAZE_TAU),
      y: advanceFollower(gazeCurrent.y, gaze.y, followSeconds, GAZE_TAU),
    };
    headCurrent = {
      x: advanceFollower(headCurrent.x, gazeCurrent.x * GAZE_HEAD_FRACTION, followSeconds, HEAD_TAU),
      y: advanceFollower(headCurrent.y, gazeCurrent.y * GAZE_HEAD_FRACTION * GAZE_HEAD_PITCH_RATIO, followSeconds, HEAD_TAU),
    };

    // 手里的笔。
    if (pen) core.setParameterValueByIndex(pen.index, pen.max);

    // 手势：到点挑一个（有时故意不挑），做完就停，等下一次。
    // 时长、来回数、幅度都是这一次现取的，所以没有两次手势长得一样。
    if (activeGesture !== null && elapsed - activeGesture.start >= activeGesture.durationMs) activeGesture = null;
    if (activeGesture === null && elapsed >= nextGestureAt) {
      nextGestureAt = elapsed + nextGestureDelayMs(roll());
      if (roll() >= GESTURE_SKIP) {
        const kind = nextGestureKind(roll());
        activeGesture = {
          kind,
          start: elapsed,
          durationMs: pickRange(roll, GESTURE_MS),
          cycles: pickRange(roll, kind === 'head' ? GESTURE_HEAD_CYCLES : GESTURE_BODY_CYCLES),
          amplitude: pickRange(roll, kind === 'head' ? GESTURE_HEAD_FRACTION : GESTURE_BODY_FRACTION),
        };
      }
    }
    let headGesture = 0;
    let bodyGesture = 0;
    if (activeGesture !== null) {
      const wave = gestureWave((elapsed - activeGesture.start) / activeGesture.durationMs, activeGesture.cycles);
      const displaced = wave * activeGesture.amplitude;
      if (activeGesture.kind === 'head') headGesture = displaced;
      else bodyGesture = displaced;
    }

    // 慢速包络：让晃动时强时弱，偶尔几乎停住——恒定幅度最容易看出机械感。
    const envelope = DRIFT_ENVELOPE_MIN
      + (1 - DRIFT_ENVELOPE_MIN) * (drifts.envelope(elapsed) + 1) / 2;

    // 只写「头」。身体不写：ParamBodyAngleX/Y/Z 都是物理的输出，
    // 由 ParamAngleX/Y/Z 经 PhysicsSetting2/3/4 算出来，写了也会被覆盖。
    // 头一转，身体、头发、呆毛、蝴蝶结全都经物理跟着动，这才是 VTube Studio 的那条链。
    // 「摆一摆」的手势也落在头上（幅度略大），身体照样跟随。
    const headTilt = DRIFT_HEAD_FRACTION * drifts.head(elapsed) * envelope + headGesture + bodyGesture;
    if (headZ) {
      core.setParameterValueByIndex(headZ.index, clampNumber(headZ.base + headZ.range * headTilt, headZ.min, headZ.max));
    }

    // 头自己的一点点偏航 / 俯仰：和视线解耦，避免头死死跟着眼珠。
    if (yaw) {
      const value = headCurrent.x + DRIFT_YAW_FRACTION * drifts.yaw(elapsed);
      core.setParameterValueByIndex(yaw.index, clampNumber(yaw.base + yaw.range * value, yaw.min, yaw.max));
    }
    if (pitch) {
      const value = headCurrent.y + DRIFT_PITCH_FRACTION * drifts.pitch(elapsed);
      core.setParameterValueByIndex(pitch.index, clampNumber(pitch.base + pitch.range * value, pitch.min, pitch.max));
    }
    // 身体不写。ParamBodyAngleX/Y/Z 都是物理的输出（PhysicsSetting2/3/4，
    // 由 ParamAngleX/Y/Z 算出），写了会被物理下一帧覆盖 —— 这正是之前
    // 「身体和笔都不动」的原因之一。头一转，身体自然跟着转。
    // 眼珠。
    if (eyeX) {
      core.setParameterValueByIndex(eyeX.index, clampNumber(eyeX.base + eyeX.range * GAZE_EYE_FRACTION * gazeCurrent.x, eyeX.min, eyeX.max));
    }
    if (eyeY) {
      core.setParameterValueByIndex(eyeY.index, clampNumber(eyeY.base + eyeY.range * GAZE_EYE_FRACTION * GAZE_EYE_PITCH_RATIO * gazeCurrent.y, eyeY.min, eyeY.max));
    }

    // 手里那支笔：真正让它动的地方。
    // pointX / pointY 是「数位笔手X」物理的输入（见 PEN_HAND_SPAN 的注释），
    // 跟着两路独立噪声缓缓摆动，笔尖再偶尔按一下。
    if (penX) {
      const target = PEN_HAND_X_FRACTION * drifts.penX(elapsed) * envelope;
      penCurrent.x = advanceFollower(penCurrent.x, target, followSeconds, PEN_HAND_TAU);
      core.setParameterValueByIndex(penX.index, clampNumber(penX.base + PEN_HAND_SPAN * penCurrent.x, penX.min, penX.max));
    }
    if (penY) {
      const target = PEN_HAND_Y_FRACTION * drifts.penY(elapsed) * envelope;
      penCurrent.y = advanceFollower(penCurrent.y, target, followSeconds, PEN_HAND_TAU);
      core.setParameterValueByIndex(penY.index, clampNumber(penY.base + PEN_HAND_SPAN * penCurrent.y, penY.min, penY.max));
    }
    // 按笔尖：到点按下，持续一小会儿，再靠下面的漂移自己松开。
    if (penPress !== null && elapsed - penPress >= PEN_PRESS_MS) penPress = null;
    if (penPress === null && elapsed >= nextPenPressAt) {
      penPress = elapsed;
      nextPenPressAt = elapsed + PEN_PRESS_MIN_MS + roll() * PEN_PRESS_SPAN_MS;
    }
    if (penZ) {
      const pressed = penPress !== null;
      core.setParameterValueByIndex(penZ.index, pressed ? penZ.max : penZ.base);
    }
  }

  return {
    step,
    /** 被戳一下：立刻起一个手势，动作幅度比待机的大一点。 */
    poke() {
      const rollValue = roll();
      activeGesture = {
        kind: rollValue < 0.6 ? 'head' : 'body',
        start: elapsed,
        durationMs: pickRange(roll, GESTURE_MS) * 0.8,
        cycles: pickRange(roll, GESTURE_HEAD_CYCLES),
        amplitude: pickRange(roll, GESTURE_HEAD_FRACTION) * 1.6,
      };
      nextGestureAt = elapsed + activeGesture.durationMs + 1200;
      return activeGesture.kind;
    },
    getState: () => ({
      status,
      elapsed,
      gazeTarget: gaze,
      gazeCurrent,
      headCurrent,
      gesture: activeGesture === null ? null : activeGesture.kind,
      penVisible: pen !== null,
      penHandTracked: penX !== null && penY !== null,
      penPressTracked: penZ !== null,
      headTracked: headZ !== null,
      yawTracked: yaw !== null,
      pitchTracked: pitch !== null,
      eyeTracked: eyeX !== null && eyeY !== null,
    }),
    dispose() { started = false; },
  };
}
// #endregion idle-motion
