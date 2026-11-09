import path from "node:path";

/**
 * Windows 路径安全（docs/002 §9 Q7）：
 * 拒绝绝对路径、盘符、UNC、.. 逃逸；resolve 后必须仍在 root 内。
 */

export class PathJailError extends Error {
  constructor(message: string) {
    super(`路径不安全: ${message}`);
    this.name = "PathJailError";
  }
}

/** 校验相对片段并返回 root 下的绝对路径；非法即抛错 */
export function jailedJoin(rootDir: string, ...segments: string[]): string {
  const root = path.resolve(rootDir);
  for (const seg of segments) {
    if (typeof seg !== "string" || seg === "") throw new PathJailError(`空路径片段`);
    if (path.win32.isAbsolute(seg) || path.posix.isAbsolute(seg)) {
      throw new PathJailError(`不允许绝对路径: "${seg}"`);
    }
    if (/^[a-zA-Z]:/.test(seg)) throw new PathJailError(`不允许盘符路径: "${seg}"`);
    if (seg.startsWith("\\\\") || seg.startsWith("//")) throw new PathJailError(`不允许 UNC 路径: "${seg}"`);
    for (const part of seg.split(/[\\/]+/)) {
      if (part === "..") throw new PathJailError(`不允许 ".." 上跳: "${seg}"`);
    }
  }
  const full = path.resolve(root, ...segments);
  const rel = path.relative(root, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathJailError(`解析后越出根目录: ${full}`);
  }
  return full;
}

/** 文件名安全（单段，无分隔符语义） */
export function safeFileName(name: string): string {
  if (!name || name === "." || name === "..") throw new PathJailError(`非法文件名: "${name}"`);
  if (/[\\/]/.test(name)) throw new PathJailError(`文件名含路径分隔符: "${name}"`);
  if (/^[a-zA-Z]:/.test(name)) throw new PathJailError(`文件名含盘符: "${name}"`);
  // Windows 保留字符（含控制字符 0x00-0x1f，属安全校验的刻意使用）
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\x00-\x1f]/.test(name)) throw new PathJailError(`文件名含 Windows 保留字符: "${name}"`);
  if (/[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new PathJailError(`文件名含 Windows 设备名或末尾点/空格: "${name}"`);
  }
  return name;
}
