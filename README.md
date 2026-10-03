# muse-file-manager-monitor

文件管理器 + 系统监控 + 网页终端。TypeScript 全栈：React 19 前端 + Bun 后端。

这是 **Muse skill**：`SKILL.md` 是入口，`references/` 是架构与变更记录，`app/` 是完整源码快照（v0.1）。

## 安装为 skill

```bash
git clone https://github.com/caichengle666/muse-file-manager-monitor.git
# 把整个仓库文件夹放进 Muse 的 skills 目录即可，目录名即 skill 名：
#   ~/workspace/skills/muse-file-manager-monitor/
```

然后按 `SKILL.md` 的 Workflow 操作。

## 功能

- **文件页**：系统（`/`）/ 工作区 / 构件输出 / 私有四种浏览模式；文本文件在线编辑保存（临时文件 + 原子替换）；图片点击弹出深色查看器（缩放/1:1/适应窗口/下载/同目录左右切换）
- **L1**：敏感文件显隐开关、符号链接跟随、二进制 hex 预览/下载、大文件分块读取
- **L2**：宿主目录的新建、删除、重命名/移动、上传、下载；"上一级"可自由上行到 `/`
- **监控页**（1 秒轮询）：每个挂载点独立容量（`/`、`/home/hatch`、`/tmp`）、磁盘 I/O 速率、双核 CPU 曲线、1/5/15 分钟负载、内存细分（已用/缓存/缓冲）、按网卡拆分的上下行速率、Top 进程（按 CPU/内存排序）、主机信息（内核/主机名/启动时间）；`/home/hatch` 一级目录占用排行（手动扫描按钮，不进轮询）；**服务重启记录**：累计重启次数、上次重启时间、本次启动时间（持久化，重启不清零）
- **终端页签**：网页里执行 shell 命令（单次 5 秒超时）
- **私有文件**：直接映射真实目录（界面显示绝对路径），与宿主目录共用同一套文件操作；删除用"隔离改名→真删→核验→失败恢复"流程

## 架构速览

```
浏览器 (React 19, App.tsx)
   │  类型化 RPC (POST ./actions)
   ▼
Bun 后端
 ├── actions.ts ── 普通动作：私有目录文件操作、私有 blob 清理
 └── privileged.ts ── 特权合约：列目录/读写文件/跑命令/读 /proc、/sys
```

详细见 [`references/architecture.md`](references/architecture.md)，变更记录见 [`references/changelog.md`](references/changelog.md)。

## 作为 skill 使用

把本仓库放进 Muse 的 `~/workspace/skills/`（目录名即 skill 名），按 `SKILL.md` 的 Workflow 操作：

- 改线上构件走 `artifact.edit`（slug `space-2`），不要手改 `~/workspace/ts-spaces/space-2`
- 大改后把新源码快照同步到 `app/`（只收源码与配置，不收 `dist/`、`.space-build/`、`.harness/`、`audits/`、`app.db`、`.bun-cache/`）

## 独立运行

`app/` 源码依赖构件平台注入的接口（`defineAction`、`definePrivilegedContracts`、`ctx.blobs` 等），直接 `bun run` 跑不起来。独立部署需要写适配层：把合约改成普通 HTTP 路由、blob 改成本地目录、drizzle 直连 `bun:sqlite`。前端是纯静态产物，可直接托管。

## 安全提醒

- 网页终端是 RCE 级能力：**只用于你完全控制的私有部署**，不要把带终端的版本暴露到公网
- 敏感文件显隐开关默认隐藏；打开后 `.env`、密钥类文件一览无余，注意屏幕共享/录屏场景
- 真实读写权限取决于运行进程的 OS 用户，界面标注以实测为准

## License

MIT
