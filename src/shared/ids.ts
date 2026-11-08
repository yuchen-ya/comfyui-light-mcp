import { randomUUID } from "node:crypto";

export function newUuid(): string {
  return randomUUID();
}

/** 短 id，仅用于日志可读性，不作业务句柄 */
export function shortId(): string {
  return randomUUID().slice(0, 8);
}
