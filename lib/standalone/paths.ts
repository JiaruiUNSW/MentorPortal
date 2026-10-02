import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Storage must use a private directory, not a symbolic link.");
  chmodSync(absolute, 0o700);
  return realpathSync(absolute);
}

export function existingPrivateFile(path: string): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Storage files must be regular files without links.");
    chmodSync(path, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
