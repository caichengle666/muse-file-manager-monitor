---
name: "file-manager-monitor"
description: "文件管理器 + 系统监控 + 网页终端（TypeScript 全栈：React 19 前端 + Bun 后端）。用于从零重建同款构件，或以 app/ 源码为起点二次开发。触发词：文件管理器、系统监控、file manager。"
---

# File Manager + Monitor

## Purpose

三层全栈应用：**文件页**（系统 / 工作区 / 构件 / 私有四种浏览模式，可编辑保存，图片可预览）+ **监控页**（CPU / 内存 / 磁盘 / 网络 / 进程，1 秒轮询画曲线，挂载点独立容量、每核 CPU、网卡拆分、目录占用排行、重启记录）+ **终端页签**（网页里执行 shell 命令）。`app/` 是完整源码快照，`references/architecture.md` 是架构说明。

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
4. 数据库：`app/drizzle/` 下有两个 migration（`meta/_journal.json` 登记执行顺序），都是幂等的 `CREATE TABLE IF NOT EXISTS`：
   - `workspace_items.sql`：旧私有虚拟文件系统的表，v1.2 起业务已废弃（私有改成真实目录），但十几个旧 action 代码仍引用它，保留建表；
   - `service_restart_record.sql`：服务重启记录表（累计次数/上次启动时间），监控页用。
5. 构建完按这份清单验收：文件页四种模式浏览 / 新建 / 删除 / 重命名 / 上传 / 下载；点图片弹出深色查看器（缩放/1:1/下载/左右切换）；监控页 1 秒刷新、九项指标有数；终端能执行命令并返回结果；重启服务后"累计重启次数"加 1。
6. 安全：网页终端是 RCE 级能力，只部署在你完全控制的私有环境，不要暴露到公网；敏感文件开关默认隐藏。

## Operating Rules

1. 构建产物永不进仓库：`dist/`、`.space-build/`、`.harness/`、`audits/`、`app.db`、`.bun-cache/`、`node_modules/` 一律排除。
2. 平台注入接口（`defineAction`、`definePrivilegedContracts`、`ctx.blobs`、drizzle 上下文）只在构件平台内可用；脱离平台用 Bun 独立运行需要写适配层，见 architecture.md 的"独立运行"节。
3. 网页终端是 RCE 级能力：只用于私有部署；公开仓库里不放任何真实主机名、真实路径、密钥或 token。
4. 特权进程以什么 OS 用户运行，决定了它真实能读写哪些目录；界面上的"可写"标注以实测（W_OK 检查）为准，不要硬编码假设。
