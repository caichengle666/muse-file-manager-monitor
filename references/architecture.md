# 架构说明

标准的 TypeScript space 三层架构：React 前端经类型化 RPC 调用 Bun 后端；后端分"普通 action"与"特权处理器"两类。

## 1. 前端 `app/client/src/App.tsx`

- 三个页签：**文件 / 监控 / 终端**；文件页下四种浏览模式（`system` / `workspace` / `build` / `private`），用 `useState` 状态机切换数据源。
- 经 `app/client/src/api.ts` 类型化 RPC 代理调用后端（POST 到 `./actions`）；React Query 做请求缓存；监控图表用 recharts；图标为手写 SVG 路径（13 种线条图标）。
- 监控页每 1 秒轮询快照，前端保留最近 60 个采样点画历史曲线。

## 2. 私有模式（真实目录）

私有模式直接映射构件沙盒内的真实目录 `data/private`（界面显示绝对路径），与第 3 节的宿主文件操作共用同一套逻辑：浏览、预览、编辑保存（临时文件原子替换）、新建文件/目录、上传、下载、移动/重命名、永久删除。

- 删除流程："隔离改名 → 真删 → 结果核验 → 失败恢复"，避免"报错但东西没了"的不一致状态。
- 文件夹有可达的删除入口（含手机端）；面包屑根节点为"私有"。
- 早期私有模式是虚拟文件系统（SQLite `workspace_items` 表存元数据 + 平台 blob 存内容）。`migratePrivateWorkspace` 先检查标记文件，已迁移就直接返回、不再读旧表和 blob；未迁移时按批（每批最多 1000 项、约 16 MB）写入真实目录，已存在的文件跳过，所以中断后下次会接着迁，最后一批写入标记文件。单个旧文件超过 12 MB 时停止迁移并提示。前端每次打开页面只在首次进入私有模式时调用一次；迁移失败只弹提示，私有目录照常列出。

## 3. 特权服务端 `app/server/src/privileged.ts`（真正碰操作系统的部分）

用 `definePrivilegedContracts` / `definePrivilegedHandlers` 声明，直接调 Node 的 `fs` / `os` / `child_process` 接口。每个合约有自己的超时：

| 合约 | 超时 | 能力 |
|---|---|---|
| `listHostDirectory` | 5 秒 | 列真实目录。根分别映射到 `/`（系统）、`~/workspace`（工作区）、编译输出目录（构件）、`data/private`（私有）；单目录最多 500 项，先按文件夹→文件→其他排序再截断，大目录里的文件夹不会被截掉 |
| `listHostImages` | 10 秒 | 列同目录图片，供查看器左右切换 |
| `readHostFileChunk` | 5 秒 | 分块读取文件，文本或十六进制，大文件分页 |
| `readHostDownloadChunk` | 5 秒 | 分块读取原始字节供下载 |
| `getHostImagePreview` | 10 秒 | 读取图片（上限 15 MB） |
| `writeHostTextFile` | 5 秒 | 写文本文件。先校验文本类型、整个文件是合法 UTF-8（GBK 等编码的文件拒绝保存，避免写回替换字符损坏原文件）与 W_OK 写权限；用"同目录临时文件（固定长度文件名，长文件名也能保存）+ rename"原子替换，写完后 chmod 回原权限位（含 setuid/setgid，不受 umask 影响），以 root 运行时同时保留原属主/属组；目录不可写时拒绝保存（不降级为直接覆盖）；文件有多个硬链接、或以非 root 运行而文件属于其他用户时原地写入以保留链接和属主 |
| `createHostFile` / `createHostDirectory` / `deleteHostEntry` / `moveHostEntry` / `uploadHostFile` | 5 秒 | 新建、删除、移动/重命名、上传（单文件 12 MB） |
| `materializePrivateWorkspace` | 15 秒 | 旧私有数据迁移（见第 2 节） |
| `executeShell` | 30 秒 | 执行 shell 命令，命令本身 25 秒超时（低于合约超时，保证结果能回传）；超时后用 SIGKILL 杀掉整个进程组（sudo 模式下由 root 侧的 `timeout -s KILL` 执行）；stdin 关闭；stdout/stderr 流式解码（多字节字符跨块不乱码），各保留前 1 MB，超出部分丢弃但保留末尾用于读取 cwd 标记，所以大输出后 cwd 仍正确 |
| `readSystemSnapshot` | 5 秒 | 监控快照：CPU 取两次 `/proc/stat` 间隔 600 毫秒算差值（总体 + 每核，无平滑）；内存读 `/proc/meminfo`（MemAvailable）；容量取 `/`、`/home/hatch`、`/tmp` 三个挂载点的 `statfs`；磁盘 I/O 读 `/proc/diskstats`；网络两次读 `/proc/net/dev`（总计排除 lo）算每秒速率；扫 `/proc/<pid>/stat` 取 Top 进程（按 CPU / 内存两种排序）；启动时间读 `/proc/stat` 的 btime |
| `scanHomeDirectories` | 5 秒 | `/home/hatch` 一级目录占用，每次只量一个目录（`du` 3.8 秒超时） |

