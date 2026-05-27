// ---------------------------------------------------------------------------
// Panel 类 — 一个完整的微型 IDE 单元
//
//   Panel = Storage + Compiler + Emulator + EditorManager + DOM
//
// 每个 Panel 持有独立的：文件仓库、编译器、模拟器、编辑器管理器和 UI
// 多个 Panel 可以并列运行，互不干扰
// ---------------------------------------------------------------------------

import { Storage } from './storage.js';
import { Compiler } from './compiler.js';
import { Emulator } from './emulator.js';
import { TextEditor } from './text-editor.js';
import { GfxEditor } from './gfx-editor.js';
import { EditorManager } from './editors.js';

export class Panel {
  /**
   * @param {object} opts
   * @param {string} opts.id                  Panel 唯一 ID
   * @param {string} opts.containerId         面板挂载的 DOM 容器 ID
   * @param {string} opts.aceDivId           Ace 编辑器挂载的 div ID
   * @param {string} opts.gfxParentDivId     瓦片编辑器父容器 ID
   * @param {string} opts.gfxTilesCanvasId   瓦片列表 canvas ID
   * @param {string} opts.gfxDrawCanvasId    瓦片绘制 canvas ID
   * @param {string} opts.gfxPaletteCanvasId 调色板 canvas ID
   * @param {string} opts.emulatorCanvasId   模拟器 canvas ID
   * @param {string} opts.fileListId         文件列表元素 ID
   * @param {string} opts.outputLogId        输出日志元素 ID
   * @param {string} opts.statusBarId        状态栏元素 ID
   * @param {object} opts.cpuDom             CPU 寄存器 DOM 引用集合
   * @param {Function} opts.onActivate       面板被激活时的回调
   */
  constructor(opts = {}) {
    this.id = opts.id || 'panel_default';
    /** 用户自定义标签名（null = 自动生成） */
    this.customName = null;
    this.onActivate = opts.onActivate || (() => {});

    // ── 核心模块（每 Panel 独立） ──
    this.storage  = new Storage();
    this.compiler = new Compiler({ storage: this.storage });
    this.emulator = new Emulator();

    // ── 编辑器 — 可由外部注入共享实例，也可内部创建 ──
    this._ownsEditors = false; // 是否自己创建的编辑器实例
    this.gfxEditor = null;
    this.textEditor = null;
    this.editorManager = null;

    /** 编辑器创建参数（注入共享编辑器后会清除） */
    this._editorOpts = opts;

    // 如果没有注入编辑器，则创建私有实例
    if (!opts._sharedEditors) {
      this._createEditors(opts);
    } else {
      // 使用共享编辑器（由 PanelManager 注入）
      this._sharedEditors = opts._sharedEditors;
      this._ownsEditors = false;
    }

    // ── 编译器日志 ──
    this.compiler.setLogCallback((str, kind) => {
      this._appendLog(str, kind);
    });

    // ── 模拟器串口 ──
    this.emulator.setSerialCallback((value) => {
      this._appendLog(String.fromCharCode(value), 'serial');
    });

    // ── 模拟器启动标志 ──
    /** @type {number|null} ROM 入口地址 */
    this.startAddress = null;

    /** @type {Object<number, [string, number]>} 地址到行的映射 */
    this.addrToLine = {};

    // ── DOM 引用 ──
    this.containerEl = document.getElementById(opts.containerId);
    this.fileListEl  = document.getElementById(opts.fileListId);
    this.outputLogEl = document.getElementById(opts.outputLogId);
    this.statusBarEl = document.getElementById(opts.statusBarId);
    this.emuCanvasEl = document.getElementById(opts.emulatorCanvasId ?? 'emulator_screen_canvas');

    /** @type {object} CPU 寄存器 DOM */
    this.cpuDom = opts.cpuDom || {};

    /** 编辑器状态快照（用于 Tab 切换时保存/恢复） */
    this._savedCurrentFile = '';
    this._savedCursorPos = {};
    this._savedBreakpoints = [];
    this._savedCpuLine = [null, null];
  }

