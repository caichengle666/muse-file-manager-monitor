import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim, fileToBase64 } from "@hatch/space-sdk/client";
import {
Area,
AreaChart,
CartesianGrid,
Line,
LineChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";

type HostListing = ApiResponse<typeof api, "listHostDirectory">;
type HostEntry = HostListing["entries"][number];
type Snapshot = ApiResponse<typeof api, "getSystemSnapshot">;
type Tab = "files" | "terminal" | "monitor";
type FileMode = "system" | "workspace" | "build" | "private";
type HostRoot = FileMode;
type Preview = { name: string; mime: string; url?: string; text?: string; note?: string; hostRoot?: HostRoot; hostPath?: string; editable?: boolean; mode?: "text" | "hex"; offset?: number; nextOffset?: number; totalSize?: number; eof?: boolean; showSensitive?: boolean };
type HostDialog =
  | { type: "file" }
  | { type: "folder" }
  | { type: "move"; item: HostEntry }
  | { type: "delete"; item: HostEntry }
  | null;
type TerminalEntry = { command: string; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; cwd: string; durationMs: number; source?: "shell" | "agent" };
type AgentStep = { command: string; stdout: string; stderr: string; cwd: string; exitCode: number | null; requiresConfirmation: boolean };
type AgentDiagnostic = { phase: string; url: string; status: number | null; model: string; detail: string; responseSnippet: string; contentSnippet: string };
type AgentMessage = { role: "user" | "assistant"; text: string; steps?: AgentStep[]; diagnostic?: AgentDiagnostic | null };
type MonitorHistory = { time: string; cpu: number; memory: number; rx: number; tx: number; [key: string]: string | number };
type DirectoryUsage = { name: string; path: string; size: number; timedOut: boolean };
type ImageViewerState = {
  item: HostEntry;
  images: HostEntry[];
  dataUri: string | null;
  mimeType: string | null;
  size: number;
  message: string;
  tooLarge: boolean;
  loading: boolean;
};

type GlyphName = "folder" | "file" | "upload" | "plus" | "edit" | "trash" | "copy" | "cut" | "paste" | "refresh" | "download" | "close" | "chevron" | "previous" | "next" | "zoomIn" | "zoomOut" | "fit" | "actual";

function Glyph({ name, size = 18 }: { name: GlyphName; size?: number }) {
  const paths: Record<GlyphName, ReactNode> = {
    folder: <path d="M3 6.5h6l1.7 2H21v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Zm0 2h18" />,
    file: <path d="M6 2.8h8l4 4V21H6V2.8Zm8 0V7h4" />,
    upload: <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v5h16v-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    edit: <path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Zm9-12.5 3.5 3.5" />,
    trash: <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />,
    copy: <path d="M8 8h12v12H8V8Zm-4 8V4h12" />,
    cut: <path d="m4 4 16 16M20 4 4 20M7 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm14 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />,
    paste: <path d="M9 5h6v3H9V5Zm-3 2H4v14h16V7h-2M8 12h8m-8 4h6" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5m10-3a8 8 0 0 0-13-2l-2 2m1 6a8 8 0 0 0 13 2l2-2" />,
    download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16" />,
    close: <path d="M5 5l14 14M19 5 5 19" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    previous: <path d="m15 5-7 7 7 7" />,
    next: <path d="m9 5 7 7-7 7" />,
    zoomIn: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5M10.5 7.5v6m-3-3h6" /></>,
    zoomOut: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5M7.5 10.5h6" /></>,
    fit: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
    actual: <path d="M5 4h14v16H5zM8 8h3v3H8z" />,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const imageFilePattern = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;
function isImageFile(item: HostEntry): boolean {
  return (item.kind === "file" || (item.kind === "link" && item.targetKind === "file")) && imageFilePattern.test(item.name);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const unit = units[index] ?? "B";
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function byteAxisCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}天 ${hours}小时` : `${hours}小时 ${minutes}分钟`;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function formatLocalDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function ActionButton({ children, onClick, disabled, tone = "neutral", ariaLabel }: { children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: "neutral" | "accent" | "danger"; ariaLabel?: string }) {
  return <button type="button" className={`action-button action-${tone}`} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>{children}</button>;
}

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("files");
  const [fileMode, setFileMode] = useState<FileMode>("system");
  const [hostPath, setHostPath] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [imageViewer, setImageViewer] = useState<ImageViewerState | null>(null);
  const [history, setHistory] = useState<MonitorHistory[]>([]);
  const [directoryUsage, setDirectoryUsage] = useState<DirectoryUsage[]>([]);
  const [directoryScanBusy, setDirectoryScanBusy] = useState(false);
  const [directoryScanProgress, setDirectoryScanProgress] = useState(0);
  const [showSensitive, setShowSensitive] = useState(false);
  const [hostDialog, setHostDialog] = useState<HostDialog>(null);
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([]);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const terminalCwdRef = useRef<Record<string, string>>({});
  const agentMirrorRef = useRef(0);
  const hostUploadRef = useRef<HTMLInputElement>(null);

  const hostQuery = useQuery({
    queryKey: ["host-directory", fileMode, hostPath, showSensitive],
    queryFn: async () => {
      if (fileMode === "private") {
        const migration = await api.migratePrivateWorkspace({});
        if (!migration.ok) throw new Error(migration.message);
      }
      return api.listHostDirectory({ root: fileMode, path: hostPath, showSensitive });
    },
    enabled: tab === "files",
  });
  useEffect(() => {
    const listed = hostQuery.data;
    if (listed?.ok && listed.root === fileMode && listed.path && listed.path !== hostPath) setHostPath(listed.path);
  }, [fileMode, hostPath, hostQuery.data]);

  const monitorQuery = useQuery({
    queryKey: ["system-snapshot"],
    queryFn: () => api.getSystemSnapshot({}),
    enabled: tab === "monitor",
    refetchInterval: tab === "monitor" ? 1000 : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    const snapshot = monitorQuery.data;
    if (!snapshot) return;
    setHistory((current) => {
      if (current.at(-1)?.time === snapshot.sampledAt) return current;
      const point: MonitorHistory = {
        time: snapshot.sampledAt,
        cpu: Number(snapshot.cpuPercent.toFixed(1)),
        memory: Number(snapshot.memory.percent.toFixed(1)),
        rx: snapshot.network.rxPerSec,
        tx: snapshot.network.txPerSec,
      };
      for (const core of snapshot.cpuCores) point[`core-${core.name}`] = Number(core.percent.toFixed(1));
      return [...current, point].slice(-60);
    });
  }, [monitorQuery.data]);

  async function openHostImage(item: HostEntry, gallery?: HostEntry[]) {
    let images = gallery ?? (hostQuery.data?.entries.filter(isImageFile) ?? [item]);
    setPreview(null);
    setImageViewer({ item, images, dataUri: null, mimeType: null, size: item.size, message: "正在载入图片…", tooLarge: false, loading: true });
    try {
      const galleryRequest = gallery ? Promise.resolve(null) : api.listHostImages({ root: fileMode, path: hostQuery.data?.absolutePath ?? "", showSensitive });
      const [result, completeGallery] = await Promise.all([
        api.getHostImagePreview({ root: fileMode, path: item.path, showSensitive }),
        galleryRequest,
      ]);
      if (completeGallery?.ok && completeGallery.entries.some((entry) => entry.path === item.path)) images = completeGallery.entries;
      const dataUri = result.ok && result.dataBase64 && result.mimeType ? `data:${result.mimeType};base64,${result.dataBase64}` : null;
      setImageViewer((current) => current?.item.path === item.path ? {
        item,
        images,
        dataUri,
        mimeType: result.mimeType,
        size: result.size || item.size,
        message: result.message,
        tooLarge: result.tooLarge,
        loading: false,
      } : current);
    } catch {
      setImageViewer((current) => current?.item.path === item.path ? { ...current, message: "图片加载失败，请重试或下载后查看。", loading: false } : current);
    }
  }

  async function openHostFile(item: HostEntry, offset = 0) {
    const isFile = item.kind === "file" || (item.kind === "link" && item.targetKind === "file");
    if (!isFile) return;
    if (isImageFile(item)) { await openHostImage(item); return; }
    setBusy(true);
    try {
      const result = await api.readHostFileChunk({ root: fileMode, path: item.path, offset, limit: 262144, showSensitive });
      if (!result.ok || result.content === null || !result.name || !result.mode) { setNotice(result.message); return; }
      setPreview({ name: result.name, mime: "text/plain", text: result.content, note: result.message, hostRoot: fileMode, hostPath: item.path, editable: result.editable && result.eof && offset === 0, mode: result.mode, offset: result.offset, nextOffset: result.nextOffset, totalSize: result.totalSize, eof: result.eof, showSensitive });
    } catch { setNotice("文件预览无法打开。"); }
    finally { setBusy(false); }
  }

  async function downloadHostFile(item: HostEntry) {
    setBusy(true);
    try {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let name = item.name;
      let eof = false;
      while (!eof) {
        const result = await api.readHostDownloadChunk({ root: fileMode, path: item.path, offset, limit: 524288, showSensitive });
        if (!result.ok || result.dataBase64 === null) { setNotice(result.message); return; }
        name = result.name ?? name;
        const binary = atob(result.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        chunks.push(bytes);
        offset = result.nextOffset;
        eof = result.eof;
        if (!eof && bytes.byteLength === 0) throw new Error("empty chunk");
      }
      const blob = new Blob(chunks, { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已准备下载 ${name}（${formatBytes(blob.size)}）。`);
    } catch { setNotice("下载没有完成，请重试。"); }
    finally { setBusy(false); }
  }

  async function onHostUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 12_000_000) { setNotice("单个上传文件不能超过 12 MB。"); return; }
    setBusy(true);
    try {
      const encoded = await fileToBase64(file);
      const result = await api.uploadHostFile({ root: fileMode, directory: hostPath, name: file.name, dataBase64: encoded.dataBase64, showSensitive });
      setNotice(result.message);
      if (result.ok) await hostQuery.refetch();
    } catch { setNotice("上传没有完成，请检查目录权限。"); }
    finally { setBusy(false); }
  }

  async function runHostMutation(task: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(true);
    try {
      const result = await task();
      setNotice(result.message);
      if (result.ok) { setHostDialog(null); await hostQuery.refetch(); }
    } catch { setNotice("操作没有完成，请刷新目录确认实际状态后重试。"); }
    finally { setBusy(false); }
  }

  async function loadPreviewPage(offset: number) {
    if (!preview?.hostRoot || !preview.hostPath) return;
    const item: HostEntry = { name: preview.name, path: preview.hostPath, kind: "file", targetKind: null, size: preview.totalSize ?? 0, modifiedAt: new Date().toISOString(), writable: Boolean(preview.editable), removable: false };
    await openHostFile(item, Math.max(0, offset));
  }

  async function runTerminal(command: string, root: HostRoot, path: string) {
    if (/^clear\s*;?\s*$/.test(command)) { setTerminalHistory([]); return; }
    setTerminalBusy(true);
    try {
      const contextKey = `${root}:${path}`;
      const result = await api.executeShell({ command, root, path, cwd: terminalCwdRef.current[contextKey] ?? null });
      if (result.cwd) terminalCwdRef.current[contextKey] = result.cwd;
      setTerminalHistory((current) => [...current, { command, ...result }].slice(-30));
    } catch {
      setTerminalHistory((current) => [...current, { command, stdout: "", stderr: "命令执行请求失败。", exitCode: null, timedOut: false, cwd: "", durationMs: 0 }].slice(-30));
    } finally { setTerminalBusy(false); }
  }

  function mirrorAgentSteps(steps: AgentStep[]) {
    if (steps.length < agentMirrorRef.current) agentMirrorRef.current = 0;
    if (steps.length <= agentMirrorRef.current) return;
    const appended = steps.slice(agentMirrorRef.current).map((step) => ({ command: step.command, stdout: step.stdout, stderr: step.stderr, exitCode: step.exitCode, timedOut: false, cwd: step.cwd, durationMs: 0, source: "agent" as const }));
    agentMirrorRef.current = steps.length;
    setTerminalHistory((current) => [...current, ...appended].slice(-30));
  }

  async function scanHomeUsage() {
    if (directoryScanBusy) return;
    setDirectoryScanBusy(true);
    setDirectoryScanProgress(0);
    setDirectoryUsage([]);
    const collected: DirectoryUsage[] = [];
    let offset = 0;
    try {
      while (true) {
        const result = await api.scanHomeDirectories({ offset });
        if (!result.ok) { setNotice(result.message); break; }
        if (result.item) collected.push(result.item);
        setDirectoryUsage([...collected].sort((a, b) => b.size - a.size));
        setDirectoryScanProgress(result.total > 0 ? Math.round((result.nextOffset / result.total) * 100) : 100);
        if (result.done || result.nextOffset <= offset) break;
        offset = result.nextOffset;
      }
    } catch { setNotice("目录扫描中断；已保留扫描成功的结果。"); }
    finally { setDirectoryScanBusy(false); }
  }

  async function savePreviewFile(content: string): Promise<boolean> {
    if (!preview?.hostRoot || !preview.hostPath) return false;
    setBusy(true);
    try {
      const result = await api.writeHostTextFile({ root: preview.hostRoot, path: preview.hostPath, content, showSensitive: preview.showSensitive ?? false });
      setNotice(result.message);
      if (!result.ok) return false;
      setPreview((current) => current ? { ...current, text: content, note: "刚刚保存", editable: true } : current);
      await queryClient.invalidateQueries({ queryKey: ["host-directory"] });
      return true;
    } catch { setNotice("保存没有完成；请刷新目录确认原文件仍在。"); return false; }
    finally { setBusy(false); }
  }

  const snapshot = monitorQuery.data;
  const visibleFileCount = hostQuery.data?.entries.length ?? 0;

  function changeFileMode(next: FileMode) {
    setFileMode(next);
    setHostPath("");
    setHostDialog(null);
    setPreview(null);
    setImageViewer(null);
  }

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <header className="mode-header pt-safe">
        <div className="brand-mark"><span className="brand-mark-icon">M</span><span><strong>Muse</strong><small>FILE OPERATIONS</small></span></div>
        <nav className="mode-switch" aria-label="主功能">
          <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>文件</button>
          <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>终端</button>
          <button className={tab === "monitor" ? "active" : ""} onClick={() => setTab("monitor")}>监控</button>
        </nav>
        <div className="header-state" aria-live="polite">
          <span className={`status-dot ${tab === "monitor" && snapshot ? "live" : ""}`} />
          {tab === "monitor" ? (snapshot ? `${formatTime(snapshot.sampledAt)} 采样` : "正在连接") : tab === "terminal" ? (terminalBusy ? "执行中" : "30 秒上限") : `${visibleFileCount} 项`}
        </div>
      </header>

      <div className="workspace-layout">
        <aside className="workspace-rail" aria-label="工作区导航">
          <div className="rail-kicker">WORKSPACE</div>
          <div className="rail-title">运行控制台</div>
          <div className="rail-nav">
            <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}><span>01</span>文件浏览</button>
            <button className={tab === "monitor" ? "active" : ""} onClick={() => setTab("monitor")}><span>02</span>系统监控</button>
            <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}><span>03</span>网页终端</button>
          </div>
          <div className="rail-status"><span className="status-dot live" /><div><strong>服务在线</strong><small>本地沙盒运行环境</small></div></div>
          <div className="rail-footer">MUSE / OPS<br />v0.1 workspace</div>
        </aside>
        <main className="content-wrap">
        {tab === "files" ? (
          <section aria-label="文件浏览器">
            <div className="source-switch" role="tablist" aria-label="文件来源">
              <button role="tab" aria-selected={fileMode === "system"} className={fileMode === "system" ? "active" : ""} onClick={() => changeFileMode("system")}>系统</button>
              <button role="tab" aria-selected={fileMode === "workspace"} className={fileMode === "workspace" ? "active" : ""} onClick={() => changeFileMode("workspace")}>工作区</button>
              <button role="tab" aria-selected={fileMode === "build"} className={fileMode === "build" ? "active" : ""} onClick={() => changeFileMode("build")}>构件</button>
              <button role="tab" aria-selected={fileMode === "private"} className={fileMode === "private" ? "active" : ""} onClick={() => changeFileMode("private")}>私有</button>
            </div>
            <HostFilesView
              query={hostQuery} root={fileMode} path={hostPath} busy={busy} showSensitive={showSensitive}
              uploadRef={hostUploadRef} onUpload={onHostUpload} onNavigate={setHostPath} onOpen={openHostFile}
              onDownload={downloadHostFile} onSensitiveChange={setShowSensitive} onDialog={setHostDialog}
            />
          </section>
        ) : tab === "terminal" ? (
          <TerminalView entries={terminalHistory} busy={terminalBusy} onRun={runTerminal} onClear={() => { setTerminalHistory([]); agentMirrorRef.current = 0; }} onAgentSteps={mirrorAgentSteps} />
        ) : (
          <MonitorView snapshot={snapshot} history={history} loading={monitorQuery.isPending} error={monitorQuery.isError} onRefresh={() => void monitorQuery.refetch()} directoryUsage={directoryUsage} scanBusy={directoryScanBusy} scanProgress={directoryScanProgress} onScan={() => void scanHomeUsage()} />
        )}
        </main>
      </div>

      {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示"><Glyph name="close" size={15} /></button></div>}
      {hostDialog && <HostEditDialog dialog={hostDialog} currentPath={hostPath} busy={busy} onClose={() => setHostDialog(null)} onSubmit={(name, targetDirectory) => {
        if (hostDialog.type === "file") return runHostMutation(() => api.createHostFile({ root: fileMode, directory: hostPath, name, showSensitive }));
        if (hostDialog.type === "folder") return runHostMutation(() => api.createHostDirectory({ root: fileMode, directory: hostPath, name, showSensitive }));
        if (hostDialog.type === "move") return runHostMutation(() => api.moveHostEntry({ root: fileMode, path: hostDialog.item.path, targetDirectory, newName: name, showSensitive }));
        return runHostMutation(() => api.deleteHostEntry({ root: fileMode, path: hostDialog.item.path, showSensitive }));
      }} />}
      {preview && <PreviewDialog preview={preview} busy={busy} onClose={() => setPreview(null)} onSave={savePreviewFile} onPage={loadPreviewPage} />}
      {imageViewer && <ImageViewer viewer={imageViewer} busy={busy} onClose={() => setImageViewer(null)} onNavigate={(item) => void openHostImage(item, imageViewer.images)} onDownload={(item) => void downloadHostFile(item)} />}
    </div>
  );
}

