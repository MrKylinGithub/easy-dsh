# EasyDSH（easy-dsh）

DeepSeek Harness 的桌面端壳（Desktop shell）：一个命令/双击启动，自动拉起 `dsh web` 服务并在原生窗口里显示 Web GUI。**同一套代码，macOS 和 Windows 都支持。**

## 为什么是 Electron

- dsh 本身就是 Node + pnpm 生态：Electron 主进程就是 Node，能直接 `spawn('pnpm', ['dsh', 'web', ...])`，不用像 Tauri 那样为外部进程编排额外引入 Rust 工具链。
- 渲染引擎就是 Chromium，和浏览器里的 dsh 页面渲染效果完全一致。
- electron-builder 一套配置打 macOS `.dmg` 和 Windows 安装包（`nsis`）。

## 行为

1. **永远使用自己的端口和进程**：启动即从首选端口（默认 3081，可配置）
   向上扫描第一个可绑定端口（+1、+2…最多 +100），绝不附着/复用已有
   dsh——选择器选了什么版本，窗口里就是什么版本。你终端里的 dsh 不受影响，
   两者共享同一份 `~/.dsh` 数据。
2. **多窗口 = 多进程隔离**：菜单「文件 → 新建窗口」（⌘N）为每个窗口启动
   一个独立的 dsh 进程 + 独立端口（+1 分配），共享同一个 `~/.dsh`——
   会话/Key/配置全通，进程互不干扰。关闭窗口回收它专属的进程。
3. 退出应用时，回收**自己拉起的全部**进程（`keepServerOnQuit` 时保留）。
4. 单实例：重复启动只会聚焦已有窗口。
5. 页面里外链（文档等）走系统默认浏览器打开。
6. 无 Node/pnpm 环境也能跑：应用在 `~/.dsh/desktop-bin/` 生成 node/npm 垫片注入 PATH；源码运行优先用满足 dsh 引擎要求的**系统 Node**（dsh 的 tsx 加载链在部分 Node 大版本上有兼容问题），没有时才退回 Electron 内置 Node。

## 使用

```sh
cd easy-dsh
npm install        # 首次
npm start          # 开发运行（终端里能看到日志）

# 打包
npm run dist:mac   # macOS: dist/EasyDSH-0.1.0-arm64.dmg
npm run dist:win   # Windows: 需要 wine（或直接在 Windows 机器上跑）
npm run dist       # 两者都打
```

命令行覆盖（`npm start -- --port 8080`）：

| 参数 | 作用 |
| --- | --- |
| `--dsh <选择>` | 本次启动用哪个来源：`builtin` / `latest` / `dir:<路径>` |
| `--repo <path>` | dsh checkout 目录 |
| `--host <ip>` | 监听地址（默认 127.0.0.1） |
| `--port <n>` | 端口（默认 3081） |
| `--keep-server` | 退出应用时不关掉服务 |
| `--devtools` | 打开窗口时自动开开发者工具 |

## 配置

首次运行自动生成 `~/.dsh/desktop.json`：

```json
{
  "repo": "/Users/<you>/Documents/GitHub/ai-learning/deepseek-harness",
  "host": "127.0.0.1",
  "port": 3081,
  "keepServerOnQuit": false,
  "dshSource": "dir:/Users/<you>/Documents/GitHub/ai-learning/deepseek-harness"
}
```

### 启动时的 dsh 版本选择（每次启动都弹出）

**每次启动都会弹出选择窗口**，三个选项：

1. **内置版本** — `@deepseek-ai/dsh@latest` 在打包时装入 `builtin-dsh/` 随 App
   分发，**完全离线**、秒启动，无需任何下载
2. **官方最新版（latest）** — 启动时从 registry 解析最新版号（npmmirror），
   首次自动安装到 `~/.dsh/desktop-versions/dsh-<version>/`，之后离线秒启动；
   新版本发布后下次启动自动跟随。npx 的语义，但避开了 npx 每次重新解析
   900+ 依赖的分钟级开销
3. **指定目录…** — 点击条目直接用上次选过的目录进入应用（描述区显示该目录
   路径），点条目右侧的文件夹图标才弹出目录选择器；从源码运行

选中的来源记为 `dshSource`（`builtin` / `latest` / `dir:<path>`），下次启动
选择窗口会把它标成「上次使用」，但**仍会弹出让你确认**：

- 命令行 `--dsh latest` / `--dsh dir:<path>` 显式指定时跳过选择窗口
  （脚本/自动化用）
- 菜单「服务 → 切换 dsh 版本…」重启并进入选择窗口

菜单「服务」里有「打开配置文件」「打开服务端日志」快捷入口。日志文件：

- `~/.dsh/desktop.log` — 桌面端自身日志
- `~/.dsh/desktop-server.log` — dsh web 服务输出

## 目录结构

```
easy-dsh/
  src/main.js      # Electron 主进程：配置、服务拉起/附着/回收、窗口、主题同步
  scripts/build.mjs# 打包入口：镜像加速 + icons 工具集自动下载（sha256 校验）
  build/           # 应用图标源文件（icon.svg → icon.png）
  package.json     # electron-builder 打包配置（mac dmg / win nsis）
```

## 对外分享 / 安全

这个项目**不包含任何密钥**，可以直接开源分享：

- 全部代码只做「拉起 dsh web + 显示页面」，不接触 API 凭证；
- 你的 DeepSeek API Key 存在 **`~/.dsh/.credentials.yaml`（家目录）**，由 dsh 本体管理，和本项目、和分享出去的代码完全隔离；
- 运行期配置 `~/.dsh/desktop.json` 只有 repo 路径/端口，没有敏感信息；
- 运行日志 `~/.dsh/desktop*.log` 里可能有会话内容，只在你本机，分享前无需处理（除非你手动把日志文件拷进仓库）。

分享前的建议：

1. `.gitignore` 已排除 `node_modules/`、`dist/`、`tools/`（第三方构建工具缓存，克隆后会自动重新下载）；
2. 建议加一个 `LICENSE`（如 MIT）再公开；
3. 图标使用了 DeepSeek 官方仓库的 logo 素材（`deepseek-harness/website/public/favicon.svg`），如公开发布请注明是**非官方**的个人封装项目。

