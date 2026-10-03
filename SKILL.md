---
name: "file-manager-monitor"
description: "文件管理器 + 系统监控 + 网页终端（TypeScript 全栈：React 19 前端 + Bun 后端）。用于重建或改进 space-2 构件，或以 app/ 源码为起点二次开发。触发词：文件管理器、系统监控、file manager、space-2。"
---

# File Manager + Monitor

## Purpose

三层全栈应用：**文件页**（系统 / 工作区 / 构件 / 私有四种浏览模式，可编辑保存，图片可预览）+ **监控页**（CPU / 内存 / 磁盘 / 网络 / 进程，1 秒轮询画曲线，挂载点独立容量、每核 CPU、网卡拆分、目录占用排行、重启记录）+ **终端页签**（网页里执行 shell 命令）。`app/` 是完整源码快照，`references/architecture.md` 是架构说明。

## Workflow

1. 动手前先读 `references/architecture.md`，了解三层架构与特权合约（privileged contracts）的边界。
2. 改线上构件：走 `artifact.edit`（slug 为 `space-2`），**不要**手改 `~/workspace/ts-spaces/space-2` 下的文件——构建器是那里的唯一写者。
3. 改 skill 本身：行为有变化就同步更新 `references/changelog.md`；大改后把新源码快照同步到 `app/`（只收源码与配置，不收构建产物）。
4. 发版推送：见 `README.md`。

## Operating Rules

1. 构建产物永不进仓库：`dist/`、`.space-build/`、`.harness/`、`audits/`、`app.db`、`.bun-cache/`、`node_modules/` 一律排除。
2. 平台注入接口（`defineAction`、`definePrivilegedContracts`、`ctx.blobs`、drizzle 上下文）只在构件平台内可用；脱离平台用 Bun 独立运行需要写适配层，见 architecture.md 的"独立运行"节。
3. 网页终端是 RCE 级能力：只用于私有部署；公开仓库里不放任何真实主机名、真实路径、密钥或 token。
4. 特权进程以什么 OS 用户运行，决定了它真实能读写哪些目录；界面上的"可写"标注以实测（W_OK 检查）为准，不要硬编码假设。
