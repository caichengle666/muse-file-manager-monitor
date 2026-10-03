---
name: "file-manager-monitor"
description: "文件管理器 + 系统监控 + AI Agent 网页终端（TypeScript 全栈：React 19 前端 + Bun 后端）。用于从零重建同款构件，或以 app/ 源码为起点二次开发。触发词：文件管理器、系统监控、AI 终端、file manager。"
---

# File Manager + Monitor

## Source Repository

本 skill 的完整源码仓库是：

`https://github.com/caichengle666/muse-file-manager-monitor`

第一次复刻时，如果当前工作区还没有 `app/` 目录，先拉取仓库：

```bash
git clone https://github.com/caichengle666/muse-file-manager-monitor.git
cd muse-file-manager-monitor
```

然后把仓库中的 `app/` 作为构件源码输入。复刻时必须复制 `app/client/`、`app/server/`、`app/drizzle/`、`app/space.json`、`app/bunfig.toml` 和 `app/tsconfig.base.json`；不要复制 `preview.html`，它只是本地静态预览文件，不属于构件运行时。

如果已经在一个现有 skill 或构件目录中工作，先读取仓库最新的 `SKILL.md`、`references/architecture.md` 和 `app/` 源码，再开始重建，不要根据记忆重新猜测文件内容。

## Purpose

三层全栈应用：**文件页**（系统 / 工作区 / 构件 / 私有四种浏览模式，可编辑保存，图片可预览）+ **监控页**（CPU / 内存 / 磁盘 / 网络 / 进程，1 秒轮询画曲线，挂载点独立容量、每核 CPU、网卡拆分、目录占用排行、重启记录）+ **终端页签**（网页 Shell + 外部 OpenAI-compatible API 驱动的多步 AI Agent）。`app/` 是完整源码快照，`references/architecture.md` 是架构说明。

## Workflow（日常维护，原作者环境）

1. 动手前先读 `references/architecture.md`，了解三层架构与特权合约（privileged contracts）的边界。
2. 改线上构件：走 `artifact.edit`（slug 为 `space-2`），**不要**手改 `~/workspace/ts-spaces/space-2` 下的文件——构建器是那里的唯一写者。
3. 改 skill 本身：行为有变化就同步更新 `references/changelog.md`；大改后把新源码快照同步到 `app/`（只收源码与配置，不收构建产物）。
4. 发版推送：见 `README.md`。

## Rebuild（第一次用这个 skill 的 Muse：从零重建看这里）

### 铁律（违反视为任务失败）
1. 用户说"复刻"即默认**复刻模式**，不得询问用户、不得自行切换到重新设计。
2. 复刻模式 = **逐文件原样复制** `app/` 下全部源码（`client/`、`server/`、`drizzle/`、配置文件）：不重新设计 UI、不改布局、不改文案、不换配色、不换技术栈。完成后的视觉和功能必须与原版一致。
3. 唯一允许的改动：为适配新环境**必须**改的东西（且要在最终回复里逐项说明改了什么、为什么改）。
4. **二开模式**仅在用户明确要求改动或加功能时启用；改完按 changelog 记一笔。

1. 先读完本文件、`references/architecture.md` 和 `references/changelog.md`，重点看 changelog 里每个版本"为什么这么改"（比如：私有模式为什么从虚拟文件系统改成真实目录、"上一级"为什么放开、系统启动时间为什么改读 btime）。
2. 在你的 Muse 里创建一个新的 web_fullstack artifact（名字和 slug 你自己定，不要沿用 `space-2`），把 `app/` 下的 `client/`（React 19 前端）和 `server/`（Bun 后端）源码完整交给构建器。**复刻模式下必须逐文件原样复用，不得重写或重新设计**；平台接口（`defineAction`、`definePrivilegedContracts`、`ctx.blobs`、drizzle 上下文）在同一 Muse 构件平台直接可用。
3. 平台接口：本项目依赖构件平台注入的 `defineAction`、`definePrivilegedContracts`、`ctx.blobs` 和 drizzle 上下文——同一 Muse 构件平台上这些直接可用；换到别的平台，按 `references/architecture.md` 的"独立运行"节写适配层。
4. 数据库：`app/drizzle/` 下有三个 migration（`meta/_journal.json` 登记执行顺序），都是幂等的 `CREATE TABLE IF NOT EXISTS`：
   - `workspace_items.sql`：旧私有虚拟文件系统的表，v1.2 起业务已废弃（私有改成真实目录），但十几个旧 action 代码仍引用它，保留建表；
   - `service_restart_record.sql`：服务重启记录表（累计次数/上次启动时间），监控页用。
   - `ai_provider_config.sql`：外部 AI 服务配置表（兼容 OpenAI 的 base URL、API Key、模型、更新时间）；API Key 只由服务端读取，前端只显示是否已配置。
