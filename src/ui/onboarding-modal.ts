import { Modal, type App } from "obsidian";
import type IELTSPlugin from "../main";
import { HelperSettings } from "./settings-tab";
/** 首次启用自动呈现同一套初始化控件；失败保留当前弹窗内草稿供重试。 */
export class OnboardingModal extends Modal {
  private settings?: HelperSettings;
  constructor(
    app: App,
    private helper: IELTSPlugin,
  ) {
    super(app);
  }
  onOpen() {
    this.contentEl.addClass("ielts-helper-modal");
    this.settings = new HelperSettings(this.app, this.helper);
    this.settings.containerEl = this.contentEl;
    this.settings.display();
  }
  onClose() {
    this.settings?.hide();
    this.contentEl.empty();
  }
}
