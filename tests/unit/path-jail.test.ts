import { describe, expect, it } from "vitest";
import { jailedJoin, safeFileName, PathJailError } from "../../src/core/assets/path-jail.js";

describe("path-jail（Windows 向量清单）", () => {
  it("合法相对片段通过", () => {
    expect(jailedJoin("C:\\out", "batch-1", "0", "img.png")).toMatch(/batch-1[\\/]0[\\/]img\.png$/);
    expect(jailedJoin("out", "b", "i.png")).toBeTruthy();
  });

  const rejects = [
    ["..", "escape"],
    ["a", "..", "b"],
    ["a/../../c"],
    ["..\\..\\windows"],
    ["C:\\absolute"],
    ["\\\\server\\share"],
    ["//server/share"],
    ["/abs"],
    ["\\"]
  ];
  for (const segs of rejects) {
    it(`拒绝 ${JSON.stringify(segs)}`, () => {
      expect(() => jailedJoin("root", ...(segs as string[]))).toThrow(PathJailError);
    });
  }

  it("空片段拒绝", () => {
    expect(() => jailedJoin("root", "")).toThrow(PathJailError);
  });
});

describe("safeFileName", () => {
  it("普通文件名通过", () => {
    expect(safeFileName("ComfyUI_00042_.png")).toBe("ComfyUI_00042_.png");
  });

  const badNames = ["", ".", "..", "a/b", "a\\b", "C:x", 'a"b', "a<b", "a|b", "a?b", "a*b", "NUL", "CON.png", "lpt1.txt", "image.", "image "];
  for (const n of badNames) {
    it(`拒绝 "${n}"`, () => {
      expect(() => safeFileName(n)).toThrow(PathJailError);
    });
  }
});