  /** 创建编辑器实例（仅在首个 Panel 调用） */
  _createEditors(opts) {
    this._ownsEditors = true;

    this.gfxEditor = new GfxEditor({
      parentDivId: opts.gfxParentDivId,
      tilesCanvasId: opts.gfxTilesCanvasId,
      drawCanvasId: opts.gfxDrawCanvasId,
      paletteCanvasId: opts.gfxPaletteCanvasId,
      storage: this.storage,
      onFileChange: () => {
        this.compiler.compile(() => {});
      },
    });

    this.textEditor = new TextEditor({
      divId: opts.aceDivId,
      storage: this.storage,
      compiler: this.compiler,
      compileCallback: () => {
        this.compiler.compile((rom, startAddr, addrToLine) => {
          if (rom) this._bootEmulator(rom, startAddr);
        });
      },
      onBreakpointChange: () => {
        this._updateBreakpoints();
      },
    });

    this.editorManager = new EditorManager({
      textEditor: this.textEditor,
      gfxEditor: this.gfxEditor,
      storage: this.storage,
    });
  }

  /**
   * 绑定共享编辑器实例（Tab 切换时调用）
   * @param {object} editors { textEditor, gfxEditor, editorManager }
   */
  bindEditors(editors) {
    this.textEditor = editors.textEditor;
    this.gfxEditor = editors.gfxEditor;
    this.editorManager = editors.editorManager;

    // 更新编辑器的 storage / compiler 引用
    this.textEditor.storage = this.storage;
    this.textEditor.compiler = this.compiler;
    this.gfxEditor.storage = this.storage;
    this.editorManager.storage = this.storage;
    this.editorManager.textEditor = this.textEditor;
    this.editorManager.gfxEditor = this.gfxEditor;

    // 重新绑定 compileCallback（因为旧 Panel 的回调已失效）
    const origCallback = this.textEditor.compileCallback;
    this.textEditor.compileCallback = () => {
      this.compiler.compile((rom, startAddr, addrToLine) => {
        if (rom) this._bootEmulator(rom, startAddr);
      });
    };

    // 重新绑定断点回调
    this.textEditor.onBreakpointChange = () => {
      this._updateBreakpoints();
    };
  }

  /** 保存当前编辑器状态到 Panel */
  saveEditorState() {
    if (!this.textEditor) return;
    this._savedCurrentFile = this.textEditor.currentFile;
    if (this.textEditor.currentFile != null) {
      this._savedCursorPos = { ...this.textEditor.cursorPositionPerFile };
    }
    this._savedBreakpoints = this.textEditor.breakpoints.map(b => [...b]);
    this._savedCpuLine = [this.textEditor.cpuLineFilename, this.textEditor.cpuLineNr];
  }

  /** 从 Panel 恢复编辑器状态 */
  restoreEditorState() {
    if (!this.textEditor) return;
    this.textEditor.breakpoints = this._savedBreakpoints.map(b => [...b]);
    this.textEditor.cursorPositionPerFile = { ...this._savedCursorPos };
    this.textEditor.cpuLineFilename = this._savedCpuLine[0];
    this.textEditor.cpuLineNr = this._savedCpuLine[1];
    this.textEditor._renderBreakpoints();
  }

  // =======================================================================
  // 文件管理
  // =======================================================================

  addFile(name, content, base) {
    this.storage.add(name, content, base);
    this.refreshFileList();
  }

  removeFile(name) {
    this.storage.remove(name);
    this.refreshFileList();
  }

  renameFile(oldName, newName) {
    this.storage.rename(oldName, newName);
    this.refreshFileList();
  }

  getFileCount() {
    return Object.keys(this.storage.files).length;
  }

