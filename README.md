# nano_dsh_interface

DeepSeek Harness 的界面增强插件包（本地定制版）。

## 功能

| 模块 | 说明 |
|---|---|
| **主题设置** | 设置 → 主题设置（左侧导航独立分区）：背景图片（本地选择）、遮罩颜色调色板、前景透明度、对话区毛玻璃开关与强度、**设为默认背景**（把当前背景拷贝为插件默认图 `background.jpg`，同步回插件仓库） |
| **系统监控悬浮窗** | 右下角悬浮窗：CPU / GPU / 内存 / 磁盘读写 / 网络上下行，可拖动、位置记忆；页面隐藏时自动暂停轮询 |
| **GitLab 任务** | VS Code 风格子窗口：指派给你的开放 Issue，标题栏拖动、四边吸附（上/下边横向排列）、列表项拖拽排序；数据未变化时跳过重渲染 |
| **PowerShell 终端** | 对话框下方多终端（横向排布、＋ 添加、可调高度）：xterm.js 全终端模拟（原生 PSReadLine：方向键/Tab 补全/历史），每终端显示当前路径，点击路径栏弹出**自研目录浏览器**（扫描当前路径下的子目录列表：单击进入、双击直达、⬆ 返回上一路径、⟳ 刷新、✎ 手动输入，不依赖系统文件夹弹窗）；断线**指数退避重连**（1s→2s→4s→…→上限 30s） |
| **界面定制** | 背景图 + 电影感遮罩 + 毛玻璃面板，浅色/深色主题自适应，配置存 localStorage 实时生效 |
| **后台服务状态** | 设置面板内实时显示 gitlab-bridge / terminal-bridge 健康状态 |

## 架构（v2：模块化重构）

前端拆分为 ES 模块（零构建，浏览器原生 `type="module"` 加载），
并通过"语义后缀探测"（`_root` / `_panel` / `_centerCol` …）定位 DSH 内部结构，
**不再依赖固定哈希类名**——DSH 前端升级导致类名变化时自动适配，失败则优雅降级。

```
nano_dsh_interface\
├── install.ps1            # 安装：自动探测 DSH 路径 + 复制资源 + 幂等修补 index.html
├── uninstall.ps1          # 卸载：还原 index.html + 删除资源/服务/加密令牌/生成数据
├── start-services.ps1     # 电脑重启后启动三个后台服务（含健康检查）
├── README.md
├── assets\                # 前端资源（会被复制到 dist/assets）
│   ├── background.jpg     # 默认背景图（可用"设为默认背景"在线替换）
│   ├── custom-background.css   # 样式（哈希无关选择器）
│   ├── custom-background.js    # 入口（装配各模块）
│   ├── modules\           # 前端模块（ES module）
│   │   ├── dshnano-core.js     # 配置读写 / apply 分发 / 结构探测 / 安全工具
│   │   ├── dshnano-theme.js    # 背景/遮罩/透明度/毛玻璃
│   │   ├── dshnano-monitor.js  # 系统监控悬浮窗
│   │   ├── dshnano-gitlab.js   # GitLab 任务子窗口
│   │   ├── dshnano-terminal.js # PowerShell 终端
│   │   └── dshnano-settings.js # 设置面板 UI
│   └── vendor\            # xterm.js 终端模拟器（本地提供，不依赖 CDN）
└── services\              # 后台服务（会被复制到 dsh-web-frontend 包目录）
    ├── terminal-bridge.mjs   # PowerShell 终端桥（ws://127.0.0.1:3082）
    ├── gitlab-bridge.mjs     # GitLab 任务桥（http://127.0.0.1:3081 + 默认背景写盘）
    ├── gitlab-tasks.ps1      # GitLab 任务 CLI（命令行查询）
    ├── gitlab-fetch.ps1      # （备用）GitLab 抓取脚本
    ├── metrics-writer.ps1    # 系统监控采样（默认每 2 秒写 metrics.json）
    ├── gitlab-config.json    # GitLab 地址（⚠️ 不含令牌）
    └── gitlab-config.json.example  # 配置模板（提交到 git 的版本）
```

## 安装

```powershell
# 默认自动探测当前 DSH 安装；换机器/重装后用 -Dist 指定
powershell -ExecutionPolicy Bypass -File install.ps1
powershell -ExecutionPolicy Bypass -File start-services.ps1
```

安装后刷新 DSH Web 页面（Ctrl+F5）生效。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

## 后台服务（电脑重启后需重新启动）

```powershell
powershell -ExecutionPolicy Bypass -File start-services.ps1
```

| 服务 | 端口 | 作用 |
|---|---|---|
| terminal-bridge | ws://127.0.0.1:3082 | PowerShell 终端（每连接独立 pwsh 会话，含目录扫描接口 `/list-dir` 供自研目录浏览器使用、健康接口 `/health`） |
| gitlab-bridge | http://127.0.0.1:3081 | GitLab 配置接口（`/config`、`/test`、`/health`）+ 每 30 秒抓取任务 + 默认背景接口 `/background` |
| metrics-writer | — | 每 2 秒采集系统指标写入 `dist/assets/metrics.json` |

## 配置与安全说明

- **GitLab 令牌**：不再明文落盘。保存时经 **Windows DPAPI（当前用户）加密**写入
  `gitlab-token.enc`；`gitlab-config.json` 只存 URL。旧版明文令牌首次启动自动迁移。
- **界面配置**：存于浏览器 localStorage（`dsh.bgConfig`），跟随浏览器。
- **默认背景**：设置 → 主题设置 → "设为默认背景" 把当前背景保存为
  `dist/assets/background.jpg`，并同步回插件仓库 `assets/background.jpg`
  （通过 start-services.ps1 注入的 `NANO_BG_SYNC_PATH`）。
- **桥接服务安全**：CORS 仅放行**本机 origin**（回环 `127.0.0.1`/`localhost` + 本机所有网卡 IP，
  兼容经局域网 IP 打开 DSH 页面），远程网页仍会被浏览器拦截；同时校验 Host 为回环
  地址（防 DNS rebinding）；前端输出统一 HTML 转义 + URL 白名单（http/https）。
- ⚠️ **git 仓库**：`services\gitlab-config.json` 不含令牌；`gitlab-token.enc`
  与含令牌的旧配置文件均已被 `.gitignore` 排除，不会入库。

## 性能说明

- 系统监控/任务轮询在**页面隐藏时暂停**，恢复可见立即刷新。
- 监控轮询周期（2s）与采样周期对齐；GitLab 数据 `ts` 未变化时跳过重渲染。
- 设置面板 DOM 观察器**防抖**（150ms），避免 React 高频更新触发大量重扫。
