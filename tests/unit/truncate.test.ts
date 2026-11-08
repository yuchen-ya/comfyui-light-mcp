import { describe, expect, it } from "vitest";
import { clipTail, renderBounded } from "../../src/shared/truncate.js";

describe("truncate", () => {
  it("未超长原样返回", () => {
    expect(clipTail("abc", 10)).toBe("abc");
    expect(clipTail("abcdefghij", 10)).toBe("abcdefghij");
  });

  it("超长保留尾部并加显式标记", () => {
    const out = clipTail("0123456789ABCDEF", 10);
    expect(out.startsWith("...")).toBe(true);
    expect(out).toBe("...6789ABCDEF");
    expect(out.length).toBe(13); // 3 标记 + 10 尾部
  });

  it("空值渲染 <empty>", () => {
    expect(renderBounded(null)).toBe("<empty>");
    expect(renderBounded(undefined)).toBe("<empty>");
    expect(renderBounded("")).toBe("<empty>");
    expect(renderBounded({})).toBe("<empty>");
  });

  it("对象 JSON 化且有界", () => {
    const out = renderBounded({ a: "x".repeat(500) }, 50);
    expect(out.startsWith("...")).toBe(true);
    expect(out.length).toBe(53);
  });
});
