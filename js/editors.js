// ---------------------------------------------------------------------------
// EditorManager 类 — 统一管理 TextEditor / GfxEditor 切换和文件类型判定
// ---------------------------------------------------------------------------

export class EditorManager {
  /**
   * @param {object} opts
   * @param {import('./text-editor.js').TextEditor} opts.textEditor
   * @param {import('./gfx-editor.js').GfxEditor} opts.gfxEditor
   * @param {import('./storage.js').Storage} opts.storage
   */
  constructor({ textEditor, gfxEditor, storage }) {
    this.textEditor = textEditor;
    this.gfxEditor = gfxEditor;
    this.storage = storage;

    this.currentEditor = this._nullEditor();
    this.currentFilename = '';

    this.nullEditorDiv = document.getElementById('nullEditorDiv');
  }

  /** 空编辑器占位 */
  _nullEditor() {
    const self = this;
    return {
      hide() { if (self.nullEditorDiv) self.nullEditorDiv.style.display = 'none'; },
      show() { if (self.nullEditorDiv) self.nullEditorDiv.style.display = ''; },
      setCurrentFile() {},
    };
  }

  // ---- API ----

  getCurrentFilename() {
    return this.currentFilename;
  }

  setCurrentFile(filename) {
    this.currentFilename = filename;
    const prevEditor = this.currentEditor;

    if (typeof this.storage.getFiles()[filename] === 'string') {
      this.currentEditor = this.textEditor;
    } else {
      this.currentEditor = this.gfxEditor;
    }

    if (prevEditor !== this.currentEditor) {
      prevEditor.hide();
      this.currentEditor.show();
    }
    return this.currentEditor.setCurrentFile(filename);
  }

  getFileType(filename) {
    const idx = filename.lastIndexOf('.');
    if (idx < 0) return 'binary';
    const ext = filename.substr(idx + 1).toLowerCase();
    if (['inc', 'asm', 'z80', 'h', 'c', 'cpp', 'hpp', 'txt'].includes(ext)) return 'text';
    return 'binary';
  }
}

// ---------------------------------------------------------------------------
// 向后兼容：模块级导出（代理到默认单例）
// ---------------------------------------------------------------------------

let _defaultInstance = null;

export function setDefaultInstance(inst) { _defaultInstance = inst; }
export function getCurrentFilename()     { return _defaultInstance ? _defaultInstance.getCurrentFilename() : ''; }
export function setCurrentFile(fn)       { if (_defaultInstance) _defaultInstance.setCurrentFile(fn); }
export function getFileType(fn)          { return _defaultInstance ? _defaultInstance.getFileType(fn) : 'binary'; }
export function getInstance()            { return _defaultInstance; }