/**
 * Decides whether an AI Agent shell command needs the user's confirmation.
 *
 * Blacklist model (owner decision): only commands that write, modify, move or
 * delete files or data pause for confirmation. Reads, network reads, process
 * listing and unknown commands run automatically. When the command that would
 * actually run cannot be known statically (a dynamic command name, `eval` of
 * dynamic text, a shell or interpreter reading code from an unknown pipe) it is
 * treated as a possible delete and needs confirmation.
 *
 * This is best-effort static analysis of bash, not a sandbox.
 */

export type CommandAssessment = { requiresConfirmation: boolean; reason: string };

// Marks text produced by an expansion ($VAR, $(...), `...`, $'...') that is only
// known at run time.
const DYN = "\u0001";
const MAX_DEPTH = 8;

type Word = { text: string; glob: boolean; quoted: boolean };
type Redirect = { op: string; target: Word };
type Segment = { words: Word[]; redirects: Redirect[]; stdin: string[]; pipedFrom: Segment | null };
type Stdin = { texts: string[]; unknown: boolean };

const SAFE_TARGET = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const RESERVED_SKIP = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "]]"]);
const BLOCK_START = new Set(["for", "case", "select", "function", "[[", "[", "test"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);
const ALWAYS_WRITE = new Set([
  "rm", "rmdir", "unlink", "shred", "wipe", "truncate", "mv", "cp", "install", "rsync", "scp", "touch",
  "mkdir", "mknod", "mkfifo", "ln", "link", "rename", "chmod", "chown", "chgrp", "chattr", "setfacl",
  "mkswap", "wipefs", "fdisk", "sfdisk", "parted", "split", "csplit", "zip", "sudoedit",
]);
const COMPRESSORS = new Set(["gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "lzma", "unlzma", "zstd", "unzstd", "pigz", "unpigz", "lz4", "compress", "uncompress", "brotli"]);
const SQL_CLIENTS = new Set(["sqlite3", "mysql", "mariadb", "psql"]);
const GIT_WRITE = new Set(["rm", "mv", "clean", "restore", "checkout", "switch", "pull", "merge", "rebase", "cherry-pick", "revert", "am", "clone", "init"]);
const INLINE_WRITE = new RegExp([
  String.raw`\bf?open\s*\([^)]*,\s*(?:mode\s*=\s*)?["'][^"']*[wax+]`,
  String.raw`\bopen\s*\(?\s*(?:my\s+)?[$\w]*\s*,\s*["']\s*(?:>|\+<|\|)`,
  String.raw`\b(?:unlink|rmdir|rename|mkdir|makedirs|removedirs|truncate|chmod|chown|symlink|rmtree|writeFile|appendFile|copyFile|createWriteStream|file_put_contents|write_text|write_bytes|touch)(?:Sync)?\s*[(\s]`,
  String.raw`\.(?:rm|cp|move|copy\w*)(?:Sync)?\s*\(|\bos\.remove\b`,
  String.raw`\bBun\.write\b|\bDeno\.(?:write\w*|remove|rename|mkdir|truncate|chmod|chown|symlink|link|copyFile|create)\b`,
  String.raw`\b(?:File|IO)\.(?:write|delete|unlink|rename|symlink|link|chmod|chown|truncate)\b|\bFileUtils\.\w+|\bDir\.(?:mkdir|rmdir|delete|unlink)\b`,
].join("|"));
const INLINE_SPAWN = /\b(?:system|popen|Popen|exec\w*|spawn\w*|subprocess|child_process|shell_exec|passthru|proc_open)\b|`|%x|\bqx\b/;

const isDynamic = (text: string): boolean => text.includes(DYN);
const isSafeTarget = (text: string): boolean => !isDynamic(text) && SAFE_TARGET.test(text);
const show = (text: string): string => text.replaceAll(DYN, "$…");

class Lexer {
  private i = 0;
  readonly nested: string[] = [];
  readonly segments: Segment[] = [];
  private cur: Segment = { words: [], redirects: [], stdin: [], pipedFrom: null };
  private heredocs: Array<{ delim: string; strip: boolean; expand: boolean; seg: Segment }> = [];

  constructor(private readonly s: string) {}

  run(): this {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i] ?? "";
      const next = s[this.i + 1] ?? "";
      if (c === " " || c === "\t" || c === "\r") { this.i += 1; continue; }
      if (c === "\\" && next === "\n") { this.i += 2; continue; }
      if (c === "\n") { this.i += 1; this.readHeredocs(); this.end(false); continue; }
      if (c === "#") { while (this.i < s.length && s[this.i] !== "\n") this.i += 1; continue; }
      if (this.inDoubleBracket() && (c === "<" || c === ">")) { this.cur.words.push({ text: c, glob: false, quoted: true }); this.i += 1; continue; }
      if (c === "(" && next === "(" && !this.cur.words.length) {
        const end = this.balanced(this.i + 1);
        this.scanExpansions(s.slice(this.i + 2, end - 1));
        this.i = s[end] === ")" ? end + 1 : end;
        continue;
      }
      if (c === ";") { this.i += next === ";" || next === "&" ? 2 : 1; this.end(false); continue; }
      if (c === "&" && next !== ">") { this.i += next === "&" ? 2 : 1; this.end(false); continue; }
      if (c === "|") { this.i += next === "|" || next === "&" ? 2 : 1; this.end(next !== "|"); continue; }
      if (c === "(" || c === ")") { this.i += 1; this.end(false); continue; }
      if ((c === "<" || c === ">" || c === "&") && next !== "(") { this.readRedirect(); continue; }
      const word = this.readWord();
      if (!word.quoted && /^\d+$/.test(word.text) && (s[this.i] === "<" || s[this.i] === ">") && s[this.i + 1] !== "(") { this.readRedirect(); continue; }
      this.cur.words.push(word);
    }
    this.readHeredocs();
    this.end(false);
    return this;
  }

  private inDoubleBracket(): boolean {
    return this.cur.words[0]?.text === "[[" && !this.cur.words.some((word) => word.text === "]]");
  }

  private end(pipe: boolean): void {
    const done = this.cur;
    if (done.words.length || done.redirects.length) this.segments.push(done);
    this.cur = { words: [], redirects: [], stdin: [], pipedFrom: pipe ? done : null };
  }

  private readRedirect(): void {
    const ops = ["&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<>", "<&", ">", "<"];
    const op = ops.find((candidate) => this.s.startsWith(candidate, this.i)) ?? this.s[this.i] ?? "";
    this.i += op.length;
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i += 1;
    const target = this.readWord();
    if (op === "<<" || op === "<<-") {
      this.heredocs.push({ delim: target.text, strip: op === "<<-", expand: !target.quoted, seg: this.cur });
      return;
    }
    if (op === "<<<") this.cur.stdin.push(target.text);
    this.cur.redirects.push({ op, target });
  }

  private readHeredocs(): void {
    for (const heredoc of this.heredocs) {
      const body: string[] = [];
      while (this.i < this.s.length) {
        const lineEnd = this.s.indexOf("\n", this.i);
        const line = this.s.slice(this.i, lineEnd < 0 ? this.s.length : lineEnd);
        this.i = lineEnd < 0 ? this.s.length : lineEnd + 1;
        if ((heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.delim) break;
        body.push(line);
      }
      const text = body.join("\n");
      heredoc.seg.stdin.push(text);
      if (heredoc.expand) this.scanExpansions(text);
    }
    this.heredocs = [];
  }

  private readWord(): Word {
    const s = this.s;
    let text = "";
    let glob = false;
    let quoted = false;
    while (this.i < s.length) {
      const c = s[this.i] ?? "";
      if ((c === "<" || c === ">") && s[this.i + 1] === "(") {
        const end = this.balanced(this.i + 1);
        this.nested.push(s.slice(this.i + 2, end - 1));
        text += DYN;
        this.i = end;
        continue;
      }
      if (" \t\r\n;&|()<>".includes(c)) break;
      if (c === "\\") { if (s[this.i + 1] !== "\n") text += s[this.i + 1] ?? ""; this.i += 2; quoted = true; continue; }
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        const stop = end < 0 ? s.length : end;
        text += s.slice(this.i + 1, stop);
        this.i = stop + 1;
        quoted = true;
        continue;
      }
      if (c === '"') { this.i += 1; text += this.readDouble('"'); quoted = true; continue; }
      if (c === "$") { text += this.readDollar(false); continue; }
      if (c === "`") { text += this.readBacktick(); continue; }
      if (c === "*" || c === "?" || c === "[") glob = true;
      text += c;
      this.i += 1;
    }
    return { text, glob, quoted };
  }

  // Reads double-quoted content up to `terminator` (or to the end when null).
  private readDouble(terminator: string | null): string {
    const s = this.s;
    let out = "";
    while (this.i < s.length && s[this.i] !== terminator) {
      const c = s[this.i] ?? "";
      if (c === "\\") {
        const n = s[this.i + 1] ?? "";
        if ('$`"\\\n'.includes(n) && n) { if (n !== "\n") out += n; this.i += 2; } else { out += c; this.i += 1; }
        continue;
      }
      if (c === "$") { out += this.readDollar(true); continue; }
      if (c === "`") { out += this.readBacktick(); continue; }
      out += c;
      this.i += 1;
    }
    this.i += 1;
    return out;
  }

  private readDollar(inDouble: boolean): string {
    const s = this.s;
    const n = s[this.i + 1] ?? "";
    if (n === "'" && !inDouble) {
      let j = this.i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
      this.i = j + 1;
      return DYN;
    }
    if (n === "(") {
      const end = this.balanced(this.i + 1);
      const inner = s.slice(this.i + 2, end - 1);
      if (s[this.i + 2] === "(") this.scanExpansions(inner);
      else this.nested.push(inner);
      this.i = end;
      return DYN;
    }
    if (n === "{") {
      let j = this.i + 2;
      let depth = 1;
      while (j < s.length && depth > 0) { if (s[j] === "{") depth += 1; else if (s[j] === "}") depth -= 1; j += 1; }
      this.scanExpansions(s.slice(this.i + 2, j - 1));
      this.i = j;
      return DYN;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(this.i + 1));
    if (name) { this.i += 1 + name[0].length; return DYN; }
    this.i += 1;
    return "$";
  }

  private readBacktick(): string {
    const s = this.s;
    let j = this.i + 1;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    this.nested.push(s.slice(this.i + 1, j).replace(/\\([`$\\])/g, "$1"));
    this.i = j + 1;
    return DYN;
  }

  // Index just past the `)` matching the `(` at openIndex, honouring quotes.
  private balanced(openIndex: number): number {
    const s = this.s;
    let depth = 0;
    for (let j = openIndex; j < s.length; j += 1) {
      const c = s[j];
      if (c === "\\") { j += 1; continue; }
      if (c === "'") { const end = s.indexOf("'", j + 1); j = end < 0 ? s.length : end; continue; }
      if (c === '"') { j += 1; while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1; continue; }
      if (c === "(") depth += 1;
      else if (c === ")") { depth -= 1; if (depth === 0) return j + 1; }
    }
    return s.length;
  }

  // Collects command substitutions inside text that the shell expands (heredoc
  // bodies, ${...}, arithmetic).
  private scanExpansions(text: string): void {
    const sub = new Lexer(text);
    sub.readDouble(null);
    this.nested.push(...sub.nested);
  }
}

type Options = { opts: Array<[string, string | true]>; positionals: Word[]; rest: number };

// Parses getopt-style options. `value` letters take an argument (rest of the
// cluster or the next word), `optional` letters take only the rest of the
// cluster, `digits` letters take trailing digits. Without `permute`, parsing
// stops at the first positional and `rest` is its index.
function parseOptions(args: Word[], spec: { value?: string; optional?: string; digits?: string; long?: string[]; permute?: boolean }): Options {
  const value = spec.value ?? "";
  const optional = spec.optional ?? "";
  const digits = spec.digits ?? "";
  const long = new Set(spec.long ?? []);
  const opts: Array<[string, string | true]> = [];
  const positionals: Word[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index]?.text ?? "";
    if (arg === "--") { index += 1; if (spec.permute) positionals.push(...args.slice(index)); break; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) opts.push([arg.slice(0, eq), arg.slice(eq + 1)]);
      else if (long.has(arg)) { opts.push([arg, args[index + 1]?.text ?? ""]); index += 1; }
      else opts.push([arg, true]);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let position = 1; position < arg.length; position += 1) {
        const letter = arg[position] ?? "";
        const rest = arg.slice(position + 1);
        if (optional.includes(letter)) { opts.push([`-${letter}`, rest]); break; }
        if (digits.includes(letter)) { const run = /^[0-9a-fA-Fx]*/.exec(rest)?.[0] ?? ""; opts.push([`-${letter}`, run]); position += run.length; continue; }
        if (value.includes(letter)) {
          if (rest) opts.push([`-${letter}`, rest]);
          else { opts.push([`-${letter}`, args[index + 1]?.text ?? ""]); index += 1; }
          break;
        }
        opts.push([`-${letter}`, true]);
      }
      continue;
    }
    if (!spec.permute) break;
    positionals.push(args[index] as Word);
  }
  return { opts, positionals: spec.permute ? positionals : args.slice(index), rest: index };
}

const has = (parsed: Options, ...names: string[]): boolean => parsed.opts.some(([name]) => names.includes(name));
const values = (parsed: Options, ...names: string[]): string[] => parsed.opts.filter(([name, value]) => names.includes(name) && value !== true).map(([, value]) => value as string);

function assessText(command: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return "命令嵌套过深，无法静态判断";
  const lexer = new Lexer(command).run();
  for (const inner of lexer.nested) {
    const reason = assessText(inner, depth + 1);
    if (reason) return reason;
  }
  for (const segment of lexer.segments) {
    const reason = assessSegment(segment, depth);
    if (reason) return reason;
  }
  return null;
}

function assessSegment(segment: Segment, depth: number): string | null {
  for (const redirect of segment.redirects) {
    const writes = WRITE_REDIRECTS.has(redirect.op) || (redirect.op === ">&" && !/^(?:\d+|-)$/.test(redirect.target.text));
    if (writes && (redirect.target.glob || !isSafeTarget(redirect.target.text))) return `输出重定向会写入文件：${show(redirect.target.text) || "(空)"}`;
  }
  const stdin: Stdin = { texts: [...segment.stdin], unknown: false };
  if (segment.pipedFrom) {
    const piped = staticEcho(segment.pipedFrom);
    if (piped === null) stdin.unknown = true;
    else stdin.texts.push(piped);
  }
  return assessWords(segment.words, depth, stdin);
}

// Output of a preceding `echo`/`printf` with literal arguments, or null when the
// piped data cannot be known.
function staticEcho(segment: Segment): string | null {
  const [name, ...args] = segment.words.map((word) => word.text);
  if ((name !== "echo" && name !== "printf") || args.some(isDynamic)) return null;
  return args.filter((arg) => !/^-[neE]+$/.test(arg)).join(" ").replace(/\\n/g, "\n");
}

function assessWords(words: Word[], depth: number, stdin: Stdin): string | null {
  if (depth > MAX_DEPTH) return "命令嵌套过深，无法静态判断";
  let index = 0;
  while (index < words.length && (ASSIGNMENT.test(words[index]?.text ?? "") || RESERVED_SKIP.has(words[index]?.text ?? ""))) index += 1;
  const nameWord = words[index];
  if (!nameWord || BLOCK_START.has(nameWord.text)) return null;
  if (isDynamic(nameWord.text) || nameWord.glob) return "命令名是动态生成的（变量、命令替换、通配符或转义），可能隐藏删除操作";
  const name = nameWord.text.split("/").pop() ?? nameWord.text;
  return assessCommandName(name, words.slice(index + 1), depth, stdin);
}

function assessCode(name: string, codes: string[], depth: number): string | null {
  for (const code of codes) {
    if (isDynamic(code)) return `${name} 内联代码包含动态内容，可能隐藏删除操作`;
    if (INLINE_WRITE.test(code)) return `${name} 内联代码会写入或删除文件`;
    if (INLINE_SPAWN.test(code)) {
      for (const literal of code.matchAll(/'([^'\n]*)'|"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g)) {
        const reason = assessText(literal[1] ?? literal[2] ?? literal[3] ?? "", depth + 1);
        if (reason) return reason;
      }
    }
  }
  return null;
}

// Interpreter given neither inline code nor a script: it runs whatever arrives on stdin.
function assessStdinCode(name: string, stdin: Stdin, depth: number, shell: boolean): string | null {
  if (stdin.unknown) return `${name} 执行来自管道的未知代码，可能隐藏删除操作`;
  for (const text of stdin.texts) {
    const reason = shell ? assessText(text, depth + 1) : assessCode(name, [text], depth);
    if (reason) return reason;
  }
  return null;
}

function assessShell(name: string, args: Word[], depth: number, stdin: Stdin): string | null {
  let index = 0;
  let commandMode = false;
  let stdinMode = false;
  for (; index < args.length; index += 1) {
    const arg = args[index]?.text ?? "";
    if (arg === "--" || arg === "-") { index += 1; break; }
    if (arg.startsWith("--")) { if (arg === "--rcfile" || arg === "--init-file") index += 1; continue; }
    if (!/^[-+]./.test(arg)) break;
    for (const letter of arg.slice(1)) {
      if (letter === "c") commandMode = true;
      if (letter === "s") stdinMode = true;
      if (letter === "o" || letter === "O") index += 1;
    }
  }
  const first = args[index];
  if (commandMode) {
    if (!first) return null;
    return isDynamic(first.text) ? `${name} -c 执行动态生成的命令，可能隐藏删除操作` : assessText(first.text, depth + 1);
  }
  if (first && !stdinMode) return isDynamic(first.text) ? `${name} 执行动态生成的脚本，可能隐藏删除操作` : null;
  return assessStdinCode(name, stdin, depth, true);
}

function assessInterpreter(name: string, args: Word[], depth: number, stdin: Stdin): string | null | undefined {
  let parsed: Options;
  let codeFlags: string[];
  if (/^(?:python[0-9.]*|pypy3?)$/.test(name)) {
    parsed = parseOptions(args, { value: "cWXmQ" });
    if (has(parsed, "-m")) return null;
    codeFlags = ["-c"];
  } else if (name === "perl") {
    parsed = parseOptions(args, { value: "eEIMmxCdD", optional: "iF", digits: "l0" });
    if (has(parsed, "-i")) return "perl -i 会原地修改文件";
    codeFlags = ["-e", "-E"];
  } else if (name === "ruby") {
    parsed = parseOptions(args, { value: "eIrEC", optional: "iFTx", digits: "0l" });
    if (has(parsed, "-i")) return "ruby -i 会原地修改文件";
    codeFlags = ["-e"];
  } else if (name === "node" || name === "nodejs" || name === "bun") {
    parsed = parseOptions(args, { value: "eprC", long: ["--eval", "--print", "--require", "--import", "--loader", "--input-type", "--conditions"] });
    codeFlags = ["-e", "-p", "--eval", "--print"];
    if (name === "bun" && parsed.positionals.length && !values(parsed, ...codeFlags).length) return null;
  } else if (name === "deno") {
    if (args[0]?.text !== "eval") return null;
    return assessCode(name, args.slice(1).map((word) => word.text).filter((arg) => !arg.startsWith("-")), depth);
  } else if (name === "php") {
    parsed = parseOptions(args, { value: "rfcdzBREF" });
    codeFlags = ["-r", "-B", "-R", "-E", "-F"];
  } else if (name === "lua") {
    parsed = parseOptions(args, { value: "el" });
    codeFlags = ["-e"];
  } else {
    return undefined;
  }
  const codes = values(parsed, ...codeFlags);
  if (codes.length) return assessCode(name, codes, depth);
  const script = parsed.positionals[0];
  if (script && script.text !== "-") return isDynamic(script.text) ? `${name} 执行动态生成的脚本，可能隐藏删除操作` : null;
  return assessStdinCode(name, stdin, depth, false);
}

function assessAwk(name: string, args: Word[], depth: number): string | null {
  const parsed = parseOptions(args, { value: "fvFiEl", long: ["--file", "--assign", "--field-separator", "--include", "--load", "--exec", "--source"] });
  if (values(parsed, "-i", "--include").some((value) => /^inplace(?:\.awk)?$/.test(value))) return `${name} -i inplace 会原地修改文件`;
  const programs = values(parsed, "--source");
  if (!has(parsed, "-f", "--file", "-E", "--exec") && parsed.positionals[0]) programs.push(parsed.positionals[0].text);
  for (const program of programs) {
    if (isDynamic(program)) return `${name} 程序包含动态内容，可能隐藏写入操作`;
    let flat = program;
    for (let previous = ""; previous !== flat;) { previous = flat; flat = flat.replace(/\([^()]*\)/g, ""); }
    for (const match of flat.matchAll(/\bprintf?\b[^;{}\n]*?(>>?|\|)\s*(?:"([^"]*)"|(\S+))/g)) {
      if (match[1] === "|") {
        const reason = match[2] === undefined ? `${name} 把输出交给动态命令执行` : assessText(match[2], depth + 1);
        if (reason) return reason;
      } else if (match[2] === undefined || !SAFE_TARGET.test(match[2])) {
        return `${name} 输出重定向会写入文件`;
      }
    }
    if (/\bsystem\s*\(|\|\s*getline/.test(program)) {
      for (const literal of program.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        const reason = assessText(literal[1] ?? "", depth + 1);
        if (reason) return reason;
      }
    }
  }
  return null;
}

function assessTar(args: Word[]): string | null {
  const texts = args.map((word) => word.text);
  let modes = "";
  let archive: string | undefined;
  let toStdout = false;
  const valueLetters = "fCbTXgKNVLHI";
  const pending: string[] = [];
  let start = 0;
  if (texts[0] && !texts[0].startsWith("-")) {
    // Old-style cluster (`tar xzf a.tar`): value letters consume the following words in order.
    for (const letter of texts[0]) {
      if ("xcruAtd".includes(letter)) modes += letter;
      if (letter === "O") toStdout = true;
      if (valueLetters.includes(letter)) pending.push(letter);
    }
    start = 1;
    for (const letter of pending) { if (letter === "f") archive = texts[start]; start += 1; }
  }
  const longModes: Record<string, string> = { "--extract": "x", "--get": "x", "--create": "c", "--append": "r", "--update": "u", "--catenate": "A", "--concatenate": "A", "--list": "t", "--diff": "d", "--compare": "d" };
  const parsed = parseOptions(args.slice(start), { value: valueLetters, long: ["--file", "--directory", "--files-from", "--exclude-from"], permute: true });
  for (const [name, value] of parsed.opts) {
    if (name === "--delete") return "tar --delete 会修改归档文件";
    if (name === "-O" || name === "--to-stdout") toStdout = true;
    if ((name === "-f" || name === "--file") && value !== true) archive = value;
    if (longModes[name]) modes += longModes[name];
    if (/^-[xcruAtd]$/.test(name)) modes += name.slice(1);
  }
  if (modes.includes("x") && !toStdout) return "tar 解包会写入文件";
  if (/[cruA]/.test(modes) && archive !== undefined && archive !== "-" && !isSafeTarget(archive)) return "tar 会写入归档文件";
  return null;
}

function assessGit(args: Word[], depth: number): string | null {
  const parsed = parseOptions(args, { value: "Cc", long: ["--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"] });
  for (const config of values(parsed, "-c")) {
    const shellAlias = config.indexOf("=!");
    if (shellAlias >= 0) { const reason = assessText(config.slice(shellAlias + 2), depth + 1); if (reason) return reason; }
  }
  const sub = parsed.positionals[0]?.text ?? "";
  const rest = parsed.positionals.slice(1).map((word) => word.text);
  if (isDynamic(sub)) return "git 子命令是动态生成的，可能隐藏删除操作";
  const reason = `git ${sub} 会修改或删除文件`;
  if (GIT_WRITE.has(sub)) return reason;
  if (sub === "stash") { const action = rest.find((arg) => !arg.startsWith("-")); return action === "list" || action === "show" ? null : reason; }
  if (sub === "reset") return rest.some((arg) => arg === "--hard" || arg === "--merge" || arg === "--keep") ? reason : null;
  if (sub === "apply") return rest.some((arg) => ["--check", "--stat", "--numstat", "--summary"].includes(arg)) ? null : reason;
  if (sub === "worktree") return ["add", "remove", "move", "prune"].includes(rest[0] ?? "") ? reason : null;
  return null;
}

function assessCommandName(name: string, args: Word[], depth: number, stdin: Stdin): string | null {
  const wrapped = (from: number): string | null => (from >= args.length ? null : assessWords(args.slice(from), depth + 1, stdin));
  const writes = `${name} 会写入或删除文件`;
  const unsafe = (list: string[]): boolean => list.some((value) => !isSafeTarget(value));
  switch (name) {
    case "sudo": {
      const parsed = parseOptions(args, { value: "ughpCDrtTUR", long: ["--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--role", "--type", "--other-user", "--command-timeout", "--chroot"] });
      if (has(parsed, "-e", "--edit")) return "sudo -e 会编辑文件";
      if (has(parsed, "-l", "--list", "-v", "--validate", "-k", "-K")) return null;
      return wrapped(parsed.rest);
    }
    case "doas": return wrapped(parseOptions(args, { value: "uC" }).rest);
    case "timeout": return wrapped(parseOptions(args, { value: "sk", long: ["--signal", "--kill-after"] }).rest + 1);
    case "env": {
      const parsed = parseOptions(args, { value: "uCS", long: ["--unset", "--chdir", "--split-string"] });
      for (const split of values(parsed, "-S", "--split-string")) {
        const reason = isDynamic(split) ? "env -S 执行动态生成的命令" : assessText([split, ...args.slice(parsed.rest).map((word) => word.text)].join(" "), depth + 1);
        if (reason) return reason;
      }
      return wrapped(parsed.rest);
    }
    case "xargs": return wrapped(parseOptions(args, { value: "nLPsIdEa", optional: "ile", long: ["--max-args", "--max-lines", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--process-slot-var"] }).rest);
    case "nice": return wrapped(parseOptions(args, { value: "n", long: ["--adjustment"] }).rest);
    case "ionice": {
      const parsed = parseOptions(args, { value: "cnp", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"] });
      return has(parsed, "-p", "--pid", "--pgid", "--uid") ? null : wrapped(parsed.rest);
    }
    case "stdbuf": return wrapped(parseOptions(args, { value: "ioe", long: ["--input", "--output", "--error"] }).rest);
    case "time": {
      const parsed = parseOptions(args, { value: "fo", long: ["--format", "--output"] });
      if (unsafe(values(parsed, "-o", "--output"))) return "time -o 会写入文件";
      return wrapped(parsed.rest);
    }
    case "exec": return wrapped(parseOptions(args, { value: "a" }).rest);
    case "command": {
      const parsed = parseOptions(args, {});
      return has(parsed, "-v", "-V") ? null : wrapped(parsed.rest);
    }
    case "nohup": case "builtin": case "busybox": case "setsid": case "chronic": case "unbuffer":
      return wrapped(parseOptions(args, {}).rest);
    case "chroot": return wrapped(parseOptions(args, { long: ["--userspec", "--groups"] }).rest + 1);
    case "watch": {
      const parsed = parseOptions(args, { value: "nq", long: ["--interval"] });
      const rest = args.slice(parsed.rest).map((word) => word.text);
      if (rest.some(isDynamic)) return "watch 执行动态生成的命令";
      return rest.length ? assessText(rest.join(" "), depth + 1) : null;
    }
    case "su": {
      const parsed = parseOptions(args, { value: "cgGsw", long: ["--command", "--session-command", "--shell", "--group", "--supp-group", "--whitelist-environment"] });
      for (const command of values(parsed, "-c", "--command", "--session-command")) {
        const reason = isDynamic(command) ? "su -c 执行动态生成的命令" : assessText(command, depth + 1);
        if (reason) return reason;
      }
      return null;
    }
    case "eval": {
      const text = args.map((word) => word.text).join(" ");
      return isDynamic(text) ? "eval 执行动态生成的内容，可能隐藏删除操作" : assessText(text, depth + 1);
    }
    case "trap": {
      const action = args[0]?.text ?? "";
      if (!action || action.startsWith("-")) return null;
      return isDynamic(action) ? "trap 注册了动态生成的命令" : assessText(action, depth + 1);
    }
    case "source": case ".":
      return args.some((word) => isDynamic(word.text)) ? "source 执行动态生成的脚本，可能隐藏删除操作" : null;
    case "find":
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]?.text ?? "";
        if (arg === "-delete") return "find -delete 会删除文件";
        if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg) && !isSafeTarget(args[index + 1]?.text ?? "")) return `find ${arg} 会写入文件`;
        if (["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) {
          let end = index + 1;
          while (end < args.length && args[end]?.text !== ";" && args[end]?.text !== "+") end += 1;
          const reason = assessWords(args.slice(index + 1, end).map((word) => (word.text === "{}" ? { text: "FILE", glob: false, quoted: true } : word)), depth + 1, { texts: [], unknown: false });
          if (reason) return reason;
          index = end;
        }
      }
      return null;
    case "sed": {
      const parsed = parseOptions(args, { value: "efl", optional: "i", long: ["--expression", "--file", "--line-length"], permute: true });
      if (has(parsed, "-i", "--in-place")) return "sed -i 会原地修改文件";
      const scripts = values(parsed, "-e", "--expression");
      if (!scripts.length && !has(parsed, "-f", "--file") && parsed.positionals[0]) scripts.push(parsed.positionals[0].text);
      return scripts.some((script) => /(?:^|[;\n{}])\s*[0-9,$]*\s*[wW]\s+\S|\/[gpiImMe0-9]*w\s+\S/.test(script)) ? "sed 的 w 命令会写入文件" : null;
    }
    case "awk": case "gawk": case "mawk": case "nawk": return assessAwk(name, args, depth);
    case "tar": return assessTar(args);
    case "git": return assessGit(args, depth);
    case "dd": return args.some((word) => word.text.startsWith("of=") && !isSafeTarget(word.text.slice(3))) ? "dd of= 会写入文件" : null;
    case "tee": return unsafe(parseOptions(args, { permute: true }).positionals.map((word) => word.text)) ? writes : null;
    case "sort": case "shuf": {
      const parsed = parseOptions(args, { value: name === "sort" ? "ktoST" : "noi", long: ["--output", "--key", "--field-separator", "--buffer-size", "--temporary-directory", "--files0-from", "--random-source", "--compress-program", "--batch-size", "--head-count", "--input-range"], permute: true });
      return unsafe(values(parsed, "-o", "--output")) ? `${name} -o 会写入文件` : null;
    }
    case "uniq": {
      const output = parseOptions(args, { value: "fsw", long: ["--skip-fields", "--skip-chars", "--check-chars"], permute: true }).positionals[1];
      return output && !isSafeTarget(output.text) ? "uniq 会写入输出文件" : null;
    }
    case "curl": {
      const parsed = parseOptions(args, { value: "AbcCdDeEFHKmoPQrtTuUwxXYyz", long: ["--output", "--dump-header", "--cookie-jar", "--trace", "--trace-ascii", "--stderr", "--libcurl", "--etag-save", "--config", "--data", "--header", "--request", "--user", "--user-agent", "--form", "--upload-file", "--max-time", "--proxy", "--cookie", "--range", "--referer", "--write-out", "--connect-timeout", "--retry", "--resolve", "--data-raw", "--data-binary", "--data-urlencode", "--url"], permute: true });
      if (has(parsed, "-O", "--remote-name", "--remote-name-all")) return "curl -O 会把下载内容写入文件";
      return unsafe(values(parsed, "-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar", "--trace", "--trace-ascii", "--stderr", "--libcurl", "--etag-save").filter((value) => value !== "-")) ? "curl 会把内容写入文件" : null;
    }
    case "wget": {
      const parsed = parseOptions(args, { value: "OoaPeitTwUBQlDARIX", long: ["--output-document", "--output-file", "--append-output", "--directory-prefix", "--execute", "--input-file", "--tries", "--timeout", "--wait", "--user-agent", "--header", "--post-data", "--post-file", "--method", "--body-data"], permute: true });
      if (unsafe(values(parsed, "-o", "--output-file", "-a", "--append-output"))) return "wget 会写入日志文件";
      if (has(parsed, "--spider")) return null;
      const outputs = values(parsed, "-O", "--output-document");
      return outputs.length && outputs.every((value) => value === "-" || isSafeTarget(value)) ? null : "wget 会把下载内容写入文件";
    }
    case "unzip": {
      const parsed = parseOptions(args, { value: "dxP", permute: true });
      return has(parsed, "-l", "-t", "-v", "-p", "-Z", "-z") ? null : writes;
    }
    case "7z": case "7za": case "7zr": case "7zz": return ["l", "t", "h", "i", "b"].includes(args[0]?.text ?? "") ? null : writes;
    case "cpio": {
      const parsed = parseOptions(args, { value: "FOIEHMRC", long: ["--file", "--format", "--owner", "--pattern-file"], permute: true });
      if (has(parsed, "-t", "--list")) return null;
      if (has(parsed, "-o", "--create") && !has(parsed, "-F", "-O", "--file")) return null;
      return writes;
    }
    case "patch": return args.some((word) => word.text === "--dry-run") ? null : writes;
    case "crontab": return args.some((word) => word.text === "-l") ? null : "crontab 会修改定时任务";
    default: break;
  }
  if (SHELLS.has(name)) return assessShell(name, args, depth, stdin);
  const interpreted = assessInterpreter(name, args, depth, stdin);
  if (interpreted !== undefined) return interpreted;
  if (COMPRESSORS.has(name)) {
    const parsed = parseOptions(args, { value: "S", long: ["--suffix"], permute: true });
    return has(parsed, "-c", "--stdout", "--to-stdout", "-t", "--test", "-l", "--list") || !parsed.positionals.length ? null : writes;
  }
  if (SQL_CLIENTS.has(name)) {
    const text = [...args.map((word) => word.text), ...stdin.texts].join(" ");
    return /\b(?:insert|update|delete|drop|alter|truncate|create|replace|vacuum|grant|revoke)\b/i.test(text) ? "数据库命令会写入或删除数据" : null;
  }
  if (ALWAYS_WRITE.has(name) || name.startsWith("mkfs")) return writes;
  return null;
}

export function assessCommand(command: string): CommandAssessment {
  if (!command.trim()) return { requiresConfirmation: true, reason: "空命令" };
  const reason = assessText(command, 0);
  return reason ? { requiresConfirmation: true, reason } : { requiresConfirmation: false, reason: "不写入或删除文件，自动执行" };
}