function HostFilesView({ query, root, path, busy, showSensitive, uploadRef, onUpload, onNavigate, onOpen, onDownload, onSensitiveChange, onDialog }: {
  query: { data?: HostListing; isPending: boolean; isError: boolean; error?: Error | null; refetch: () => Promise<unknown> };
  root: HostRoot; path: string; busy: boolean; showSensitive: boolean; uploadRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void; onNavigate: (path: string) => void; onOpen: (item: HostEntry) => void;
  onDownload: (item: HostEntry) => void; onSensitiveChange: (value: boolean) => void; onDialog: (dialog: HostDialog) => void;
}) {
  const data = query.data;
  const currentAbsolutePath = data?.absolutePath || path;
  const currentParts = currentAbsolutePath.split("/").filter(Boolean);
  const parentPath = currentParts.length <= 1 ? "/" : `/${currentParts.slice(0, -1).join("/")}`;
  const atFileSystemRoot = currentAbsolutePath === "/";
  const startLabel = root === "system" ? "系统（起始）" : root === "workspace" ? "工作区（起始）" : root === "build" ? "构件（起始）" : "私有（起始）";
  return <div className="host-files">
    <div className="file-hero host-hero">
      <div className="breadcrumbs" aria-label="当前位置">
        {(data?.breadcrumbs ?? [{ name: startLabel, path: "" }]).map((crumb, index, array) => <span key={`${crumb.path}-${index}`}><button onClick={() => onNavigate(crumb.path)} aria-current={index === array.length - 1 ? "page" : undefined}>{crumb.name}</button>{index < array.length - 1 && <Glyph name="chevron" size={13} />}</span>)}
      </div>
      <div className="workspace-title"><strong>{data?.locationLabel ?? "正在读取"}</strong><span className={data?.writable ? "permission writable" : "permission readonly"}>{data?.writable ? "目录可写" : "目录只读"}</span></div>
      <div className="absolute-path" aria-label="当前目录绝对路径"><span>磁盘位置</span><code>{data?.absolutePath || "正在解析…"}</code></div>
      <div className="host-tools">
        <ActionButton onClick={() => onNavigate(parentPath)} disabled={atFileSystemRoot || !currentAbsolutePath}>上一级</ActionButton>
        <ActionButton onClick={() => void query.refetch()}><Glyph name="refresh" />刷新</ActionButton>
        <ActionButton tone="accent" onClick={() => onDialog({ type: "file" })} disabled={busy || !data?.writable}><Glyph name="plus" />新建文件</ActionButton>
        <ActionButton onClick={() => onDialog({ type: "folder" })} disabled={busy || !data?.writable}><Glyph name="folder" />新建目录</ActionButton>
        <ActionButton onClick={() => uploadRef.current?.click()} disabled={busy || !data?.writable}><Glyph name="upload" />上传</ActionButton>
        <input ref={uploadRef} className="sr-only" type="file" onChange={onUpload} aria-label="上传文件到当前系统目录" />
      </div>
    </div>
    <div className={`sensitive-toggle ${showSensitive ? "enabled" : ""}`}><div><strong>显示敏感文件</strong><small>{showSensitive ? "已显示 .env、密钥目录等全部项目" : "默认隐藏 .env、*secret*、.ssh 等名称"}</small></div><button role="switch" aria-checked={showSensitive} aria-label="显示敏感文件" onClick={() => onSensitiveChange(!showSensitive)}><span /></button></div>
    <div className="scope-note">运行身份：{data?.userIdentity ?? "读取中"}。这里的创建、保存、移动、重命名和删除都直接作用于上方显示的磁盘目录。</div>
    <div className="file-list" role="list" aria-busy={query.isPending}>
      {query.isPending && <div className="empty-state"><div className="loader" /><p>正在读取目录</p></div>}
      {(query.isError || data?.ok === false) && <div className="empty-state error"><strong>目录无法读取</strong><p>{data?.message ?? query.error?.message ?? "运行环境没有返回目录内容。"}</p><button onClick={() => void query.refetch()}>重新加载</button></div>}
      {!query.isPending && !query.isError && data?.ok && data.entries.length === 0 && <div className="empty-state"><div className="empty-glyph"><Glyph name="folder" size={32} /></div><strong>这个目录是空的</strong></div>}
      {data?.ok && data.entries.map((item) => {
        const opensFolder = item.kind === "folder" || (item.kind === "link" && item.targetKind === "folder");
        const opensFile = item.kind === "file" || (item.kind === "link" && item.targetKind === "file");
        const followable = opensFolder || opensFile;
        const detail = item.kind === "link" ? `符号链接 → ${item.targetKind === "folder" ? "文件夹" : item.targetKind === "file" ? "文件" : item.targetKind === "broken" ? "目标失效" : "目标不可用"}` : item.kind === "folder" ? "文件夹" : `${formatBytes(item.size)} · ${item.writable ? "可写" : "只读"}`;
        return <article key={item.path} role="listitem" className="file-row">
          <button className="file-main" onClick={() => opensFolder ? onNavigate(item.path) : opensFile ? onOpen(item) : undefined} disabled={!followable} aria-label={`${opensFolder ? "打开文件夹" : opensFile ? "预览文件" : "不可跟随"} ${item.name}`}>
            <span className={`file-icon ${opensFolder ? "folder" : "file"}`}><Glyph name={opensFolder ? "folder" : "file"} size={21} /></span>
            <span className="file-meta"><strong>{item.name}</strong><small>{detail}</small></span>{opensFolder && <Glyph name="chevron" size={16} />}
          </button>
          <div className="row-actions host-row-actions">
            {opensFile && <><button onClick={() => void onOpen(item)} aria-label={`预览 ${item.name}`}>预览</button><button onClick={() => void onDownload(item)} aria-label={`下载 ${item.name}`}><Glyph name="download" size={16} /></button></>}
            <button onClick={() => onDialog({ type: "move", item })} aria-label={`移动或重命名 ${item.name}`} disabled={!item.removable}><Glyph name="edit" size={16} /></button>
            <button onClick={() => onDialog({ type: "delete", item })} aria-label={`删除 ${item.name}`} disabled={!item.removable}><Glyph name="trash" size={16} /></button>
          </div>
        </article>;
      })}
    </div>
    {data?.truncated && <p className="truncated-note">项目过多，本页仅显示前 500 项。</p>}
  </div>;
}

