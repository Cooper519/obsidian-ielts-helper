import { Modal, type App } from "obsidian";
/** 所有破坏性动作均有单次确认；关闭弹窗等同取消。 */
export class ConfirmModal extends Modal {
  private accepted = false;
  constructor(
    app: App,
    private title: string,
    private message: string,
    private resolve: (accepted: boolean) => void,
  ) {
    super(app);
  }
  onOpen() {
    this.contentEl.addClass("ielts-helper-modal");
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: "ielts-helper-toolbar" });
    buttons.createEl("button", { text: "取消" }).onclick = () => this.close();
    buttons.createEl("button", { text: "确认继续", cls: "mod-cta" }).onclick =
      () => {
        this.accepted = true;
        this.close();
      };
  }
  onClose() {
    this.contentEl.empty();
    this.resolve(this.accepted);
  }
  static ask(app: App, title: string, message: string): Promise<boolean> {
    return new Promise((resolve) =>
      new ConfirmModal(app, title, message, resolve).open(),
    );
  }
}
