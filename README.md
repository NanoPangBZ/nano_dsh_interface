# nano_dsh_interface

DeepSeek Harness 的界面增强插件包（本地定制版）。

## 功能

| 模块 | 说明 |
|---|---|
| **主题设置** | 设置 → 主题设置（左侧导航独立分区）：背景图片（本地选择）、遮罩颜色调色板、前景透明度、对话区毛玻璃开关与强度 |
| **系统监控悬浮窗** | 右下角悬浮窗：CPU / GPU / 内存 / 磁盘读写 / 网络上下行，可拖动、位置记忆 |
| **GitLab 任务** | VS Code 风格子窗口：指派给你的开放 Issue，标题栏拖动、四边吸附（上/下边横向排列）、列表项拖拽排序 |
| **PowerShell 终端** | 对话框下方多终端（横向排布、＋ 添加、可调高度）：xterm.js 全终端模拟（原生 PSReadLine：方向键/Tab 补全/历史），每终端显示当前路径，点击弹原生文件夹选择框换目录 |
| **界面定制** | 背景图 + 电影感遮罩 + 毛玻璃面板，浅色/深色主题自适应，配置存 localStorage 实时生效 |

## 目录结构

```
nano_dsh_interface\
├── install.ps1            # 安装：复制资源 + 幂等修补 index.html
├── uninstall.ps1          # 卸载：还原 index.html + 删除资源/服务
├── start-services.ps1     # 电脑重启后启动三个后台服务
├── README.md
├── assets\                # 前端资源（会被复制到 dist/assets）
│   ├── background.jpg
│   ├── custom-background.css
│   ├── custom-background.js
│   └── vendor\            # xterm.js 终端模拟器（本地提供，不依赖 CDN）
└── services\              # 后台服务（会被复制到 dsh-web-frontend 包目录）
    ├── terminal-bridge.mjs   # PowerShell 终端桥（ws://127.0.0.1:3082）
    ├── gitlab-bridge.mjs     # GitLab 任务桥（http://127.0.0.1:3081 + 抓取）
    ├── gitlab-tasks.ps1      # GitLab 任务 CLI（命令行查询）
    ├── gitlab-fetch.ps1      # （备用）GitLab 抓取脚本
    ├── metrics-writer.ps1    # 系统监控采样（每 2 秒写 metrics.json）
    ├── gitlab-config.json    # GitLab 地址与令牌（⚠️ 不入库，安装时复制）
    └── gitlab-config.json.example  # 配置模板（提交到 git 的版本）
```

## 安装

```powershell
# 默认目标为当前 DSH 安装；换机器/重装后用 -Dist 指定
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
| terminal-bridge | ws://127.0.0.1:3082 | PowerShell 终端（每连接独立 pwsh 会话，含文件夹选择接口 `/pick-folder`） |
| gitlab-bridge | http://127.0.0.1:3081 | GitLab 配置接口（`/config`、`/test`）+ 每 30 秒抓取任务 |
| metrics-writer | — | 每 2 秒采集系统指标写入 `dist/assets/metrics.json` |

## 配置说明

- **GitLab**：令牌保存在 `services\gitlab-config.json`（安装后位于 dsh-web-frontend 包目录），也可在 设置 → 主题设置 → GitLab 配置 里在线修改。
- **界面配置**：存于浏览器 localStorage（`dsh.bgConfig`），跟随浏览器。
- ⚠️ **git 仓库**：`services\gitlab-config.json`（含你的访问令牌）已被 `.gitignore` 排除，不会入库；换环境时复制 `services\gitlab-config.json.example` 为 `gitlab-config.json` 并填入令牌即可。
