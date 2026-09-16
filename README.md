# nano_dsh_interface

DeepSeek Harness 的界面增强插件（**正规客户端插件版**）。

## 功能

| 模块 | 说明 |
|---|---|
| **主题设置** | DSH 设置弹窗内的独立分区（左侧导航「主题设置」）：背景图片（本地选择）、遮罩颜色调色板、前景透明度、对话区毛玻璃开关与强度、**设为默认背景**（把当前背景存为插件默认图 `assets/background.jpg`） |
| **系统监控悬浮窗** | 右下角悬浮窗：CPU / GPU / 内存 / 磁盘读写 / 网络上下行，可拖动、位置记忆；页面隐藏时暂停轮询 |
| **GitLab 任务** | VS Code 风格子窗口：指派给你的开放 Issue，标题栏拖动、四边吸附（上/下边横向排列）、列表项拖拽排序；数据未变化时跳过重渲染 |
| **PowerShell 终端** | 对话框下方多终端（横向排布、＋ 添加、可调高度）：xterm.js 全终端模拟（原生 PSReadLine：方向键/Tab 补全/历史），每终端显示当前路径，点击路径栏弹出**自研目录浏览器**（单击进入、双击直达、⬆ 返回、⟳ 刷新、✎ 手动输入）；断线**指数退避重连**（1s→2s→4s→…→上限 30s） |
| **界面定制** | 背景图 + 电影感遮罩 + 毛玻璃面板，浅色/深色主题自适应，配置存 localStorage 实时生效 |
| **后台服务状态** | 设置面板内实时显示 gitlab-bridge / terminal-bridge 健康状态 |

## 为什么从"补丁 dist"改成"客户端插件"

旧版靠 `install.ps1` 往 `dsh-web-frontend/dist` 里注 `<script>` 并拷贝资源。**DSH 一升级（npm 覆写该包）这些内容就会被整包清掉** —— 实际发生过一次：`dist/index.html` 回到出厂状态、`dist/assets/` 下插件资源全部消失，插件等于没装。

现在改成 DSH 原生机制：插件仓库声明 `dsh.client`，宿主扫描 profile 的 loader 条目、把浏览器半边服务到 `/plugins/nano-dsh-interface/client.js`。**DSH 升级不再影响插件**（唯一需要重跑的是重启电脑后的 `start-services.ps1`）。

## 架构

```
nano_dsh_interface\
├── package.json          # name / version / exports["./client"] / dsh.client.platform="web"
├── lib\
│   ├── index.js          # 宿主（node）半边：空 apply，只为让插件出现在 Loader 里
│   └── client.js         # 浏览器半边产物（由 build.mjs 生成，需入库）
├── client\index.js       # 浏览器半边源码：apply(ctx) 装配各模块 + 注册设置分区
├── build.mjs             # esbuild 打包（CJS + ModuleLoader 外壳），react 保持 external
├── install.ps1           # 构建 + 在 profile 的 cordis.patch.yml 里登记一行
├── uninstall.ps1         # 移除该行（-CleanLegacy 顺带清理旧版 dist 残留）
├── start-services.ps1    # 启动三个后台服务（从本仓库 services\ 启动）
├── assets\               # 前端资源
│   ├── background.jpg         # 默认背景图
│   ├── custom-background.css  # 样式（哈希无关的 .dshn-* 标记类选择器）
│   ├── modules\               # 前端模块（ES module，被 build.mjs 打进 client.js）
│   │   ├── dshnano-core.js    # 配置读写 / apply 分发 / 结构探测 / 安全工具
│   │   ├── dshnano-theme.js   # 背景/遮罩/透明度/毛玻璃
│   │   ├── dshnano-monitor.js # 系统监控悬浮窗
│   │   ├── dshnano-gitlab.js  # GitLab 任务子窗口
│   │   ├── dshnano-terminal.js# PowerShell 终端
│   │   └── dshnano-settings.js# 设置面板 UI
│   └── vendor\                # xterm.js / xterm-addon-fit.js / xterm.css（本地提供，无 CDN）
│       └── package.json       # 声明该目录为 commonjs（两个文件是 UMD 产物）
├── services\             # 后台服务（从本仓库运行，不再拷进 DSH 安装目录）
│   ├── terminal-bridge.mjs    # PowerShell 终端桥（ws://127.0.0.1:3082）
│   ├── gitlab-bridge.mjs      # GitLab 任务 + 默认背景 + metrics/tasks 数据（http://127.0.0.1:3081）
│   ├── metrics-writer.ps1     # 系统监控采样（每 2 秒写 data\metrics.json）
│   ├── gitlab-tasks.ps1       # GitLab 任务 CLI（命令行查询）
│   ├── gitlab-fetch.ps1       # （备用）GitLab 抓取脚本
│   ├── gitlab-config.json     # GitLab 地址（⚠️ 不含令牌）
│   └── gitlab-config.json.example
├── test\
│   ├── integration.mjs        # DOM 集成测试（jsdom 里跑真实产物）
│   └── terminal-smoke.mjs     # 终端端到端冒烟测试（真实 PTY 往返）
└── data\                 # 运行时数据（已 gitignore）
    ├── metrics.json           # 系统指标（metrics-writer 每 2 秒）
    └── gitlab-tasks.json      # GitLab 任务（gitlab-bridge 每 30 秒）
```

