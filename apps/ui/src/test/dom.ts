import { vi } from "vitest";

/** The Node suite has no browser DOM dependency; this host lets tests exercise React state and events. */
export class TestNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly childNodes: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  parentNode: TestNode | null = null;
  value = "";
  get type() { return this.getAttribute("type") ?? "text"; }
  set type(value: string) { this.setAttribute("type", value); }
  defaultValue = "";
  checked = false;
  disabled = false;
  selected = false;
  multiple = false;
  private content = "";

  constructor(readonly ownerDocument: TestDocument, name: string, nodeType = 1) {
    this.nodeType = nodeType;
    this.nodeName = nodeType === 1 ? name.toUpperCase() : name;
    this.tagName = this.nodeName;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get options(): TestNode[] { return this.findAll((node) => node.tagName === "OPTION"); }
  get textContent(): string { return this.content + this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value: string) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes.length = 0;
    this.content = String(value);
  }
  get nodeValue() { return this.content; }
  set nodeValue(value: string) { this.content = value; }
  appendChild(node: TestNode) { return this.insertBefore(node, null); }
  insertBefore(node: TestNode, before: TestNode | null) {
    node.parentNode?.removeChild(node);
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: EventListenerOrEventListenerObject) { this.listeners.get(name)?.delete(listener); }
  dispatchEvent(event: Event) {
    Object.defineProperty(event, "target", { configurable: true, value: this });
    for (let node: TestNode | null = this; node; node = node.parentNode) {
      for (const listener of node.listeners.get(event.type) ?? []) {
        if (typeof listener === "function") listener.call(node as unknown as EventTarget, event);
        else listener.handleEvent(event);
      }
      if (!event.bubbles || event.cancelBubble) break;
    }
    return !event.defaultPrevented;
  }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node: TestNode): boolean { return node === this || this.childNodes.some((child) => child.contains(node)); }
  findAll(predicate: (node: TestNode) => boolean): TestNode[] {
    return this.childNodes.flatMap((node) => [...(predicate(node) ? [node] : []), ...node.findAll(predicate)]);
  }
}

class TestDocument extends TestNode {
  oninput = null;
  activeElement: TestNode | null = null;
  readonly documentElement: TestNode;
  readonly body: TestNode;
  readonly defaultView = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, location: { protocol: "https:" } });
  constructor() {
    // React only reads ownerDocument on elements, never on the document itself.
    super(null as unknown as TestDocument, "#document", 9);
    this.documentElement = this.appendChild(this.createElement("html"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(name: string) { return new TestNode(this, name); }
  createElementNS(_namespace: string, name: string) { return this.createElement(name); }
  createTextNode(text: string) {
    const node = new TestNode(this, "#text", 3);
    node.textContent = text;
    return node;
  }
}

export function installTestDom() {
  const document = new TestDocument();
  Object.assign(document.defaultView, { document });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document.body.appendChild(document.createElement("div"));
}
