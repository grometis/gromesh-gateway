import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";

describe("page content", () => {
  it("gives the page a single h1 and retains rich descriptions and actions", () => {
    const html = renderToStaticMarkup(<PageHeader title="Revisar e publicar" description={<>Comparar com <span className="mono">v3</span>.</>} actions={<button type="button">Publicar</button>} />);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain("<h1>Revisar e publicar</h1>");
    expect(html).toContain('<p class="lede">Comparar com <span class="mono">v3</span>.</p>');
    expect(html).toContain('<button type="button">Publicar</button>');
  });

  it("omits optional header content without adding empty layout slots", () => {
    const html = renderToStaticMarkup(<PageHeader title="Consumers" />);
    expect(html).toContain("<h1>Consumers</h1>");
    expect(html).not.toContain("<p");
    expect(html).not.toContain("<button");
  });

  it("identifies an empty state below the page heading and retains its explanation and action", () => {
    const html = renderToStaticMarkup(<EmptyState title="Nenhum service ainda." text="Crie o primeiro para começar a rotear tráfego." action={<button type="button">Novo service</button>} />);
    expect(html).toContain("<h2>Nenhum service ainda.</h2>");
    expect(html).toContain("<p>Crie o primeiro para começar a rotear tráfego.</p>");
    expect(html).toContain('<button type="button">Novo service</button>');
    expect(html).not.toContain("<h1");
  });

  it("supports compact empty states without an extra action or paragraph", () => {
    const html = renderToStaticMarkup(<EmptyState title="Nenhum cluster ainda." />);
    expect(html).toContain("<h2>Nenhum cluster ainda.</h2>");
    expect(html).not.toContain("<p");
    expect(html).not.toContain("<button");
  });
});