5. AI 终端 Agent：复刻时必须保留 `getAiProviderConfig`、`saveAiProviderConfig`、`listAiModels`、`generateAiShellCommand`、`runAiTask` 这些 action。配置流程是：填写 OpenAI-compatible API 地址和 Key → 拉取模型 → 选择模型 → 保存到服务器；模型地址会经过公网校验（拒绝 localhost/私网/链路本地/.local）。Agent 流程是：自然语言任务 → 生成一条命令 → 在沙盒执行 → 把 stdout/stderr 回传模型 → 继续下一步，直到模型返回 `done=true`；需要确认时服务端返回一次性 `confirmToken`，前端确认后原样回传。**`runAiTask` 每次调用只做一件事**（要么问模型要命令，要么执行已排队命令），多步循环由前端反复调用驱动——不要把整个循环塞进一个请求，否则平台网关会报 `Gateway request timed out: spaces.cvm.post`。
6. 命令权限：命令分类在 `server/src/commandPolicy.ts`，采用**白名单**而非黑名单——只有明确只读的命令和已知测试命令自动执行，其余（修改、删除、移动、安装、权限变更、未识别命令）一律暂停等待确认。服务端会为待确认命令生成一次性 `confirmToken`，前端确认时必须回传，命令内容不匹配或令牌复用都会被拒绝；不要退回成客户端 `approvePending` 布尔值。单条命令最长 30 秒，超时后把结果回传 Agent 并结束该步。
7. 构建完按这份清单验收：文件页四种模式浏览 / 新建 / 删除 / 重命名 / 上传 / 下载；点图片弹出深色查看器（缩放/1:1/下载/左右切换）；监控页 1 秒刷新、九项指标有数；终端能执行命令并返回结果；AI 配置可拉取模型并落盘；输入多步任务后 Agent 能读取命令输出继续下一步；修改/删除命令会暂停确认；重启服务后"累计重启次数"加 1。
8. 安全：网页终端和 AI Agent 都是 RCE 级能力，只部署在你完全控制的私有环境，不要暴露到公网；敏感文件开关默认隐藏；公开仓库不要写入真实 API Key、主机名或路径。AI 模型地址必须通过 `requirePublicBaseUrl`（拒绝 localhost/私网/链路本地/.local，且禁用重定向），API Key 明文落盘属于已知限制，请把 `app.db` 当作密钥文件保护。Agent 任务有 30 分钟 TTL、单任务并发锁和 100 个任务上限，任务执行中不要重启服务（内存态会丢）。

## Operating Rules

1. 构建产物永不进仓库：`dist/`、`.space-build/`、`.harness/`、`audits/`、`app.db`、`.bun-cache/`、`node_modules/` 一律排除。
2. 平台注入接口（`defineAction`、`definePrivilegedContracts`、`ctx.blobs`、drizzle 上下文）只在构件平台内可用；脱离平台用 Bun 独立运行需要写适配层，见 architecture.md 的"独立运行"节。
3. 网页终端是 RCE 级能力：只用于私有部署；公开仓库里不放任何真实主机名、真实路径、密钥或 token。
4. 特权进程以什么 OS 用户运行，决定了它真实能读写哪些目录；界面上的"可写"标注以实测（W_OK 检查）为准，不要硬编码假设。
