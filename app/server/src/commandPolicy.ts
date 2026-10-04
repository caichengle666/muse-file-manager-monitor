/**
 * Shell command classification for the AI Agent.
 *
 * The previous implementation matched a single regular expression against the
 * whole command. That let `sudo rm -rf`, `bash -c 'rm -rf ...'`, `find -delete`
 * and `echo x > file` slip through as "read only" and run without confirmation.
 *
 * Only commands that can write, modify, move, or delete files require
 * confirmation. Other commands are intentionally allowed for this private
 * artifact, including installs, service operations, network requests, and
 * otherwise unknown commands.
 */

export type CommandCategory = "read" | "test" | "mutating" | "unknown";

export type CommandAssessment = {
  requiresConfirmation: boolean;
  category: CommandCategory;
  reason: string;
};

const WRAPPERS = new Set([
  "sudo", "doas", "command", "builtin", "exec", "nohup", "nice", "ionice",
  "time", "timeout", "env", "stdbuf", "setsid", "xargs", "watch", "chronic",
]);

const SHELL_INTERPRETERS = new Set([
  "sh", "bash", "dash", "zsh", "ksh", "mksh", "fish", "csh", "tcsh", "busybox",
]);

const INLINE_CODE_FLAGS = new Map<string, Set<string>>([
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["nodejs", new Set(["-e", "--eval", "-p", "--print"])],
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["perl", new Set(["-e", "-E"])],
  ["ruby", new Set(["-e"])],
  ["php", new Set(["-r"])],
  ["lua", new Set(["-e"])],
  ["deno", new Set(["eval"])],
]);

const READ_ONLY = new Set([
  "ls", "dir", "vdir", "pwd", "cat", "tac", "head", "tail", "less", "more", "most",
  "wc", "nl", "od", "hexdump", "xxd", "strings", "grep", "egrep", "fgrep", "rg",
  "ripgrep", "ag", "ack", "find", "fd", "fdfind", "locate", "which", "type",
  "whereis", "whatis", "stat", "file", "du", "df", "tree", "realpath", "readlink",
  "basename", "dirname", "echo", "printf", "date", "cal", "uptime", "whoami", "id",
  "groups", "hostname", "uname", "arch", "nproc", "getconf", "env", "printenv",
  "ps", "pstree", "top", "htop", "free", "vmstat", "iostat", "mpstat", "pidstat",
  "sar", "lscpu", "lsblk", "lspci", "lsusb", "lsmod", "modinfo", "dmesg",
  "journalctl", "ss", "netstat", "ifconfig", "route", "arp", "dig", "nslookup",
  "host", "ping", "ping6", "traceroute", "tracepath", "mtr", "clear", "reset",
  "tput", "seq", "expr", "test", "[", "true", "false", ":", "sleep", "cd", "pushd",
  "popd", "dirs", "export", "unset", "set", "alias", "unalias", "history", "umask",
  "sha256sum", "sha1sum", "md5sum", "cksum", "cmp", "diff", "comm", "sort", "uniq",
  "cut", "paste", "tr", "jq", "yq", "base64", "zipinfo",
  "getent", "last", "lastlog", "w", "who", "users", "locale",
]);

const MUTATING = new Set([
  "rm", "rmdir", "unlink", "shred", "truncate", "dd", "mv", "cp", "install", "rsync",
  "scp", "sftp", "tee", "touch", "mkdir", "mknod", "ln", "link", "rename", "chmod",
  "chown", "chgrp", "chattr", "setfacl", "setcap", "zip", "unzip", "gzip", "gunzip",
  "bzip2", "bunzip2", "xz", "unxz", "7z", "cpio", "patch", "make", "cmake", "meson",
  "ninja", "gradle", "mvn", "kill", "pkill", "killall", "reboot", "shutdown",
  "poweroff", "halt", "init", "telinit", "mount", "umount", "swapon", "swapoff",
  "iptables", "ip6tables", "nft", "ufw", "firewall-cmd", "useradd", "userdel",
  "usermod", "groupadd", "groupdel", "passwd", "chpasswd", "crontab", "at", "batch",
  "systemd-run", "apt", "apt-get", "aptitude", "yum", "dnf", "apk", "pacman",
  "zypper", "brew", "snap", "pip", "pip3", "conda", "npm", "pnpm", "yarn", "bun",
  "go", "cargo", "rustup", "docker", "podman", "kubectl", "helm", "terraform",
  "ansible", "ansible-playbook", "aws", "gcloud", "az", "mysql", "psql", "sqlite3",
  "openssl", "telnet",
  "redis-cli", "mongosh", "nc", "ncat", "netcat", "ssh", "script", "source",
  "git", "sed", "perl", "awk", "gawk", "python", "python3", "node", "ruby", "php",
  "deno", "bash", "sh", "zsh", "dash", "ksh", "fish",
]);