浏览器半边由宿主服务到 `/plugins/nano-dsh-interface/client.js`（combo URL 形如
`/plugins/??nano-dsh-interface/client.js&rev=<hash>`），模块 id 取自 `package.json` 的 `name`。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
powershell -ExecutionPolicy Bypass -File start-services.ps1
```

`install.ps1` 做两件事：

1. `npm install`（首次）+ `npm run build` → 生成 `lib/client.js`
2. 在 `<DSH_HOME>\profiles\web\cordis.patch.yml` 里写入/更新一个**哨兵块**：

```yaml
# >>> nano-dsh-interface (managed block - do not edit by hand) >>>
- insert:
    - id: nano-dsh-interface
      name: 'C:/.../nano_dsh_interface/lib/index.js'
# <<< nano-dsh-interface <<<
```

写盘前会用 profile 自带的 `yaml` 解析器校验**必须是顶层 YAML 数组**（补丁文件写坏会让 dsh 启动直接失败），校验不过就放弃写入、不动原文件。

装完**刷新页面（Ctrl+F5）**；若插件没出现，重启一次 `dsh web` 让新的 loader 条目生效（`cordis.patch.yml` 是 `patchReload: live`，但新增 loader 行不保证热生效）。

可选参数：`-StartServices`（装完顺手起服务）、`-SkipBuild`（只登记不构建）、`-Profile <目录>`（指定 profile，默认 `$DSH_HOME\profiles\web`）。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

移除 profile 里的哨兵块；若移除后已无有效条目会补回 `[]`（**纯注释文件会让 dsh 启动失败**）。
**不删除**插件仓库里的任何东西（构建产物、服务、GitLab 令牌都保留），重新 `install.ps1` 即可恢复。

加 `-CleanLegacy` 可顺带清理旧版留在 DSH 安装目录里的 `index.html` 注入与拷贝资源（**保留** `gitlab-token.enc` / `gitlab-config.json`）。

## 后台服务（电脑重启后需重新启动）

```powershell
powershell -ExecutionPolicy Bypass -File start-services.ps1
```

| 服务 | 端口 | 作用 |
|---|---|---|
| terminal-bridge | ws://127.0.0.1:3082 | PowerShell 终端（每连接独立 pwsh 会话；`/list-dir` 供自研目录浏览器、`/health`） |
| gitlab-bridge | http://127.0.0.1:3081 | `/config`、`/test`、`/health`、`/background`（写默认背景）、`/metrics`、`/tasks`、`/default-background` |
| metrics-writer | — | 采集系统指标写入 `data\metrics.json`（目标周期 2 秒；采样本身约 2~3 秒，实际约 2.7 秒） |

前端不再从 DSH 的 `/assets/xxx.json` 静态路由取数据，而是从 `127.0.0.1:3081` 的
`/metrics`、`/tasks`、`/default-background` 取——这条链路不经过 DSH 安装目录，升级不受影响。

### 服务依赖 `ws` / `node-pty`

两者是本仓库的**正式 `dependencies`**（`node-pty` 自带 `win32-x64` 等预编译产物，无需本地构建工具）。
`start-services.ps1` 启动前会检查它们是否就绪，缺失时自动执行 `npm install --omit=dev`。

> 早期版本曾用"目录联接指向 DSH 安装里的同名包"来凑依赖。**已废弃**：ESM 不认 `NODE_PATH`，
> 而且任何一次 `npm install` 都会把这类联接当成 extraneous 删掉。改成正式依赖后，
> **插件对 DSH 安装目录不再有任何运行时依赖**，DSH 升级无法影响它。

## 构建（开发）

```powershell
npm run build      # 一次性构建 lib/client.js
npm run watch      # 监听重建
```

`lib/client.js` 必须是 **DSH 的 lazy-CJS 工厂格式**：

```js
window.__ModuleLoader__.load({
  id: "nano-dsh-interface",          // 必须等于 package.json 的 name
  factory: (require) => { /* ... */ return module.exports }
});
```

`build.mjs` 用 esbuild 以 CJS 打包，再用 `banner`/`footer` 套上这个外壳。
**平台基线模块必须保持 external**（运行时由 factory 的 `require` 从 shell 的静态模块表解析），当前表只有 9 项：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。

客户端插件**没有 CSS 通道**：CSS 以文本导入（`loader: { ".css": "text" }`），运行时建 `<style>` 注入，并打上
`data-plugin` / `data-plugin-css` 供 HMR 回收。清理统一挂在 `ctx.effect(...)` 的 disposer 上。

> ⚠️ 本仓库所有 `.ps1` **必须带 UTF-8 BOM**。Windows PowerShell 5.1 对无 BOM 文件按 ANSI 读取，中文会被打乱并报出莫名其妙的语法错误。

## 验证 / 测试

```powershell
npm test               # DOM 集成测试
npm run test:terminal  # 终端端到端冒烟测试（需先运行 start-services.ps1）
```

`npm test` 在 jsdom 里执行**构建产物本身**（不是源码），模拟宿主的 `window.__ModuleLoader__` 与 cordis `ctx`，
断言：产物注册格式与 id、`inject` 只依赖 `slots`、`apply(ctx)` 装配四项功能、结构探测命中
DSH 0.1.5-rc.1 的真实类名（含 `detailsCol → rightbarCol`）、`settings.section` 插槽注册与面板渲染、
监控/任务数据只打本地桥服务（不碰 DSH `/assets` 路由）、`ctx.effect` disposer 不留残骸。

`npm run test:terminal` 真的连上 `ws://127.0.0.1:3082`：开一个 PTY、敲命令、读回输出，
再验证同一会话可复用与 `/list-dir` 目录扫描接口。