function TerminalView({ entries, busy, onRun, onClear, onAgentSteps }: { entries: TerminalEntry[]; busy: boolean; onRun: (command: string, root: HostRoot, path: string) => Promise<void>; onClear: () => void; onAgentSteps: (steps: AgentStep[]) => void }) {
  const [command, setCommand] = useState("");
  const [root, setRoot] = useState<HostRoot>("workspace");
  const [path, setPath] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState("https://api.openai.com");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentTaskId, setAgentTaskId] = useState<string | null>(null);
  const [agentPending, setAgentPending] = useState("");
  const [agentToken, setAgentToken] = useState<string | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [agentExpanded, setAgentExpanded] = useState(true);
  const [agentContextLoaded, setAgentContextLoaded] = useState(false);
  const agentStepCountRef = useRef(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [entries, busy]);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [agentMessages, aiBusy]);
  useEffect(() => { void api.getAiProviderConfig({}).then((result) => { setAiBaseUrl(result.baseUrl); setAiApiKey(result.apiKey); setAiModel(result.model); setAiConfigured(result.configured); setAiConfigOpen(!result.configured); }); }, []);
  useEffect(() => { void api.getAiContext({}).then((result) => { setRoot(result.root); setPath(result.path); setAgentTaskId(result.taskId); setAgentPending(result.pendingCommand); setAgentToken(result.confirmToken); setAgentMessages(result.messages); agentStepCountRef.current = result.messages.reduce((count, message) => count + (message.steps?.length ?? 0), 0); setAgentContextLoaded(true); }); }, []);
  useEffect(() => { if (!agentContextLoaded) return; void api.saveAiContext({ taskId: agentTaskId, root, path, pendingCommand: agentPending, confirmToken: agentToken, messages: agentMessages }); }, [agentContextLoaded, agentMessages, agentPending, agentTaskId, agentToken, path, root]);
  function submit(event: FormEvent) { event.preventDefault(); const value = command.trim(); if (!value || busy) return; setCommand(""); void onRun(value, root, path); }
  async function saveAi() {
    if (!aiApiKey.trim() || !aiModel.trim()) return;
    setAiBusy(true);
    try {
      const result = await api.saveAiProviderConfig({ baseUrl: aiBaseUrl, apiKey: aiApiKey, model: aiModel });
      setAiConfigured(result.ok);
      appendAgentMessage({ role: "assistant", text: result.ok ? "模型配置已保存到服务器。" : `保存配置失败：${result.message}` });
    } catch (error) {
      appendAgentMessage({ role: "assistant", text: `保存配置失败：${error instanceof Error ? error.message : "未知错误"}` });
    } finally { setAiBusy(false); }
  }
  async function pullModels() {
    if (!aiApiKey.trim()) return;
    setAiBusy(true);
    try {
      const result = await api.listAiModels({ baseUrl: aiBaseUrl, apiKey: aiApiKey });
      setAiModels(result.models);
      if (!result.ok || !result.models.length) appendAgentMessage({ role: "assistant", text: `拉取模型失败：${result.message || "接口没有返回可用模型"}` });
    } catch (error) {
      appendAgentMessage({ role: "assistant", text: `拉取模型失败：${error instanceof Error ? error.message : "未知错误"}` });
    } finally { setAiBusy(false); }
  }
  function appendAgentMessage(message: AgentMessage) { setAgentMessages((current) => [...current, message].slice(-40)); }
  async function clearAgentContext() {
    setAiBusy(true);
    try {
      await api.clearAiContext({});
      setAgentMessages([]);
      setAgentTaskId(null);
      setAgentPending("");
      setAgentToken(null);
      setAgentPrompt("");
      agentStepCountRef.current = 0;
    } finally { setAiBusy(false); }
  }
  async function runAgent(confirmToken?: string) {
    const task = agentPrompt.trim();
    if (!task && !agentTaskId) return;
    if (!confirmToken && task) appendAgentMessage({ role: "user", text: task });
    setAiBusy(true);
    let activeTaskId = agentTaskId;
    let nextToken = confirmToken ?? null;
    try {
      // Each server call handles exactly one model turn or one command, so the
      // gateway never sees a multi-minute request. Keep driving the loop here until
      // the task finishes or needs user confirmation.
      for (let round = 0; round < 40; round += 1) {
        const result = await api.runAiTask({ taskId: activeTaskId, prompt: task || "继续当前任务", root, path, confirmToken: nextToken });
        const newSteps = result.steps.slice(agentStepCountRef.current);
        agentStepCountRef.current = result.steps.length;
        activeTaskId = result.status === "completed" || result.status === "failed" ? null : result.taskId;
        setAgentTaskId(activeTaskId);
        setAgentPending(result.status === "waiting_confirmation" ? result.pendingCommand ?? "" : "");
        setAgentToken(result.confirmToken ?? null);
        if (newSteps.length > 0 || result.status !== "running") appendAgentMessage({ role: "assistant", text: result.message || (result.status === "completed" ? "任务已完成。" : ""), steps: newSteps, diagnostic: result.diagnostic ?? null });
        onAgentSteps(result.steps);
        nextToken = null;
        if (result.status === "completed" || result.status === "failed") { setAgentPrompt(""); setAgentToken(null); agentStepCountRef.current = 0; break; }
        if (result.status === "waiting_confirmation") break;
      }
    } catch (error) {
      appendAgentMessage({ role: "assistant", text: `请求失败：${error instanceof Error ? error.message : "未知错误"}` });
    } finally { setAiBusy(false); }
  }
  return <section className="terminal-panel" aria-label="终端">
    <div className="terminal-toolbar"><div><strong>Shell</strong><small>每条命令最多运行 30 秒</small></div><button onClick={onClear} disabled={!entries.length}>清空输出</button></div>
    <div className="terminal-location"><label>工作目录<select value={root} onChange={(event) => setRoot(event.target.value as HostRoot)}><option value="workspace">工作区</option><option value="system">系统根目录</option><option value="build">构件目录</option></select></label><label>相对路径<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="留空表示根目录" /></label></div>
    <div className={`ai-terminal-panel ${agentExpanded ? "is-expanded" : "is-collapsed"}`}>
      <div className="ai-terminal-heading">
        <div><strong>AI 终端 Agent</strong><small>{aiConfigured ? "已连接外部 OpenAI 兼容接口" : "先配置外部模型接口"}</small></div>
        <div className="ai-terminal-heading-actions"><span>自动读取输出并继续 · 改删操作确认</span><button type="button" className="ai-panel-toggle" onClick={() => setAgentExpanded((expanded) => !expanded)} aria-expanded={agentExpanded}>{agentExpanded ? "收起对话" : "展开对话"}</button><button type="button" className="ai-context-clear" onClick={() => void clearAgentContext()} disabled={aiBusy || !agentMessages.length}>清除上下文</button><button type="button" className="ai-config-toggle" onClick={() => setAiConfigOpen((open) => !open)} aria-expanded={aiConfigOpen}>{aiConfigOpen ? "收起配置" : "模型配置"}</button></div>
      </div>
      {aiConfigOpen && <div className="ai-terminal-config"><input value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="API 地址，例如 https://api.openai.com" /><input type="text" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="API Key" /><select value={aiModel} onChange={(event) => setAiModel(event.target.value)}><option value="">选择模型</option>{aiModels.map((model) => <option key={model} value={model}>{model}</option>)}</select><button type="button" onClick={() => void pullModels()} disabled={aiBusy || !aiApiKey.trim()}>拉取模型</button><button type="button" onClick={() => void saveAi()} disabled={aiBusy || !aiApiKey.trim() || !aiModel.trim()}>保存配置</button></div>}
      <div className="agent-chat" ref={chatRef} role="log" aria-live="polite">
        {!agentMessages.length && <div className="agent-chat-empty">描述一个任务，AI 会逐步执行，并把每一步的命令、输出和结论发在这里。</div>}
        {agentMessages.map((message, index) => <div className={`agent-message ${message.role}`} key={index}>
          <div className="agent-message-role">{message.role === "user" ? "你" : "AI"}</div>
          {message.text && <div className="agent-message-text">{message.text}</div>}
          {message.steps && message.steps.length > 0 && <div className="agent-message-steps agent-message-steps-compact">{message.steps.map((step, stepIndex) => <div key={`${step.command}-${stepIndex}`}><span>{step.exitCode === 0 ? "命令执行成功" : `命令执行完成 · 退出 ${step.exitCode ?? "未知"}`}</span></div>)}</div>}
          {message.diagnostic && <div className="agent-diagnostic">
            <div className="agent-diagnostic-row"><span>阶段</span><code>{message.diagnostic.phase}</code></div>
            <div className="agent-diagnostic-row"><span>地址</span><code>{message.diagnostic.url}</code></div>
            <div className="agent-diagnostic-row"><span>模型</span><code>{message.diagnostic.model}</code></div>
            <div className="agent-diagnostic-row"><span>状态</span><code>{message.diagnostic.status ?? "无响应"}</code></div>
            <p>{message.diagnostic.detail}</p>
            {message.diagnostic.contentSnippet && <><label>模型返回内容</label><pre>{message.diagnostic.contentSnippet}</pre></>}
            {message.diagnostic.responseSnippet && <><label>原始响应</label><pre>{message.diagnostic.responseSnippet}</pre></>}
            <button type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(message.diagnostic, null, 2))}>复制诊断信息</button>
          </div>}
        </div>)}
        {aiBusy && <div className="agent-message assistant pending"><div className="agent-message-role">AI</div><div className="agent-message-text">正在思考并执行下一步…</div></div>}
      </div>
      {agentPending && <div className="ai-command-preview"><code>{agentPending}</code><button type="button" onClick={() => agentToken ? void runAgent(agentToken) : undefined} disabled={!agentToken}>确认并执行</button></div>}
      <form className="ai-terminal-prompt" onSubmit={(event) => { event.preventDefault(); if (aiBusy || !agentPrompt.trim()) return; void runAgent(); }}><input value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} placeholder={agentTaskId ? "继续补充要求，或直接发送继续" : "描述一个完整任务，例如：检查项目错误并修复，然后运行测试"} /><button type="submit" disabled={aiBusy || !agentPrompt.trim()}>{aiBusy ? "执行中" : agentTaskId ? "继续" : "发送"}</button></form>
    </div>
    <div className="terminal-output" ref={outputRef} role="log" aria-live="polite">
      {!entries.length && <div className="terminal-empty">在下方输入命令。命令以当前运行用户身份执行，输出最多保留 1 MB。</div>}
      {entries.map((entry, index) => <div className="terminal-entry" key={`${entry.command}-${index}`}><div className="terminal-prompt"><span>{entry.cwd || "?"}</span><strong>{entry.source === "agent" ? "AI $ " : "$ "}{entry.command}</strong></div>{entry.stdout && <pre>{entry.stdout}</pre>}{entry.stderr && <pre className="stderr">{entry.stderr}</pre>}<small>{entry.timedOut ? "超时终止" : `退出 ${entry.exitCode ?? "未知"}`}{entry.durationMs ? ` · ${entry.durationMs} ms` : ""}</small></div>)}
      {busy && <div className="terminal-running">正在执行…</div>}
    </div>
    <form className="terminal-command" onSubmit={submit}><span aria-hidden="true">$</span><input aria-label="Shell 命令" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="例如：pwd && ls -la" /><button type="submit" disabled={busy || !command.trim()}>{busy ? "运行中" : "执行"}</button></form>
  </section>;
}