  refreshFileList() {
    if (!this.fileListEl) return;
    this.fileListEl.innerHTML = '';
    const names = Object.keys(this.storage.files);
    names.sort();
    const self = this;
    for (const name of names) {
      const btn = document.createElement('button');
      btn.textContent = name;
      const type = this.editorManager.getFileType(name);
      btn.className = 'fileListItem';
      if (type !== 'text') btn.className += ' binary';
      btn.addEventListener('click', () => {
        self.editorManager.setCurrentFile(name);
        self._markActiveFileListItem(btn);
      });
      this.fileListEl.appendChild(btn);
    }
  }

  _markActiveFileListItem(btn) {
    if (!this.fileListEl) return;
    const prev = this.fileListEl.querySelector('.fileListItem.active');
    if (prev) prev.classList.remove('active');
    if (btn) btn.classList.add('active');
  }

  // =======================================================================
  // 编译
  // =======================================================================

  compile(entryAsm) {
    this.compiler.compile((rom, startAddr, addrToLine) => {
      if (rom) {
        this.startAddress = startAddr;
        this.addrToLine  = addrToLine;
        this._bootEmulator(rom, startAddr);
      }
      this.textEditor.updateErrors();
    }, entryAsm);
  }

  // =======================================================================
  // 模拟器
  // =======================================================================

  _bootEmulator(rom, startAddr) {
    this.emulator.init(this.emuCanvasEl, rom);
    this.emulator.setPC(startAddr ?? 0x100);
    this._updateBreakpoints();
  }

  destroyEmulator() {
    this.emulator.destroy();
  }

  stepEmulator(stepType) {
    if (!this.emulator.isAvailable()) {
      this.compile();
      return;
    }
    const hit = this.emulator.step(stepType);
    this._updateCpuState(stepType === 'single' || stepType === 'frame');
    return hit;
  }

  _updateBreakpoints() {
    if (!this.emulator.isAvailable()) return;
    this.emulator.clearBreakpoints();
    for (const [filename, lineNr] of this.textEditor.getBreakpoints()) {
      const entry = this.addrToLine;
      for (const addrStr in entry) {
        const addr = parseInt(addrStr);
        const [fn, ln] = entry[addrStr];
        if (fn === filename && ln === lineNr) {
          this.emulator.setBreakpoint(addr);
        }
      }
    }
  }

  _updateCpuState(afterSingleStep) {
    this.emulator.renderScreen();
    const pc = this.emulator.getPC();

    if (this.cpuDom.pc)        this.cpuDom.pc.innerText      = this._toHex(pc, 4);
    if (this.cpuDom.sp)        this.cpuDom.sp.innerText       = this._toHex(this.emulator.getSP(), 4);
    if (this.cpuDom.a)         this.cpuDom.a.innerText        = this._toHex(this.emulator.getA(), 2);
    if (this.cpuDom.bc)        this.cpuDom.bc.innerText       = this._toHex(this.emulator.getBC(), 4);
    if (this.cpuDom.de)        this.cpuDom.de.innerText       = this._toHex(this.emulator.getDE(), 4);
    if (this.cpuDom.hl)        this.cpuDom.hl.innerText       = this._toHex(this.emulator.getHL(), 4);
    if (this.cpuDom.flags)     this.cpuDom.flags.innerText    = this.emulator.getFlags();

    if (afterSingleStep) {
      const info = this.addrToLine[pc];
      if (info) {
        this.textEditor.setCpuLine(info[0], info[1], true);
      }
    }
  }

  // =======================================================================
  // 键盘输入路由（每个 Panel 独立处理）
  // =======================================================================