const TEST_COMMANDS = new Set([
  "pytest", "jest", "vitest", "rspec", "phpunit", "bats", "ctest", "tox", "nox",
  "nose2", "gtest", "unittest", "playwright", "cypress",
]);

const COMMAND_SUBSTITUTION = /\$\(|`|<\(|>\(/;

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { current += char; escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    const isDescriptorCopy = char === "&" && (command[index - 1] === ">" || command[index - 1] === "<") && /[0-9-]/.test(command[index + 1] ?? "");
    const isCombinedRedirect = char === "&" && command[index + 1] === ">";
    if (char === ";" || char === "\n" || ((char === "&" || char === "|") && !isDescriptorCopy && !isCombinedRedirect)) {
      if ((char === "&" || char === "|") && command[index + 1] === char) index += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? "";
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === " " || char === "\t" || char === "\r") {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function extractBaseCommand(segment: string): { name: string; args: string[] } {
  const tokens = tokenizeShellSegment(segment);
  let index = 0;
  let guard = 0;
  while (index < tokens.length && guard < 32) {
    guard += 1;
    const token = tokens[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
    if (!WRAPPERS.has(token)) break;
    index += 1;
    if (token === "timeout") {
      while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) index += 1;
      if (index < tokens.length) index += 1;
    } else if (token === "nice" || token === "ionice" || token === "time" || token === "watch") {
      while (index < tokens.length && ((tokens[index] ?? "").startsWith("-") || /^\d+$/.test(tokens[index] ?? ""))) index += 1;
    } else if (token === "env") {
      while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "") || (tokens[index] ?? "").startsWith("-"))) index += 1;
    } else {
      while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) index += 1;
    }
  }
  const rawName = tokens[index] ?? "";
  return { name: rawName.split("/").pop() ?? rawName, args: tokens.slice(index + 1) };
}

function hasOutputRedirection(segment: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? "";
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ">") {
      if (/^>>?&(?:\d+|-)/.test(segment.slice(index))) {
        index += segment.slice(index).match(/^>>?&(?:\d+|-)/)?.[0].length ?? 0;
        continue;
      }
      return true;
    }
  }
  return false;
}

function firstNonFlag(args: string[], valueFlags: Set<string>): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") return args[index + 1] ?? "";
    if (valueFlags.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return "";
}

function hasAnyFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) => flags.has(arg) || (arg.startsWith("-") && !arg.startsWith("--") && [...flags].some((flag) => flag.length === 2 && arg.slice(1).includes(flag.slice(1)))));
}

function assessGit(args: string[]): CommandCategory {
  const sub = firstNonFlag(args, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]));
  if (!sub) return "read";
  const read = new Set([
    "status", "log", "diff", "show", "rev-parse", "describe", "blame", "ls-files",
    "ls-tree", "shortlog", "reflog", "cat-file", "check-ignore", "grep", "annotate",
    "version", "help", "whatchanged", "count-objects", "verify-commit", "verify-tag",
  ]);
  if (read.has(sub)) return "read";
  if (sub === "branch" || sub === "tag") {
    return hasAnyFlag(args, new Set(["-d", "-D", "-m", "-M", "-c", "-C", "-f"])) ? "mutating" : "read";
  }
  if (sub === "remote") {
    const action = args.find((arg) => ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune"].includes(arg));
    return action ? "mutating" : "read";
  }
  if (sub === "stash") {
    const action = args.find((arg) => !arg.startsWith("-"));
    return action === "list" || action === "show" ? "read" : "mutating";
  }
  if (sub === "config") {
    return hasAnyFlag(args, new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"])) ? "read" : "mutating";
  }
  if (sub === "hash-object") return hasAnyFlag(args, new Set(["-w"])) ? "mutating" : "read";
  return "mutating";
}

function assessPackageManager(name: string, args: string[]): CommandCategory {
  const sub = firstNonFlag(args, new Set(["--prefix", "--cwd", "-C", "--filter"]));
  if (!sub) return "read";
  if (sub === "test" || sub === "t") return "test";
  if (sub === "run" || sub === "run-script" || sub === "exec" || sub === "x") {
    const script = args.find((arg) => !arg.startsWith("-") && arg !== sub) ?? "";
    if (/^(test|tests|test:.+|lint|lint:.+|typecheck|type-check|check|check:.+|validate|verify|audit|format:check)$/i.test(script)) return "test";
    if (/^(build|compile|bundle|package|release|deploy|publish|prepare|prepublish|postinstall|preinstall)$/i.test(script)) return "mutating";
    return "unknown";
  }
  if (["list", "ls", "view", "info", "show", "outdated", "explain", "why", "ping", "doctor", "root", "prefix", "bin", "help", "licenses", "fund"].includes(sub)) return "read";
  if (sub === "audit") return args.includes("fix") ? "mutating" : "read";
  if (sub === "config" || sub === "get") return args.includes("set") || args.includes("delete") ? "mutating" : "read";
  if (name === "bun" && sub === "pm") {
    const pmSub = args.find((arg) => !arg.startsWith("-") && arg !== "pm") ?? "";
    return pmSub === "ls" || pmSub === "list" ? "read" : "mutating";
  }
  if (["install", "i", "add", "remove", "rm", "uninstall", "update", "upgrade", "ci", "publish", "link", "unlink", "dedupe", "prune", "patch", "patch-commit", "set", "delete", "create", "init", "rebuild", "reinstall", "pack", "version"].includes(sub)) return "mutating";
  return "unknown";
}

function assessInterpreter(name: string, args: string[]): CommandCategory {
  if (SHELL_INTERPRETERS.has(name)) return "mutating";
  const inlineFlags = INLINE_CODE_FLAGS.get(name);
  if (inlineFlags && args.some((arg) => inlineFlags.has(arg))) return "mutating";
  if (name === "deno" && args[0] === "run") return "mutating";
  if (name === "python" || name === "python3") {
    if (args.some((arg) => arg === "-m" && ["pytest", "unittest"].includes(args[args.indexOf(arg) + 1] ?? ""))) return "test";
    if (args[0] === "-m") return "unknown";
  }
  return "unknown";
}

function hasFileMutation(segment: string): boolean {
  if (hasOutputRedirection(segment)) return true;
  const { name, args } = extractBaseCommand(segment);
  const direct = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "dd", "mv", "cp", "install", "rsync", "scp", "sftp", "tee", "touch", "mkdir", "mknod", "ln", "link", "rename", "zip", "unzip", "gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "7z", "cpio", "patch"]);
  if (direct.has(name)) return true;
  if (name === "sed" && hasAnyFlag(args, new Set(["-i", "--in-place"]))) return true;
  if ((name === "awk" || name === "gawk") && hasAnyFlag(args, new Set(["-i", "--include"])) && args.includes("inplace")) return true;
  if (name === "find" && hasAnyFlag(args, new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]))) return true;
  if (name === "tar") {
    const flag = args.find((arg) => arg.startsWith("-") && !arg.startsWith("--")) ?? "";
    if (/[xcruAd]/.test(flag.slice(1))) return true;
  }
  if ((name === "curl" && hasAnyFlag(args, new Set(["-o", "-O", "--output", "--remote-name"]))) || (name === "wget" && hasAnyFlag(args, new Set(["-O", "-o", "-P", "--output-document", "--output-file", "--directory-prefix"])))) return true;
  if (SHELL_INTERPRETERS.has(name) || INLINE_CODE_FLAGS.has(name) || name === "deno") {
    return /(?:>>?|&>)(?!&(?:\d+|-))|\b(?:rm|rmdir|unlink|shred|truncate|dd|mv|cp|install|tee|touch|mkdir|mkdirp|writeFile|writeFileSync|appendFile|appendFileSync|unlinkSync|rmSync|rmdirSync|renameSync|copyFileSync|write_text|write_bytes)\b|find\s+[^\n]*\-(?:delete|exec)|sed\s+[^\n]*\-i/i.test(segment);
  }
  if (COMMAND_SUBSTITUTION.test(segment)) return /\b(?:rm|rmdir|unlink|shred|truncate|dd|mv|cp|install|tee|touch|mkdir|writeFile|writeFileSync|appendFile|appendFileSync|unlinkSync|rmSync|rmdirSync|renameSync|copyFileSync)\b/i.test(segment);
  if (name === "git") {
    const sub = firstNonFlag(args, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]));
    return ["checkout", "restore", "reset", "clean", "apply", "am", "merge", "rebase", "cherry-pick"].includes(sub);
  }
  return false;
}

function assessSegment(segment: string): { category: CommandCategory; reason: string } {
  const { name, args } = extractBaseCommand(segment);
  if (!name) return { category: "unknown", reason: "空命令段" };
  if (hasOutputRedirection(segment)) return { category: "mutating", reason: `输出重定向会写入文件：${name}` };
  if (COMMAND_SUBSTITUTION.test(segment)) return { category: "unknown", reason: "包含命令替换或进程替换，无法静态确认" };
  if (SHELL_INTERPRETERS.has(name)) return { category: "mutating", reason: `通过 ${name} 执行内联脚本` };
  const inlineFlags = INLINE_CODE_FLAGS.get(name);
  if (inlineFlags && args.some((arg) => inlineFlags.has(arg))) return { category: "mutating", reason: `${name} 内联代码执行` };
  if (INLINE_CODE_FLAGS.has(name) || name === "deno") {
    const category = assessInterpreter(name, args);
    return { category, reason: category === "test" ? "解释器测试命令" : category === "mutating" ? "解释器内联执行" : `${name} 脚本执行需要确认` };
  }
  if (name === "find" && hasAnyFlag(args, new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]))) return { category: "mutating", reason: "find 带有删除或执行动作" };
  if (name === "sed" && hasAnyFlag(args, new Set(["-i", "--in-place"]))) return { category: "mutating", reason: "sed 原地修改文件" };
  if ((name === "awk" || name === "gawk") && hasAnyFlag(args, new Set(["-i", "--include"])) && args.includes("inplace")) return { category: "mutating", reason: "awk 原地修改文件" };
  if (name === "tar") {
    const flag = args.find((arg) => arg.startsWith("-") && !arg.startsWith("--")) ?? "";
    if (/[xcuraAd]/.test(flag.slice(1))) return { category: "mutating", reason: "tar 会写入文件" };
    return { category: "read", reason: "tar 只读列表" };
  }
  if (name === "git") { const category = assessGit(args); return { category, reason: category === "read" ? "git 只读子命令" : "git 会修改仓库状态" }; }
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    const category = assessPackageManager(name, args);
    return { category, reason: category === "read" ? `${name} 只读子命令` : category === "test" ? `${name} 测试命令` : `${name} 会修改项目或依赖` };
  }
  if (name === "go") {
    const sub = firstNonFlag(args, new Set(["-C"]));
    return sub === "test" ? { category: "test", reason: "go test" } : sub === "env" || sub === "version" || sub === "list" || sub === "doc" ? { category: "read", reason: "go 只读子命令" } : { category: "mutating", reason: "go 会写入构建产物或依赖" };
  }
  if (name === "cargo") {
    const sub = firstNonFlag(args, new Set(["--manifest-path", "--config", "-Z"]));
    return sub === "test" ? { category: "test", reason: "cargo test" } : sub === "metadata" || sub === "tree" || sub === "version" ? { category: "read", reason: "cargo 只读子命令" } : { category: "mutating", reason: "cargo 会写入构建产物或依赖" };
  }
  if (name === "docker" || name === "podman") {
    const sub = firstNonFlag(args, new Set(["--context", "-H", "--host", "--config", "--log-level"]));
    if (["ps", "images", "inspect", "logs", "version", "info", "stats", "top", "port", "history", "diff", "events", "search"].includes(sub)) return { category: "read", reason: "容器只读子命令" };
    if (sub === "system" || sub === "image" || sub === "container") {
      const nested = args.find((arg) => !arg.startsWith("-") && arg !== sub) ?? "";
      if (["df", "info", "ls", "list", "inspect"].includes(nested)) return { category: "read", reason: "容器只读子命令" };
    }
    return { category: "mutating", reason: "容器命令会修改运行状态" };
  }
  if (name === "kubectl") {
    const sub = firstNonFlag(args, new Set(["--context", "--namespace", "-n", "--kubeconfig", "--cluster", "--user"]));
    if (["get", "describe", "logs", "version", "api-resources", "api-versions", "explain", "cluster-info", "top", "events", "auth"].includes(sub)) return { category: "read", reason: "kubectl 只读子命令" };
    if (sub === "config") {
      const nested = args.find((arg) => !arg.startsWith("-") && arg !== sub) ?? "";
      return nested === "view" ? { category: "read", reason: "kubectl config view" } : { category: "mutating", reason: "kubectl config 会写入配置" };
    }
    return { category: "mutating", reason: "kubectl 会修改集群状态" };
  }
  if (name === "systemctl") {
    const sub = firstNonFlag(args, new Set(["--type", "-t", "--state", "--property", "-p", "--user", "--machine", "-M"]));
    if (["status", "is-active", "is-enabled", "is-failed", "show", "list-units", "list-unit-files", "cat", "list-timers", "list-sockets", "help"].includes(sub)) return { category: "read", reason: "systemctl 只读子命令" };
    return { category: "mutating", reason: "systemctl 会修改服务状态" };
  }
  if (name === "curl") {
    if (hasAnyFlag(args, new Set(["-o", "-O", "-T", "--output", "--remote-name", "--upload-file", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "--post-data"]))) return { category: "mutating", reason: "curl 会写入文件或发送数据" };
    const method = args.find((arg) => arg === "-X" || arg === "--request");
    if (method && args[args.indexOf(method) + 1] && !/^GET$/i.test(args[args.indexOf(method) + 1] ?? "")) return { category: "mutating", reason: "curl 非 GET 请求" };
    return { category: "read", reason: "curl 只读请求" };
  }
  if (name === "wget") {
    if (hasAnyFlag(args, new Set(["-O", "-o", "-P", "--output-document", "--output-file", "--directory-prefix", "--post-data", "--post-file", "--method"]))) return { category: "mutating", reason: "wget 会写入文件或发送数据" };
    return { category: "read", reason: "wget 只读请求" };
  }
  if (name === "ip" || name === "hostnamectl" || name === "timedatectl" || name === "localectl") {
    const sub = firstNonFlag(args, new Set());
    if (["addr", "address", "route", "link", "neigh", "rule", "show", "status", "get-default", "list-timezones", "list-locales", "list-keymaps"].includes(sub) || !sub) return { category: "read", reason: `${name} 只读子命令` };
    return { category: "mutating", reason: `${name} 会修改系统状态` };
  }
  if (name === "service") return hasAnyFlag(args, new Set(["--status"])) ? { category: "read", reason: "service --status" } : { category: "mutating", reason: "service 会修改服务状态" };
  if (name === "umask") return args.length === 0 ? { category: "read", reason: "umask 查询" } : { category: "read", reason: "umask 只影响当前子进程" };
  if (TEST_COMMANDS.has(name)) return { category: "test", reason: `${name} 测试命令` };
  if (READ_ONLY.has(name)) return { category: "read", reason: `${name} 只读命令` };
  if (MUTATING.has(name)) return { category: "mutating", reason: `${name} 会修改系统` };
  return { category: "unknown", reason: `未识别的命令：${name}` };
}

export function assessCommand(command: string): CommandAssessment {
  const trimmed = command.trim();
  if (!trimmed) return { requiresConfirmation: true, category: "unknown", reason: "空命令" };
  const segments = splitShellSegments(trimmed);
  if (!segments.length) return { requiresConfirmation: true, category: "unknown", reason: "空命令" };
  const results = segments.map((segment) => ({ segment, assessment: assessSegment(segment) }));
  const fileMutation = results.find(({ segment }) => hasFileMutation(segment));
  if (fileMutation) return { requiresConfirmation: true, category: "mutating", reason: fileMutation.assessment.reason };
  const isTest = results.some((result) => result.assessment.category === "test");
  const isUnknown = results.some((result) => result.assessment.category === "unknown");
  return { requiresConfirmation: false, category: isTest ? "test" : isUnknown ? "unknown" : "read", reason: isTest ? "测试命令自动执行" : "非文件变更命令自动执行" };
}
