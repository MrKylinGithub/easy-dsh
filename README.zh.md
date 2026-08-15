# EasyDSH

<div align="center">

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面端壳——双击启动 `dsh web` 原生窗口，不用终端、不用管端口。**

[English](README.md) · 简体中文

</div>

> **非官方**：EasyDSH 是个人独立项目，与 DeepSeek 无隶属或背书关系。

## 功能

- **三种启动来源，每次启动都问**
  - **内置版本** — 打包时内置 `@deepseek-ai/dsh@latest`，完全离线、秒启动
  - **官方最新版** — 启动时解析最新发布版号，首次自动安装，之后自动跟随新版本
  - **指定目录…** — 从任意本地 dsh checkout（比如你的魔改 fork）源码运行
- **多窗口隔离（⌘N）** — 每个窗口一个独立 dsh 进程 + 独立端口，共享同一个
  `~/.dsh`：会话、Key、设置、插件全部互通；关窗口即回收它专属的进程
- **永远用自己的端口** — 绝不附着已有 dsh。从首选端口（默认 3081）向上扫描
  （+1、+2…最多 +100）——选择器选了什么版本，窗口里就是什么版本
- **菜单跟随 dsh** — 应用菜单语言跟随 dsh 的 `locale.preference`；标题栏跟随
  界面深浅主题；版本选择弹窗跟随操作系统语言
- **无需 Node/pnpm** — 自动在 `~/.dsh/desktop-bin/` 生成 node/npm 垫片；内置/
  最新版跑在 Electron 自带 Node 上，源码版优先用满足 dsh 引擎的系统 Node
- **复制粘贴全通** — 标准「编辑」菜单 + 右键剪贴板菜单
- **友好的报错窗口** — 固定尺寸、可滚动，再长的堆栈也能点到关闭按钮

## 下载

安装包发布在 [Releases](https://github.com/MrKylinGithub/easy-dsh/releases)：

| 平台 | 文件 |
| --- | --- |
| macOS（Apple Silicon） | `EasyDSH-0.1.0-arm64.dmg` |
| Windows（x64） | 即将发布 |

macOS 首次打开如提示未验证开发者：右键 → 打开（未签名构建）。

## 工作原理

```
窗口A ── dsh 进程A ── 端口 3081 ─┐
窗口B ── dsh 进程B ── 端口 3082 ─┼─ 共享同一份 ~/.dsh
窗口C ── dsh 进程C ── 端口 3083 ─┘
```

1. 启动 → 版本选择窗口询问用哪个来源（上次选择标「上次使用」；命令行
   `--dsh <选择>` 显式指定则跳过弹窗）
2. 从首选端口向上扫描第一个可绑定端口
3. 每窗口自持 dsh 进程；退出应用回收全部自起进程，你终端里的 dsh 不受影响

## 从源码构建

```sh
git clone https://github.com/MrKylinGithub/easy-dsh.git
cd easy-dsh
npm install        # 首次
npm start          # 开发运行

npm run dist:mac   # macOS → dist/EasyDSH-0.1.0-arm64.dmg
npm run dist:win   # Windows → 需要 wine 或 Windows 机器
npm run dist       # 两者都打
```

`scripts/build.mjs` 将下载固定到 npmmirror 镜像，并自动下载 electron-builder
icons 工具集（sha256 校验），构建不会卡在 GitHub 下载。

命令行覆盖（`npm start -- --port 8080`）：

| 参数 | 作用 |
| --- | --- |
| `--dsh <选择>` | `builtin` / `latest` / `dir:<路径>`，跳过选择窗口 |
| `--host <ip>` | 监听地址（默认 127.0.0.1） |
| `--port <n>` | 首选端口（默认 3081） |
| `--keep-server` | 退出时保留服务 |
| `--devtools` | 每个窗口自动开开发者工具 |

## 配置

首次运行自动生成 `~/.dsh/desktop.json`：

```json
{
  "repo": "/path/to/deepseek-harness",
  "host": "127.0.0.1",
  "port": 3081,
  "keepServerOnQuit": false,
  "dshSource": "dir:/path/to/deepseek-harness"
}
```

- 官方来源首次使用时把 `@deepseek-ai/dsh@<version>` 安装到
  `~/.dsh/desktop-versions/dsh-<version>/`（走 npmmirror）
- 日志：`~/.dsh/desktop.log`（壳自身）、`~/.dsh/desktop-server.log`（dsh web 输出）

## 插件兼容性

EasyDSH 与你的终端 dsh 共享同一份 `~/.dsh`。profile 里的外部插件从**宿主安装**
解析 `@deepseek-ai/*` 包——请把它们声明为 `peerDependencies`
（如 `">=0.1.0-rc.5 <0.2.0"`），并以 npm tarball 方式安装插件，不要用
目录 `link:`，更不要自带 dsh 副本（会破坏这个契约）。

## 安全

本仓库**不含任何密钥**。API 凭据在 `~/.dsh/.credentials.yaml`，由 dsh 本体
管理；`~/.dsh/desktop.json` 只有路径和端口；运行日志仅存本机。

## 目录结构

```
easy-dsh/
  src/main.js      # Electron 主进程：选择器、服务、窗口、主题/语言同步
  scripts/build.mjs# 打包入口：镜像加速 + icons 工具集自动下载
  build/           # 应用图标源文件（icon.svg → icon.png）
  builtin-dsh/     # 打包时内置的 @deepseek-ai/dsh（gitignore）
  package.json     # electron-builder 配置（mac dmg / win nsis），asar:false
```

## 许可证

[MIT](LICENSE)。应用图标使用 MIT 协议的
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库中
DeepSeek logo 素材；EasyDSH 本身不是 DeepSeek 产品。
