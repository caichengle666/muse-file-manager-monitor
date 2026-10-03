# muse-file-manager-monitor

文件管理器 + 系统监控 + 网页终端，一套 Muse skill。拿去就能复刻出同款构件。

## 你是第一次看到这个仓库？按这四步走

1. 把仓库 clone 下来：
   ```bash
   git clone https://github.com/caichengle666/muse-file-manager-monitor.git
   ```
2. 把整个文件夹放进你的 Muse 的 skills 目录（`~/workspace/skills/`）。目录名即 skill 名，不用改。
3. 跟你的 Muse 说这句话（复制粘贴就行）：
   > 用 muse-file-manager-monitor 这个 skill，按它 SKILL.md 里 "Rebuild" 章节，从零构建一个文件管理器+监控构件。
4. 构建完让它按 SKILL.md 里 Rebuild 第 5 步的验收清单逐项验证：文件四种模式浏览/新建/删除/上传下载、图片查看器、监控 1 秒刷新、终端执行命令、重启计数。

你不需要懂代码，Muse 会照着 skill 里的源码（`app/`）和说明全自动搭出来。已实测：只给仓库 URL 就能完整复刻。

## 复刻出来的是什么

- **文件页**：系统（`/`）/ 工作区 / 构件输出 / 私有四种浏览模式；文本在线编辑（原子写入）；图片点击弹出深色查看器（缩放/1:1/适应窗口/下载/同目录切换）；"上一级"可自由上行到 `/`
- **监控页**（1 秒轮询）：每个挂载点独立容量、磁盘 I/O 速率、每核 CPU 曲线、1/5/15 分钟负载、内存细分、按网卡拆分的上下行速率、Top 进程（按 CPU/内存排序）、主机信息；`/home/hatch` 一级目录占用排行（手动扫描）；服务重启记录（累计次数/上次启动时间，持久化）
- **终端页签**：网页里执行 shell 命令（单次 5 秒超时）

复刻的是"功能空壳"，不带原作者的任何文件和数据。

## 常见问题

- **需要什么环境？** 你的 Muse 账号就行（构件平台）。skill 源码依赖平台注入的接口（`defineAction`、`definePrivilegedContracts` 等），同一平台直接可用；想搬到别的平台自己跑，看 `references/architecture.md` 的"独立运行"节写适配层。
- **安不安全？** 网页终端是 RCE 级能力：只部署在你完全控制的私有环境，不要暴露到公网。敏感文件显隐开关默认隐藏。
- **我想改功能怎么办？** 直接跟你的 Muse 说，它会照着 skill 改；改完记得让它把新源码快照同步回 skill 的 `app/`（流程见 `SKILL.md` 的 Workflow）。
- **skill 里都有什么？** `SKILL.md`（入口，给 AI 看的操作手册）、`references/architecture.md`（架构说明）、`references/changelog.md`（版本记录）、`app/`（完整源码快照，v0.1）。

## 原作者维护说明（与你无关，除非你是原作者）

- 改线上构件走 `artifact.edit`（slug `space-2`），不要手改 `~/workspace/ts-spaces/space-2`
- 大改后把新源码快照同步到 `app/`（只收源码与配置，不收 `dist/`、`.space-build/`、`.harness/`、`audits/`、`app.db`、`.bun-cache/`）
- 构建产物永不进仓库

## License

MIT