## 结构探测（为什么还需要它）

主题要给 DSH 内部布局打标记，因此仍需定位宿主 DOM。布局/设置面板由 DSH 的客户端插件包渲染，
其 CSS-module 类名形如 `<hash>_<语义名>`（`pI_x6G_centerCol`、`VOzbGW_panel`…）。

`dshnano-core.js` 的探测顺序是**精确选择器优先、语义后缀兜底**：

- 精确选择器命中当前已知构建，避免通用后缀误命中别的组件
  （`_panel` / `_content` / `_root` 在 DSH 里各有若干个同后缀类名）；
- 精确选择器全部失配时（DSH 换了哈希）再按后缀扫描，仍能自适应；
- 两者都失败则优雅降级：该元素留空、相关样式不生效，其余功能不受影响。

已知对应关系（DSH 0.1.5-rc.1）：

| 语义 | 实际类名 | 来源 |
|---|---|---|
| centerCol | `pI_x6G_centerCol` | dsh-client-ui-layout |
| frame | `pI_x6G_frame` | dsh-client-ui-layout |
| sidebarCol | `pI_x6G_sidebarCol` | dsh-client-ui-layout |
| detailsCol | `pI_x6G_rightbarCol`（旧名 `detailsCol` 已改） | dsh-client-ui-layout |
| composerSeat | `wSkVaW_composerSeat` | dsh-client-ui-conversation |
| root / card | `wSkVaW_root` / `uV2eYG_card` | dsh-client-ui-conversation |
| panel / content / options / navList / navCell | `VOzbGW_*` | dsh-client-ui-settings-general |

