/**
 * dsh-live2d-avatar — 插件入口（薄壳）。
 *
 * 真正的实现在同目录的 `host.js`。这里刻意只做一次「带时间戳的动态 import」：
 * 插件代码被 Node 的 ESM 缓存按 URL 记住，改完 `host.js` 再启用插件时，
 * 只有换一个 URL 才能拿到新代码，否则会继续跑上一次加载的那份。
 * 入口本身几乎不用改，因此日常迭代不会再撞上缓存。
 */
export const inject = ['tools', 'webServer', 'systemPrompt']

/**
 * 每次激活都重新加载实现，因此改完 host.js 只需在插件页停用/启用一次。
 * @param ctx - 已注入 tools / webServer / systemPrompt 的 Host Context。
 * @param config - 可选部署配置：{ modelDir?, modelFile? }。
 */
export async function apply(ctx, config) {
  const url = new URL('./host.js', import.meta.url)
  url.searchParams.set('generation', String(Date.now()))
  const implementation = await import(url.href)
  return implementation.apply(ctx, config)
}
