/**
 * nano-dsh-interface — 宿主（node）半边。
 *
 * 纯 UI 插件：空的 apply 只是为了让插件出现在宿主 cordis.yml / Loader 里，
 * 浏览器半边通过 package.json 的 exports["./client"] 发布，由 dsh.client
 * 声明被前端模块系统发现并服务到 /plugins/nano-dsh-interface/client.js。
 */

/** 宿主插件体——本界面插件没有任何宿主侧行为。 */
export function apply() {}
