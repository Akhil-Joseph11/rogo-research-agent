import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("renders headings, emphasis, lists, code and tables", () => {
    const html = render(
      [
        "## Globex margins",
        "",
        "Operating margin was **9.6%**, an *improvement*.",
        "",
        "- Revenue grew",
        "- Margins expanded",
        "",
        "1. First",
        "2. Second",
        "",
        "Use `getFinancials` here.",
        "",
        "| Company | FY2025 |",
        "| --- | --- |",
        "| Globex | 9.6% |",
      ].join("\n"),
    );

    expect(html).toContain("<h2>Globex margins</h2>");
    expect(html).toContain("<strong>9.6%</strong>");
    expect(html).toContain("<em>improvement</em>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>Margins expanded</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<code>getFinancials</code>");
    expect(html).toContain("<td>Globex</td>");
  });

  it("does not render raw HTML from the answer", () => {
    const html = render(
      'Before <script>alert("x")</script> <img src=x onerror="alert(1)"> <b>bold</b>\n\n<div onclick="steal()">block</div>',
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<div onclick");
  });

  it("strips unsafe link targets and opens safe links in a new tab without an opener", () => {
    const unsafe = render("[click](javascript:alert(1))");
    expect(unsafe).not.toContain("javascript:");

    const safe = render("[Filing](https://example.com/10-k)");
    expect(safe).toContain('href="https://example.com/10-k"');
    expect(safe).toContain('rel="noopener noreferrer"');
    expect(safe).toContain('target="_blank"');
  });
});