  handleKeyDown(code) {
    if (!this.emulator.isAvailable()) return false;
    let consumed = true;
    if (code === 'ArrowRight')  this.emulator.setKeyPad('right', true);
    else if (code === 'ArrowLeft')   this.emulator.setKeyPad('left', true);
    else if (code === 'ArrowUp')     this.emulator.setKeyPad('up', true);
    else if (code === 'ArrowDown')   this.emulator.setKeyPad('down', true);
    else if (code === 'KeyS')        this.emulator.setKeyPad('a', true);
    else if (code === 'KeyA')        this.emulator.setKeyPad('b', true);
    else if (code === 'ShiftRight')  this.emulator.setKeyPad('select', true);
    else if (code === 'Enter')       this.emulator.setKeyPad('start', true);
    else consumed = false;
    return consumed;
  }

  handleKeyUp(code) {
    if (!this.emulator.isAvailable()) return false;
    let consumed = true;
    if (code === 'ArrowRight')  this.emulator.setKeyPad('right', false);
    else if (code === 'ArrowLeft')   this.emulator.setKeyPad('left', false);
    else if (code === 'ArrowUp')     this.emulator.setKeyPad('up', false);
    else if (code === 'ArrowDown')   this.emulator.setKeyPad('down', false);
    else if (code === 'KeyS')        this.emulator.setKeyPad('a', false);
    else if (code === 'KeyA')        this.emulator.setKeyPad('b', false);
    else if (code === 'ShiftRight')  this.emulator.setKeyPad('select', false);
    else if (code === 'Enter')       this.emulator.setKeyPad('start', false);
    else consumed = false;
    return consumed;
  }

  // =======================================================================
  // 日志
  // =======================================================================

  _appendLog(str, kind) {
    if (!this.outputLogEl) return;

    // null = 清空
    if (str == null) {
      this.outputLogEl.innerHTML = '';
      return;
    }

    const max = 256;
    while (this.outputLogEl.childElementCount >= max) {
      this.outputLogEl.removeChild(this.outputLogEl.firstChild);
    }

    // ANSI 着色 (仅 stdout)
    if (kind === 'stdout') str = this._ansiColors(str);

    const node = (kind === 'stderr' || kind === 'serial')
      ? document.createElement('span')
      : document.createTextNode(str);

    if (kind === 'stderr') {
      node.style.color = '#f77';
      node.innerText = str;
    } else if (kind === 'serial') {
      node.style.color = '#afa';
      node.innerText = str;
    }
    this.outputLogEl.appendChild(node);
    this.outputLogEl.scrollTop = this.outputLogEl.scrollHeight;
  }

  _ansiColors(text) {
    return text
      .replace(/\x1B\[31m/g, '<span style="color:red">')
      .replace(/\x1B\[32m/g, '<span style="color:green">')
      .replace(/\x1B\[33m/g, '<span style="color:yellow">')
      .replace(/\x1B\[0m/g, '</span>');
  }

  // ---- 工具方法 ----

  _toHex(v, d) {
    return v.toString(16).toUpperCase().padStart(d, '0');
  }

  // =======================================================================
  // 生命周期
  // =======================================================================

  activate() {
    this.onActivate();
  }

  destroy() {
    this.emulator.destroy();
    // 其他清理工作...
  }
}

// ---------------------------------------------------------------------------
// PanelManager — 管理所有 Panel 实例
// ---------------------------------------------------------------------------

export class PanelManager {
  constructor() {
    /** @type {Panel[]} */
    this.panels = [];
    /** @type {Panel|null} */
    this.activePanel = null;
  }

  addPanel(panel) {
    this.panels.push(panel);
    if (!this.activePanel) this.activePanel = panel;
  }

  removePanel(panel) {
    const idx = this.panels.indexOf(panel);
    if (idx > -1) {
      panel.destroy();
      this.panels.splice(idx, 1);
    }
    if (this.activePanel === panel) {
      this.activePanel = this.panels[0] || null;
    }
  }

  getActivePanel() {
    return this.activePanel;
  }

  setActivePanel(panel) {
    this.activePanel = panel;
    panel.activate();
  }
}

// 全局单例 PanelManager
export const panelManager = new PanelManager();