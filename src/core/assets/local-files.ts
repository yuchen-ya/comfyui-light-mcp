import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PathJailError } from "./path-jail.js";

export function isFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string" && "syscall" in error;
}

/** Check real paths as well as lexical paths, including existing directory junctions. */
export async function checkLocalPath(root: string, target: string): Promise<void> {
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new PathJailError("output outside OUTPUT_DIR");
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  let existing = target;
  for (;;) {
    try {
      const resolved = await realpath(existing);
      const rel = path.relative(realRoot, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new PathJailError("output symlink outside OUTPUT_DIR");
      return;
    } catch (error) {
      if (!isFileError(error) || error.code !== "ENOENT") throw error;
      existing = path.dirname(existing);
    }
  }
}

export async function localFileSize(root: string, target: string): Promise<number | null> {
  await checkLocalPath(root, target);
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new PathJailError("output is not a regular file");
    return info.size;
  } catch (error) {
    if (isFileError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Same-directory rename keeps readers on either the previous or the complete new file. */
export async function atomicWrite(root: string, target: string, data: string | Buffer): Promise<void> {
  await checkLocalPath(root, target);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readLocalText(root: string, target: string): Promise<string | null> {
  if (await localFileSize(root, target) === null) return null;
  return readFile(target, "utf8");
}
