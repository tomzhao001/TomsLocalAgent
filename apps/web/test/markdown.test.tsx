import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";

afterEach(cleanup);

describe("Markdown", () => {
  it("把标题、列表和加粗转成对应元素", () => {
    render(<Markdown text={"# 计划\n\n- 先写测试\n\n**加粗**"} />);
    expect(screen.getByRole("heading", { name: "计划" }).tagName).toBe("H1");
    expect(screen.getByRole("list").textContent).toContain("先写测试");
    expect(screen.getByText("加粗").tagName).toBe("STRONG");
  });

  it("链接在新标签打开，代码块可以横向滚动", () => {
    const { container } = render(<Markdown text={"[文档](https://example.com)\n\n```\nconst value = 1\n```"} />);
    const link = screen.getByRole("link", { name: "文档" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(container.querySelector("pre")?.className).toContain("overflow-x-auto");
  });
});
