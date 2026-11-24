// 仅用于浏览器视觉夹具的最小宿主适配，不进入插件构建。
function enhance() {
  const proto = HTMLElement.prototype as any;
  proto.empty = function () {
    this.replaceChildren();
  };
  proto.addClass = function (name: string) {
    this.classList.add(name);
  };
  proto.setText = function (text: string) {
    this.textContent = text;
  };
  proto.createEl = function (tag: string, options: any = {}) {
    const e = document.createElement(tag);
    if (options.text) e.textContent = options.text;
    if (options.cls) e.className = options.cls;
    for (const [k, v] of Object.entries(options.attr || {}))
      e.setAttribute(k, String(v));
    this.append(e);
    return e;
  };
  proto.createDiv = function (options: any) {
    return this.createEl("div", options);
  };
}
enhance();
export class ItemView {
  app: any;
  contentEl: HTMLElement;
  constructor(leaf: any) {
    this.app = leaf.app;
    this.contentEl = leaf.contentEl;
  }
}
export class PluginSettingTab {
  containerEl: HTMLElement;
  constructor(
    public app: any,
    plugin: any,
  ) {
    this.containerEl = document.querySelector("#settings")!;
  }
}
export class Notice {
  constructor(text: string) {
    document.querySelector("#notice")!.textContent = text;
  }
}
export class Menu {
  items: { title?: string; fn?: () => void }[] = [];
  addItem(fn: any) {
    const item: any = {
      setTitle: (title: string) => {
        item.title = title;
        return item;
      },
      onClick: (f: any) => {
        item.fn = f;
        return item;
      },
    };
    fn(item);
    this.items.push(item);
    return this;
  }
  showAtMouseEvent() {
    for (const item of this.items) {
      const b = document.createElement("button");
      b.textContent = item.title!;
      b.onclick = item.fn!;
      document.querySelector("#notice")!.append(b);
    }
  }
}
export class Setting {
  settingEl: HTMLElement;
  controlEl: HTMLElement;
  descEl: HTMLElement;
  constructor(root: HTMLElement) {
    const row = document.createElement("div");
    this.settingEl = row;
    row.className = "setting-item";
    root.append(row);
    const info = document.createElement("div");
    info.className = "setting-item-info";
    row.append(info);
    this.info = info;
    this.descEl = document.createElement("p");
    this.controlEl = document.createElement("div");
    this.controlEl.className = "setting-item-control";
    row.append(this.controlEl);
  }
  private info: HTMLElement;
  setName(text: string) {
    const e = document.createElement("strong");
    e.textContent = text;
    this.info.append(e);
    return this;
  }
  setDesc(text: string) {
    this.descEl.textContent = text;
    this.info.append(this.descEl);
    return this;
  }
  addButton(fn: any) {
    const e = document.createElement("button");
    this.controlEl.append(e);
    const b: any = {
      setButtonText: (t: string) => {
        e.textContent = t;
        return b;
      },
      setDisabled: (v: boolean) => {
        e.disabled = v;
        return b;
      },
      onClick: (f: any) => {
        e.onclick = f;
        return b;
      },
    };
    fn(b);
    return this;
  }
  addText(fn: any) {
    const e = document.createElement("input");
    this.controlEl.append(e);
    const t: any = {
      inputEl: e,
      setValue: (v: string) => {
        e.value = v;
        return t;
      },
      setPlaceholder: (v: string) => {
        e.placeholder = v;
        return t;
      },
      onChange: (f: any) => {
        e.oninput = () => f(e.value);
        return t;
      },
    };
    fn(t);
    return this;
  }
  addToggle(fn: any) {
    const e = document.createElement("input");
    e.type = "checkbox";
    this.controlEl.append(e);
    const t: any = {
      setValue: (v: boolean) => {
        e.checked = v;
        return t;
      },
      onChange: (f: any) => {
        e.onchange = () => f(e.checked);
        return t;
      },
    };
    fn(t);
    return this;
  }
  addDropdown(fn: any) {
    const e = document.createElement("select");
    this.controlEl.append(e);
    const t: any = {
      addOptions: (v: any) => {
        for (const [key, label] of Object.entries(v)) {
          const o = document.createElement("option");
          o.value = key;
          o.textContent = String(label);
          e.append(o);
        }
        return t;
      },
      setValue: (v: string) => {
        e.value = v;
        return t;
      },
      onChange: (f: any) => {
        e.onchange = () => f(e.value);
        return t;
      },
    };
    fn(t);
    return this;
  }
}