function HostEditDialog({ dialog, currentPath, busy, onClose, onSubmit }: { dialog: Exclude<HostDialog, null>; currentPath: string; busy: boolean; onClose: () => void; onSubmit: (name: string, targetDirectory: string) => Promise<void> }) {
  const deleting = dialog.type === "delete";
  const initialName = dialog.type === "move" || dialog.type === "delete" ? dialog.item.name : dialog.type === "file" ? "新建文件.txt" : "新建文件夹";
  const [name, setName] = useState(initialName);
  const [targetDirectory, setTargetDirectory] = useState(currentPath);
  function submit(event: FormEvent) { event.preventDefault(); void onSubmit(name, targetDirectory); }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="host-dialog-title">
    <button className="dialog-close" onClick={onClose} aria-label="关闭对话框"><Glyph name="close" /></button>
    <h2 id="host-dialog-title">{dialog.type === "file" ? "新建文件" : dialog.type === "folder" ? "新建目录" : dialog.type === "move" ? "移动或重命名" : "确认删除"}</h2>
    {deleting ? <><p className="delete-copy">将从宿主文件系统删除“{dialog.item.name}”{dialog.item.kind === "folder" ? "及其全部内容" : ""}。此操作无法撤销。</p><div className="dialog-actions"><ActionButton onClick={onClose}>取消</ActionButton><ActionButton tone="danger" onClick={() => void onSubmit(name, targetDirectory)} disabled={busy}>确认删除</ActionButton></div></> : <form onSubmit={submit}>
      <label htmlFor="host-item-name">名称</label><input id="host-item-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={255} required autoFocus />
      {dialog.type === "move" && <><label htmlFor="host-target-directory">目标目录（绝对路径）</label><input id="host-target-directory" value={targetDirectory} onChange={(event) => setTargetDirectory(event.target.value)} placeholder="留空表示本页签起始目录" /></>}
      <div className="dialog-actions"><ActionButton onClick={onClose}>取消</ActionButton><button className="action-button action-accent" type="submit" disabled={busy}>{busy ? "处理中…" : "确认"}</button></div>
    </form>}
  </div></div>;
}

