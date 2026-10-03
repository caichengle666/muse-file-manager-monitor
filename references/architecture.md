# 架构说明（源码已逐文件核实，v1.1）

标准的 TypeScript space 三层架构：React 前端经类型化 RPC 调用 Bun 后端；后端分"普通 action"与"特权处理器"两类。

## 1. 前端 `app/client/src/App.tsx`

- 三个页签：**文件 / 监控 / 终端**；文件页下四种浏览模式（`system` / `workspace` / `build` / `private`），用 `useState` 状态机切换数据源。
- 经 `app/client/src/api.ts` 类型化 RPC 代理调用后端（POST 到 `./actions`）；React Query 做请求缓存；监控图表用 recharts；图标为手写 SVG 路径（13 种线条图标）。
- 监控页每 3 秒轮询快照，前端保留最近 30 个采样点画历史曲线。

## 2. 私有模式（v1.2 起：真实目录，不再是虚拟存储）

私有模式直接映射构件沙盒内的真实目录 `data/private`（界面显示绝对路径），与第 3 节的宿主文件操作共用同一套逻辑：浏览、预览、编辑保存（临时文件原子替换）、新建文件/目录、上传、下载、移动/重命名、永久删除。

- 删除流程："隔离改名 → 真删 → 结果核验 → 失败恢复"，避免"报错但东西没了"的不一致状态。
- 文件夹有可达的删除入口（含手机端）；面包屑根节点为"私有"。
- v1.1 及之前：私有是虚拟文件系统（SQLite `workspace_items` 表存元数据 + 平台 blob 存内容）；v1.2 已废弃该模型，`updateTextFile` 无条件删旧 blob 的数据丢失 bug 随之消除。

## 3. 特权服务端 `app/server/src/privileged.ts`（真正碰操作系统的部分）

用 `definePrivilegedContracts` / `definePrivilegedHandlers` 声明，单个合约 5 秒超时，直接调 Node 的 `fs` / `os` 接口：

| 合约 | 能力 |
|---|---|
| `listHostDirectory` | 列真实目录。根分别映射到 `/`（系统）、`~/workspace`（工作区）、编译输出目录（构件）；单目录最多 500 项，按文件夹→文件→链接排序 |
| `readHostTextFile` | 读文本文件。v1.1 起支持分块/分页读取，大文件不再被 500KB 一刀切 |
| `writeHostTextFile` | 写文本文件。先校验文本类型与 W_OK 写权限；目录可写时用"同目录临时文件 + rename"原子写入（保留原 mode），目录不可写但文件可写时降级为直接覆盖；失败清理临时文件 |
| `runCommand`（v1.1 新增） | 执行 shell 命令，单次 5 秒超时，终端页签用它 |
| `getSystemSnapshot` | 监控快照：CPU 取两次 `/proc/stat` 间隔 **1 秒**算差值（v1.1 前是 220ms，抖动大，现加最近 5 次滑动平均）；内存读 `/proc/meminfo`（MemAvailable）；磁盘 `statfs("/")`；网络两次读 `/proc/net/dev`（排除 lo）算每秒速率；扫 `/proc/<pid>/stat` 取前 18 个进程按 CPU 排序 |

## 4. 安全机制（v1.1 已放宽，保留底线）

- **敏感文件过滤加开关**：`blockedNames` 正则（`.env`、`credentials`、`*secret*`、`*password*`、`*token*`、`.ssh`、`*.pem`、`*.key`、`id_rsa*` 等）默认隐藏，界面可切换显示。
- **目录穿越防护**：`safeRelative` + `resolveInside`，路径含 `..` 直接拒绝，解析后必须仍在根目录内。
- **符号链接**：v1.1 起允许跟随（此前只列出不跟随）。
- **文本判定** `isLikelyText`：43 种已知文本扩展名直接放行，否则检查文件头 64KB——含 NUL 字节、UTF-8 严格解码失败、或控制字符超 2% 即判二进制；二进制不再直接拒绝，提供 hex 预览或下载。
- **编辑门控**：前端编辑按钮仅当后端返回 `editable=true`（文本类型 + 有写权限）才显示。

## 5. 独立运行（脱离构件平台）

以下接口由构件平台注入，`app/` 源码直接 `bun run` 跑不起来，需要写适配层（shim）：

- `defineAction` / `definePrivilegedContracts` / `definePrivilegedHandlers` → 改为普通 HTTP 路由（如 Elysia/Hono）+ 本地函数调用
- `ctx.blobs` → 改为本地目录或 S3 兼容存储
- drizzle 上下文 → 直连 `app.db`（bun:sqlite）
- 前端 `api.ts` 的 `./actions` 相对路径 → 指向实际后端地址

前端本身是纯静态产物（`client/build.mjs` 构建），可直接用任何静态服务器托管。

## 7. 服务重启记录（v1.3）

- 新增数据库表（drizzle 迁移）：累计重启次数 + 每次启动时间戳，持久化，重启不清零。
- 登记时机：当前运行时没有"服务启动前"生命周期钩子，登记发生在首次 `getSystemSnapshot` 请求时（懒登记）；快照返回 `restartCount` / `lastRestartAt` / `bootedAt`，前端 3 秒轮询展示，本地时间精确到秒，另有本次 uptime。
- 已知局限：多 worker 部署下同一服务实例可能被重复计数；单进程部署实测"终止→拉起"计数 1→2、前次启动时间保留，正确。

## 6. 数据

- 私有文件：v1.2 起直接存于沙盒真实目录 `data/private`；旧的 `workspace_items` 表（SQLite）仅为 v1.1 遗留，不再使用。
- 无外部数据源（见 `app/DATA-PLAN.md`）：内容全部来自用户输入与本机采集。