「主题设置」分区**不再靠探测注入**，改为注册官方 `settings.section` 插槽（`ctx.slots.register`），
面板本体仍是纯 DOM 构件（`Settings.buildPanel`），用 React `ref` 回调挂进插槽容器。

## 配置与安全说明

- **GitLab 令牌**：不明文落盘。保存时经 **Windows DPAPI（当前用户）加密**写入
  `services\gitlab-token.enc`；`gitlab-config.json` 只存 URL。旧版明文令牌首次启动自动迁移。
- **界面配置**：存于浏览器 localStorage（`dsh.bgConfig`），跟随浏览器。
- **默认背景**：设置 → 主题设置 →「设为默认背景」把当前背景写入 `assets\background.jpg`，
  前端经 `/default-background` 读取。
- **桥接服务安全**：CORS 仅放行**本机 origin**（回环 `127.0.0.1`/`localhost` + 本机所有网卡 IP），
  远程网页仍会被浏览器拦截；同时校验 Host 为回环地址（防 DNS rebinding）；前端输出统一 HTML 转义 + URL 白名单（http/https）。
- ⚠️ **git 仓库**：`services\gitlab-config.json` 不含令牌；`gitlab-token.enc`、`data\`、`node_modules\`
  均已被 `.gitignore` 排除。`lib/client.js` 是产物但**需要入库**（宿主直接读该文件）。

## 性能说明

- 系统监控/GitLab 轮询在**页面隐藏时暂停**，恢复可见立即刷新。
- 监控轮询（2s）与采样周期对齐；采样循环会扣掉自身耗时，使有效周期贴近 2 秒
  （`Get-Counter` 本身约 2~3 秒，是实际下限）。GitLab 数据 `ts` 未变化时跳过重渲染。
- 设置面板 DOM 观察器**防抖**（150ms），避免 React 高频更新触发大量重扫。

## 排查

| 现象 | 检查 |
|---|---|
| 插件完全没出现 | 刷新页面；`cordis.patch.yml` 里是否有哨兵块；`lib/client.js` 是否存在；重启 `dsh web` |
| 页面启动失败/白屏 | `cordis.patch.yml` 是否仍是顶层 YAML 数组（不能只剩注释）；浏览器控制台是否有 `did not activate` / `require(...) missed the module table` |
| 没有「主题设置」分区 | `settings.section` 插槽未注册成功，看控制台报错；确认 `inject: ["slots"]` 的服务已就绪 |
| 监控/任务无数据 | `start-services.ps1` 是否跑过；`curl http://127.0.0.1:3081/metrics`、`/tasks` |
| 终端连不上 | `terminal-bridge` 健康检查（`/health` 看 `pty`、`pwsh`）；`node_modules\ws`、`node-pty` 联接是否有效 |
| 主题只有背景生效、毛玻璃无效 | 结构探测没命中（DSH 改了类名），按上文表格补精确选择器 |
