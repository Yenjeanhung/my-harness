# 打包说明（Windows）

两条流水线，顺序执行：

```
Python 内核 ──PyInstaller──▶ harness-server.exe（sidecar）
                                        │ 内嵌
Electron + React ──electron-builder──▶ My-Harness Setup x.x.x.exe（NSIS 安装包）
```

## 前置条件

| 工具 | 用途 | 检查 |
|---|---|---|
| Python 3.11+（venv） | 内核与 sidecar | `python --version` |
| 项目已安装 | `pip install -e ".[dev]"` | `harness --help` |
| pyinstaller | 打 sidecar | `pyinstaller --version` |
| Node.js 18+ | 桌面端 | `npm --version` |
| apps/desktop 已装依赖 | `cd apps/desktop && npm install` | — |

可选环境变量（网络不佳时）：

```bash
export UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"     # pip/uv 镜像
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"       # electron 二进制
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
export npm_config_registry="https://registry.npmmirror.com"            # npm 镜像
```

## 第 1 步：打包 Python sidecar

在项目根目录（venv 激活状态下）：

```bash
pyinstaller --onefile --name harness-server \
  --collect-all litellm \
  --collect-all tiktoken \
  --collect-all tiktoken_ext \
  --collect-all mcp \
  --collect-all uvicorn \
  --collect-all langchain \
  --collect-all langchain_core \
  --collect-all langchain_openai \
  --collect-all langgraph \
  --hidden-import anyio._backends._asyncio \
  packaging/server_entry.py
```

- 产物：`dist/harness-server.exe`（onefile，约 60-120MB，启动需 3-10 秒解压，属正常）；
- `--collect-all litellm` 是必须的：litellm 用 importlib 动态加载各家 provider 子模块，静态分析收不齐；
- 验证（**必做**：构建期间源码还在改会打出半成品——version 与事件协议都可能是旧的）：

```bash
./dist/harness-server.exe --port 8123 &
sleep 10 && curl http://127.0.0.1:8123/health
# 期望 {"status":"ok","version":"<与 apps/desktop/package.json 一致>",...}
# version 不一致 = 产物过期，改完源码后重新执行本步
```

> prepkg.cjs 会在 `packaging/dist/` 与根 `dist/` 里挑较新的产物，无需手动拷贝；
> 也可以把根 `dist/harness-server.exe` 拷到 `packaging/dist/` 保持旧习惯。

## 第 2 步：打包 Windows 安装包

```bash
cd apps/desktop
npm run bundle        # esbuild 打 React 渲染进程
npx electron-builder --win
# 或一条龙（含 prepkg 拷贝 sidecar）：
npm run dist
```

- `prepkg.cjs` 会把 `packaging/dist/harness-server.exe` 拷到 `apps/desktop/build/`，electron-builder 经 extraResources 内嵌进安装包 resources/；
- 产物：`apps/desktop/dist/My-Harness Setup <版本>.exe`（NSIS 安装包，内嵌 sidecar）；
- 安装包内的启动逻辑：优先连接已运行的 daemon → 尝试 resources 里的 `harness-server.exe` → 回退 PATH 中的 `harness serve`。

## 产物清单与使用

| 文件 | 说明 |
|---|---|
| `dist/harness-server.exe` | 独立 daemon，可单独分发（`harness-server.exe --port 8765`） |
| `apps/desktop/dist/My-Harness Setup *.exe` | Windows 安装包（双击安装 / `/S` 静默安装） |
| `apps/desktop/dist/win-unpacked/` | 免安装目录版（便携版） |

安装后：开始菜单/桌面快捷方式启动；数据（事件库、记忆、评测报告）在 `~/.my-harness/`。

## 常见问题

1. **sidecar 启动报 `ModuleNotFoundError: litellm.llms...`**：说明 `--collect-all litellm` 漏了，或依赖更新后新增了动态导入模块——补对应 `--collect-all`。
2. **打包装不了 / SmartScreen 警告**：未签名属正常。正式分发需要代码签名证书（`win.sign` 配置），详见 DESIGN.md §9。
3. **无应用图标**：当前使用 Electron 默认图标；放一个 `apps/desktop/build/icon.ico`（256x256 以上，多尺寸）后 electron-builder 自动采用。
4. **杀毒软件报 sidecar**：PyInstaller onefile 的常见误报，签名后消失；也可改 `--onedir` 模式（`win-unpacked` 更快启动、误报率低）。
5. **配置文件**：安装版同样读取 CWD 下的 `my-harness.toml` 与环境变量 API key；首次使用建议先在终端跑通 `harness chat` 再用桌面端。

## 可选：绿色便携包

```bash
cd apps/desktop && npx electron-builder --win zip
```

产出 `dist/My-Harness-<version>-win.zip`，解压即用。