function StatBar({ label, value, detail, accent = false }: { label: string; value: number; detail: string; accent?: boolean }) {
  return <div className="stat-bar"><div><span>{label}</span><strong>{value.toFixed(1)}%</strong></div><div className="bar-track"><span className={accent ? "amber" : ""} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div><small>{detail}</small></div>;
}

function MonitorView({ snapshot, history, loading, error, onRefresh, directoryUsage, scanBusy, scanProgress, onScan }: { snapshot?: Snapshot; history: MonitorHistory[]; loading: boolean; error: boolean; onRefresh: () => void; directoryUsage: DirectoryUsage[]; scanBusy: boolean; scanProgress: number; onScan: () => void }) {
  const [processSort, setProcessSort] = useState<"cpu" | "memory">("cpu");
  const [loopDevicesExpanded, setLoopDevicesExpanded] = useState(false);
  if (loading) return <section className="monitor-loading"><div className="radar-loader" /><strong>正在读取运行环境</strong><p>首次采样后开始计算每秒速率。</p></section>;
  if (error || !snapshot) return <section className="monitor-loading error"><strong>监控数据暂时不可用</strong><p>运行环境没有返回指标。</p><ActionButton onClick={onRefresh}><Glyph name="refresh" />重试</ActionButton></section>;
  const processes = processSort === "cpu" ? snapshot.processesByCpu : snapshot.processesByMemory;
  const largestDirectory = Math.max(1, ...directoryUsage.filter((item) => !item.timedOut).map((item) => item.size));
  const networkPeak = history.reduce((peak, point) => Math.max(peak, Number(point.rx) || 0, Number(point.tx) || 0), 0);
  const networkHasTraffic = networkPeak > 0;
  const networkAxisMax = networkHasTraffic ? Math.max(16, byteAxisCeiling(networkPeak * 1.12)) : 0;
  const networkTicks = networkHasTraffic ? [0, networkAxisMax / 2, networkAxisMax] : [0];
  const inactiveLoopDevices = snapshot.disks.filter((disk) => disk.name.startsWith("loop") && disk.readPerSec === 0 && disk.writePerSec === 0);
  const visibleDisks = snapshot.disks.filter((disk) => !inactiveLoopDevices.includes(disk));
  const coreColors = ["var(--accent)", "var(--amber)", "#2f7da5", "#b44d80"];
  return <section className="monitor-panel" aria-label="系统监控">
    <div className="monitor-hero">
      <div className="pulse-block"><span>CPU 即时占用 · 1 秒采样</span><strong>{snapshot.cpuPercent.toFixed(1)}<small>%</small></strong><div className="pulse-meta"><span>{snapshot.hostname}</span><span>{snapshot.platform}</span></div></div>
      <button className="refresh-button" onClick={onRefresh} aria-label="刷新系统指标"><Glyph name="refresh" /></button>
    </div>

    <section className="host-info-panel" aria-labelledby="host-info-heading">
      <div className="panel-heading"><div><span>运行环境</span><strong id="host-info-heading">主机信息</strong></div><small>{formatTime(snapshot.sampledAt)} 更新</small></div>
      <dl className="host-info-list"><div><dt>主机名</dt><dd>{snapshot.hostname}</dd></div><div><dt>内核</dt><dd>{snapshot.kernelVersion}</dd></div><div><dt>系统启动</dt><dd>{formatLocalDateTime(snapshot.bootedAt)}</dd></div></dl>
    </section>

    <div className="uptime-strip" aria-label="运行时间">
      <div><span>系统运行时间</span><strong>{formatUptime(snapshot.uptimeSec)}</strong><small>启动于 {formatDateTime(snapshot.bootedAt)}</small></div>
      <div><span>本次已运行时间</span><strong>{formatUptime(snapshot.serviceUptimeSec)}</strong><small>构件服务当前实例</small></div>
    </div>

    <section className="restart-panel" aria-labelledby="restart-record-heading">
      <div className="restart-heading"><div><span>服务状态</span><h2 id="restart-record-heading">服务重启记录</h2></div><small>每 1 秒刷新</small></div>
      <div className="restart-facts"><div className="restart-count"><span>累计重启次数</span><strong>{snapshot.serviceRestartCount}</strong><small>次</small></div><div><span>上次重启时间</span><strong>{snapshot.previousServiceStartedAt ? formatLocalDateTime(snapshot.previousServiceStartedAt) : "—"}</strong></div><div><span>本次启动时间</span><strong>{formatLocalDateTime(snapshot.serviceStartedAt)}</strong></div></div>
    </section>

    <div className="monitor-grid">
      <div className="chart-panel resource-chart">
        <div className="panel-heading"><div><span>处理器曲线</span><strong>总占用与每核心</strong></div><div className="legend cpu-legend"><span className="cpu">总计</span>{snapshot.cpuCores.map((core) => <span key={core.name}>{core.name.replace("cpu", "核心 ")}</span>)}</div></div>
        <div className="chart-frame" role="img" aria-label="最近 60 秒 CPU 总占用和每核心占用折线图"><ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 4, bottom: 0, left: -24 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="time" tickFormatter={formatTime} minTickGap={38} tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" }} labelFormatter={(label) => formatTime(String(label))} /><Line type="monotone" dataKey="cpu" name="CPU 总计" stroke="var(--text)" strokeWidth={2.5} dot={false} isAnimationActive={false} />{snapshot.cpuCores.map((core, index) => <Line key={core.name} type="monotone" dataKey={`core-${core.name}`} name={core.name.replace("cpu", "核心 ")} stroke={coreColors[index % coreColors.length]} strokeWidth={1.8} dot={false} isAnimationActive={false} />)}</LineChart></ResponsiveContainer></div>
      </div>

      <section className="stats-panel" aria-label="内存与平均负载">
        <StatBar label="实际使用" value={snapshot.memory.percent} detail={`${formatBytes(snapshot.memory.used)} / ${formatBytes(snapshot.memory.total)}`} />
        <div className="memory-breakdown"><div><span>缓存 Cached</span><strong>{formatBytes(snapshot.memory.cached)}</strong></div><div><span>缓冲 Buffers</span><strong>{formatBytes(snapshot.memory.buffers)}</strong></div><div><span>可用</span><strong>{formatBytes(snapshot.memory.available)}</strong></div></div>
        <div className="load-facts"><div><span>1 分钟</span><strong>{(snapshot.loadAverage[0] ?? 0).toFixed(2)}</strong></div><div><span>5 分钟</span><strong>{(snapshot.loadAverage[1] ?? 0).toFixed(2)}</strong></div><div><span>15 分钟</span><strong>{(snapshot.loadAverage[2] ?? 0).toFixed(2)}</strong></div></div>
      </section>

      <section className="mount-panel wide-panel" aria-labelledby="mount-heading">
        <div className="panel-heading"><div><span>文件系统</span><strong id="mount-heading">挂载点容量</strong></div><small>与 df 口径一致</small></div>
        <div className="mount-list">{snapshot.mounts.map((mount) => <div className="mount-row" key={mount.path}><div className="mount-name"><strong>{mount.path}</strong><span>{mount.percent.toFixed(1)}%</span></div><div className="bar-track"><span className={mount.percent >= 85 ? "amber" : ""} style={{ width: `${mount.percent}%` }} /></div><dl><div><dt>总量</dt><dd>{formatBytes(mount.total)}</dd></div><div><dt>已用</dt><dd>{formatBytes(mount.used)}</dd></div><div><dt>可用</dt><dd>{formatBytes(mount.available)}</dd></div></dl></div>)}</div>
      </section>

      <div className="chart-panel network-chart">
        <div className="panel-heading"><div><span>网络吞吐</span><strong>按网卡拆分</strong></div><div className="network-now"><span>↓ {formatBytes(snapshot.network.rxPerSec)}/s</span><span>↑ {formatBytes(snapshot.network.txPerSec)}/s</span></div></div>
        <div className="interface-list">{snapshot.network.interfaces.length ? snapshot.network.interfaces.map((iface) => <div key={iface.name}><strong>{iface.name}</strong><span>↓ {formatBytes(iface.rxPerSec)}/s</span><span>↑ {formatBytes(iface.txPerSec)}/s</span></div>) : <div className="interface-empty">未发现可用网卡</div>}</div>
        {networkHasTraffic ? <div className="chart-frame compact network-plot" role="img" aria-label="最近 60 秒非回环网卡总接收和发送速率面积图"><ResponsiveContainer width="100%" height="100%"><AreaChart data={history} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="time" tickFormatter={formatTime} minTickGap={38} tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis width={48} domain={[0, networkAxisMax]} ticks={networkTicks} tickFormatter={formatBytes} tick={{ fill: "var(--dim)", fontSize: 10 }} axisLine={false} tickLine={false} allowDataOverflow /><Tooltip formatter={(value) => `${formatBytes(Number(value))}/s`} labelFormatter={(label) => formatTime(String(label))} contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" }} /><Area type="monotone" dataKey="rx" name="接收" stroke="var(--accent)" fill="var(--accent-soft)" strokeWidth={2} isAnimationActive={false} /><Area type="monotone" dataKey="tx" name="发送" stroke="var(--amber)" fill="transparent" strokeWidth={1.7} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div> : <div className="network-empty" role="status" aria-label="当前采样窗口没有检测到网络流量"><strong>暂无网络流量</strong><small>当前采样窗口的收发速率均为 0 B/s</small></div>}
      </div>

      <section className="io-panel" aria-labelledby="disk-io-heading">
        <div className="panel-heading"><div><span>块设备</span><strong id="disk-io-heading">磁盘 I/O</strong></div><small>每秒速率</small></div>
        <div className="metric-table"><div className="metric-head"><span>设备</span><span>读取</span><span>写入</span></div>{snapshot.disks.length ? <>{visibleDisks.map((disk) => <div className="metric-row" key={disk.name}><strong>{disk.name}</strong><span>↓ {formatBytes(disk.readPerSec)}/s</span><span>↑ {formatBytes(disk.writePerSec)}/s</span></div>)}{inactiveLoopDevices.length > 0 && <div className="loop-device-group"><button type="button" className="loop-device-toggle" aria-expanded={loopDevicesExpanded} aria-controls="inactive-loop-devices" onClick={() => setLoopDevicesExpanded((expanded) => !expanded)}><span className="loop-chevron" aria-hidden="true">›</span><strong>回环设备（{inactiveLoopDevices.length} 个，无活动）</strong><small>{loopDevicesExpanded ? "点击收起" : "点击展开"}</small></button>{loopDevicesExpanded && <div id="inactive-loop-devices">{inactiveLoopDevices.map((disk) => <div className="metric-row loop-device-row" key={disk.name}><strong>{disk.name}</strong><span>↓ {formatBytes(disk.readPerSec)}/s</span><span>↑ {formatBytes(disk.writePerSec)}/s</span></div>)}</div>}</div>}</> : <div className="metric-empty">未发现块设备统计</div>}</div>
      </section>

      <section className="directory-panel wide-panel" aria-labelledby="directory-heading">
        <div className="panel-heading"><div><span>/home/hatch</span><strong id="directory-heading">一级目录占用排行</strong></div><button className="scan-button" onClick={onScan} disabled={scanBusy}>{scanBusy ? `扫描中 ${scanProgress}%` : directoryUsage.length ? "重新扫描" : "扫描"}</button></div>
        {scanBusy && <div className="scan-progress" aria-live="polite"><span style={{ width: `${scanProgress}%` }} /></div>}
        {!directoryUsage.length && !scanBusy ? <div className="metric-empty">手动扫描，不加入 1 秒监控轮询。</div> : <div className="directory-list">{directoryUsage.slice(0, 12).map((item, index) => <div className="directory-row" key={item.path}><span className="rank">{index + 1}</span><div><strong>{item.name}</strong><span className="usage-track"><i style={{ width: item.timedOut ? "0%" : `${Math.max(1, (item.size / largestDirectory) * 100)}%` }} /></span></div><span>{item.timedOut ? "超时跳过" : formatBytes(item.size)}</span></div>)}</div>}
      </section>

      <div className="process-panel">
        <div className="panel-heading process-heading"><div><span>活动进程</span><strong>{snapshot.processCount} 个进程</strong></div><div className="sort-switch" aria-label="进程排序"><button className={processSort === "cpu" ? "active" : ""} onClick={() => setProcessSort("cpu")}>CPU</button><button className={processSort === "memory" ? "active" : ""} onClick={() => setProcessSort("memory")}>内存</button></div></div>
        <div className="process-head"><span>进程</span><span>CPU</span><span>内存</span></div>
        <div className="process-list">{processes.map((process) => <div className="process-row" key={process.pid}><div><strong>{process.name}</strong><small>PID {process.pid} · {process.status}</small></div><span>{process.cpuPercent.toFixed(1)}%</span><span>{formatBytes(process.memoryBytes)}</span></div>)}</div>
      </div>
    </div>
  </section>;
}

function ImageViewer({ viewer, busy, onClose, onNavigate, onDownload }: { viewer: ImageViewerState; busy: boolean; onClose: () => void; onNavigate: (item: HostEntry) => void; onDownload: (item: HostEntry) => void }) {
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [imageError, setImageError] = useState(false);
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const index = viewer.images.findIndex((item) => item.path === viewer.item.path);
  const previous = index > 0 ? viewer.images[index - 1] : undefined;
  const next = index >= 0 && index < viewer.images.length - 1 ? viewer.images[index + 1] : undefined;

  useEffect(() => {
    setZoom(1);
    setFit(true);
    setPan({ x: 0, y: 0 });
    setDimensions({ width: 0, height: 0 });
    setImageError(false);
  }, [viewer.item.path]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && previous) onNavigate(previous);
      else if (event.key === "ArrowRight" && next) onNavigate(next);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [next, onClose, onNavigate, previous]);

  function changeZoom(delta: number) {
    setZoom((current) => Math.min(8, Math.max(0.15, Number((current + delta).toFixed(2)))));
  }
  function fitWindow() { setFit(true); setZoom(1); setPan({ x: 0, y: 0 }); }
  function actualSize() { setFit(false); setZoom(1); setPan({ x: 0, y: 0 }); }

  const unavailable = !viewer.loading && (!viewer.dataUri || imageError);
  return <div className="image-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="image-viewer" role="dialog" aria-modal="true" aria-labelledby="image-viewer-title">
      <header className="image-viewer-head">
        <div className="image-title-block"><h2 id="image-viewer-title">{viewer.item.name}</h2><div className="image-facts"><span>{dimensions.width > 0 ? `${dimensions.width} × ${dimensions.height}` : "尺寸读取中"}</span><span>{formatBytes(viewer.size)}</span>{viewer.images.length > 1 && <span>{Math.max(1, index + 1)} / {viewer.images.length}</span>}</div></div>
        <div className="image-toolbar" aria-label="图片工具栏">
          <button onClick={() => changeZoom(-0.2)} aria-label="缩小图片" disabled={unavailable}><Glyph name="zoomOut" /></button>
          <button onClick={() => changeZoom(0.2)} aria-label="放大图片" disabled={unavailable}><Glyph name="zoomIn" /></button>
          <button className="desktop-image-tool" onClick={fitWindow} aria-label="适应窗口" disabled={unavailable}><Glyph name="fit" /><span>适应</span></button>
          <button className="desktop-image-tool" onClick={actualSize} aria-label="实际尺寸 1 比 1" disabled={unavailable}><Glyph name="actual" /><span>1:1</span></button>
          <button onClick={() => onDownload(viewer.item)} aria-label={`下载 ${viewer.item.name}`} disabled={busy}><Glyph name="download" /></button>
          <button onClick={onClose} aria-label="关闭图片查看器"><Glyph name="close" /></button>
        </div>
      </header>
      <div className="image-stage" onWheel={(event) => { if (unavailable) return; event.preventDefault(); changeZoom(event.deltaY > 0 ? -0.15 : 0.15); }} onPointerMove={(event) => { const drag = dragRef.current; if (!drag) return; setPan({ x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y }); }} onPointerUp={(event) => { dragRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragRef.current = null; }} onPointerDown={(event) => { if (unavailable || event.button !== 0 || (event.target as HTMLElement).closest("button")) return; dragRef.current = { x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); }}>
        {previous && <button className="image-nav previous" onClick={(event) => { event.stopPropagation(); onNavigate(previous); }} aria-label={`上一张：${previous.name}`}><Glyph name="previous" size={26} /></button>}
        {next && <button className="image-nav next" onClick={(event) => { event.stopPropagation(); onNavigate(next); }} aria-label={`下一张：${next.name}`}><Glyph name="next" size={26} /></button>}
        {viewer.loading ? <div className="image-viewer-status" role="status"><div className="loader" /><strong>正在载入图片</strong></div> : unavailable ? <div className="image-viewer-status error" role="status"><Glyph name="file" size={42} /><strong>{viewer.tooLarge ? "文件过大，建议下载" : "图片无法显示"}</strong><p>{viewer.message || "图片可能已损坏或格式不受支持。"}</p><button onClick={() => onDownload(viewer.item)} disabled={busy}><Glyph name="download" />{busy ? "准备中…" : "下载文件"}</button></div> : <img src={viewer.dataUri ?? undefined} alt={`图片预览：${viewer.item.name}`} draggable={false} className={fit ? "fit" : "actual"} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setImageError(true)} />}
      </div>
      <div className="image-zoom-readout" aria-live="polite">{fit ? "适应窗口" : "实际尺寸"} · {Math.round(zoom * 100)}%</div>
    </section>
  </div>;
}