## 4. 安全机制

- **敏感文件过滤加开关**：`blockedNames` 正则（`.env`、`credentials`、`*secret*`、`*password*`、`*token*`、`.ssh`、`*.pem`、`*.key`、`id_rsa*` 等）默认隐藏，界面可切换显示。开关由前端传入，是界面过滤，不是安全边界。
- **路径处理**：路径含 `.` / `..` 段直接拒绝；各模式根目录是"起始目录"而不是围墙，允许"上一级"一路向上导航到 `/`。删除/移动会先解析父目录真实路径再做敏感名过滤。
- **符号链接**：浏览时跟随；保存文本时写入解析后的真实文件，并在写前拒绝符号链接叶子；删除和移动作用于链接本身（不跟随，失效链接也能删除），父目录先解析真实路径。删除先改名为同目录固定长度的临时名再删除。路径解析与系统调用之间仍不是原子的，高并发本机改动仍有理论窗口。
- **文本判定** `isLikelyText`：43 种已知文本扩展名直接放行，否则检查文件头 64KB——含 NUL 字节、UTF-8 严格解码失败、或控制字符超 2% 即判二进制；二进制提供 hex 预览或下载。
- **编辑门控**：前端编辑按钮仅当后端返回 `editable=true`（文本类型、一次读完整个文件、整个文件是合法 UTF-8、有写权限）才显示。文本分页在 UTF-8 字符边界切分。
- **命令确认（黑名单模型）**：`app/server/src/commandPolicy.ts` 只拦截会写入、修改、移动或删除文件和数据的命令；读取、网络读取、进程查看、安装、服务、容器和未知命令自动执行。解析器按 bash 规则处理引号（单引号内反斜杠是普通字符）、转义、heredoc/here-string、命令替换和进程替换（递归检查内部命令），拆开 `sudo`/`timeout`/`env`/`xargs`/`nice`/`nohup`/`command`/`exec`/`time`/`stdbuf`/`ionice`/`flock`/`taskset`/`chrt`/`nsenter`/`unshare`/`setpriv`/`runuser`/`coproc` 等包装命令及其带参数选项找到真正的命令，递归检查 `bash -c`、`su -c`（选项可在用户名之后）、`flock -c`、`script -c`（`script` 默认写记录文件也算写入）字符串、`function` 函数体、`find -exec`、`eval` 的字面内容；awk 把输出管道给 shell 或解释器、sed 的 `e` 命令和 `s///e` 标志都按执行未知代码处理。`((cmd) )` 按嵌套子 shell 而不是算术解析。重定向到 `/dev/null`、`/dev/stdout`、`/dev/stderr` 和 `2>&1` 这类描述符复制不算写入。命令名本身是动态的（`$VAR`、`$(...)`、反引号、`$'..'`、通配符、`{a,b}` 花括号展开）、`eval` 动态内容、shell 或解释器执行来自管道的未知代码时一律需要确认；`$VAR`/`$(...)` 只作为只读命令的参数时照常自动执行。这是尽力而为的静态分析，不是沙盒。
- **确认令牌**：命令需要确认时服务端生成一次性 `confirmToken`（只存 SHA-256），它只对当前这条待执行命令有效，用后即焚；队列里换了命令或用户拒绝后旧令牌失效。令牌没有单独的过期时间，随任务 30 分钟 TTL 失效。页面刷新后服务端会为同一条待确认命令重新发令牌。令牌防的是模型自行推进，不是访问控制：真正的访问控制是平台登录。网页终端的 `executeShell` action 执行用户亲手输入的命令，不经过确认（给同一个调用方发令牌不增加任何保护）。
- **AI 接口防护**：模型 base URL 必须是公网 http(s)：拒绝 localhost（含末尾点）、私网、链路本地、CGNAT、198.18/15、组播和 240/4 保留段、`.local`/`.internal`，请求前解析 DNS 并拒绝解析到内网的地址，禁止重定向。fetch 会再次解析，DNS 重绑定不在防护范围内（尽力而为）。拉取模型列表 60 秒超时。只填主机时自动补 `/v1`；填了路径（如 `/v1/openai`、`/v1beta/openai`、`/api/v3`）就按原样使用。
- **API Key**：明文存在 SQLite `ai_provider_config`，只由服务端读取；配置接口只返回是否已保存和打码提示（如 `sk-…abcd`），前端用密码框，留空即沿用已存的 Key，但只在 API 地址与保存时同源时沿用；换了地址必须重新填写，已存的 Key 不会被发往别的主机。请把 `app.db` 当密钥文件保护。
- **Agent 调用模型**：`runAiTask` 每次调用只做一件事——要么问模型要下一步命令（60 秒超时），要么执行已排队的命令（25 秒超时）；多步循环由前端反复调用驱动（每次点击最多 40 轮，约 20 步，到上限会提示点「继续」），避免 `Gateway request timed out: spaces.cvm.post`。模型返回 `done=true` 但带了命令时，先执行命令而不是丢弃。模型给出超过 4000 字符的命令时不排队，而是要求模型拆成多条较短命令（终端和 Agent 共用同一上限）。每步 stdout/stderr 各保留 12000 字符（模型看到的也是这些），任务只保留最近 50 步；前端带上已有步数 `knownSteps`，服务端只返回新步骤。
- **用户反馈**：待确认命令旁有「拒绝」按钮；拒绝或在等待确认时输入新消息，服务端会撤销待确认命令，把用户意见作为消息交给模型继续；用户没见过的自动执行命令不会被当成「已拒绝」，照常执行。任务进行中输入的补充要求也会进入模型上下文。
- **模型输出解析**：请求显式声明 `bash` function tool；`message` 兼容 `content` 字符串、分段数组、`tool_calls` 与旧的 `function_call` 四种形状；工具参数若为原始命令字符串会自动包装成 JSON；JSON 解析失败时依次尝试「首个括号平衡对象」和「从文本抢救 command/explanation/done 字段」（容忍截断、尾逗号、单引号、无引号键），都不行再回退 ```bash 代码块首条命令。全部为本地实现，不引入 JSON repair 依赖。
- **失败诊断**：模型调用失败时抛出 `AiRequestError`，携带阶段（request / http / response-json / model-json）、请求 URL、模型名、HTTP 状态、原始响应片段和模型返回内容；`runAiTask` 通过 `diagnostic` 字段返回给前端，对话区展示为可复制卡片。诊断里不包含 API Key。`AiDiagnostic`、`AiRequestError`、`describeAiError` 均在 `server/src/aiSecurity.ts`。
- **重试**：只重试暂时性失败——网络错误/超时、HTTP 429 和 5xx、模型空输出（`AiEmptyOutputError`，例如中转站返回 `tool_calls` 但 arguments 恒为 `{}`），最多 2 次。只有空输出会追加纠正提示并去掉 `tools` 声明，逼模型走纯 JSON 文本路径；401/403/404、模型名错误和无法解析的输出直接报错。
- **Agent 状态**：任务内存态，30 分钟 TTL、按任务 id 的并发锁（在第一次 await 之前加锁，重启后并发恢复也不会重复执行同一条命令）、最多 100 个任务、消息总量上限 120k 字符（裁剪时保留系统提示和任务描述）。每步结束后把任务状态写入 `ai_agent_context.state_json`，服务重启后可以恢复。清除上下文时仍在执行的调用结束后不会把任务写回。

## 5. 数据

- 私有文件：沙盒真实目录 `data/private`。
- `app/drizzle/` 有 4 个 migration，全部 `CREATE TABLE IF NOT EXISTS`，都登记在 `meta/_journal.json`：
  - `service_restart_record`：服务重启记录（第 6 节）；
  - `workspace_items`：旧私有虚拟文件系统，只有 `migratePrivateWorkspace` 还读它；
  - `ai_provider_config`：AI 服务配置（base URL、API Key、模型、更新时间）；
  - `ai_agent_context`：AI 对话（`messages_json` 是界面对话记录，`state_json` 是服务端任务状态，`pending_command` 供界面恢复待确认命令；`confirm_token` 列已不再写入，保留只为与已部署的表结构一致）。
- `actions.ts` 的 `ensureTables` 在每个进程里执行一次同样的建表语句，覆盖数据库被恢复但没有迁移状态的情况。
- 无外部数据源：内容全部来自用户输入与本机采集。

## 6. 服务重启记录

- 数据库表 `service_restart_record`：累计重启次数 + 本次/上次启动时间戳，持久化，重启不清零。
- 登记时机：当前运行时没有"服务启动前"生命周期钩子，登记发生在首次 `getSystemSnapshot` 请求时（懒登记）；快照返回 `serviceRestartCount` / `serviceStartedAt` / `previousServiceStartedAt` / `serviceUptimeSec`，以及主机的 `bootedAt`，前端 1 秒轮询展示。
- 已知局限：多 worker 部署下同一服务实例可能被重复计数；单进程部署实测"终止→拉起"计数 1→2、前次启动时间保留，正确。

## 7. 独立运行（脱离构件平台）

以下接口由构件平台注入，`app/` 源码直接 `bun run` 跑不起来，需要写适配层（shim）：

- `defineAction` / `definePrivilegedContracts` / `definePrivilegedHandlers` → 改为普通 HTTP 路由（如 Elysia/Hono）+ 本地函数调用
- `ctx.blobs` → 改为本地目录或 S3 兼容存储（只有旧私有数据迁移用到）
- drizzle 上下文 → 直连 `app.db`（bun:sqlite）
- 前端 `api.ts` 的 `./actions` 相对路径 → 指向实际后端地址

前端本身是纯静态产物（`client/build.mjs` 构建），可直接用任何静态服务器托管。