function PreviewDialog({ preview, busy, onClose, onSave, onPage }: { preview: Preview; busy: boolean; onClose: () => void; onSave: (content: string) => Promise<boolean>; onPage: (offset: number) => Promise<void> }) {
  const isImage = preview.mime.startsWith("image/");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(preview.text ?? "");
  useEffect(() => { setDraft(preview.text ?? ""); setEditing(false); }, [preview.text, preview.offset]);
  const changed = draft !== (preview.text ?? "");
  const paged = preview.hostRoot !== undefined && preview.totalSize !== undefined;
  const pageSize = Math.max(1024, (preview.nextOffset ?? 0) - (preview.offset ?? 0));
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
    <div className="preview-head"><div><span>{editing ? "编辑文本" : preview.mode === "hex" ? "HEX 预览" : "预览"}</span><h2 id="preview-title">{preview.name}</h2></div><div className="preview-actions">{preview.editable && preview.text !== undefined && !editing && <button className="text-action" onClick={() => setEditing(true)}><Glyph name="edit" size={16} />编辑</button>}{editing && <button className="text-action save" onClick={() => { void onSave(draft).then((saved) => { if (saved) setEditing(false); }); }} disabled={busy || !changed}>{busy ? "保存中" : "保存"}</button>}<button onClick={onClose} aria-label="关闭预览"><Glyph name="close" /></button></div></div>
    {preview.note && <div className="preview-note">{preview.note}</div>}
    <div className={`preview-body ${editing ? "editing" : ""} ${preview.mode === "hex" ? "hex" : ""}`}>{editing ? <textarea className="host-editor" aria-label={`编辑 ${preview.name}`} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} /> : preview.text !== undefined ? <pre>{preview.text}</pre> : isImage && preview.url ? <img src={preview.url} alt={`文件预览：${preview.name}`} /> : preview.mime === "application/pdf" && preview.url ? <iframe src={preview.url} title={`PDF 预览：${preview.name}`} /> : <div className="unsupported-preview"><Glyph name="file" size={40} /><strong>此类型不支持内嵌预览</strong>{preview.url && <a href={preview.url} download={preview.name}>下载文件</a>}</div>}</div>
    {paged && <div className="preview-pager"><button onClick={() => void onPage(Math.max(0, (preview.offset ?? 0) - pageSize))} disabled={busy || (preview.offset ?? 0) === 0}>上一块</button><span>{formatBytes(preview.offset ?? 0)} – {formatBytes(preview.nextOffset ?? 0)} / {formatBytes(preview.totalSize ?? 0)}</span><button onClick={() => void onPage(preview.nextOffset ?? 0)} disabled={busy || preview.eof}>下一块</button></div>}
  </div></div>;
}
