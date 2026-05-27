import ace from './ace/loader.js';
import './ace/mode-sm83.js';

import { TokenTooltip } from './ace/sm83tooltip.js';
import { sm83Completer } from './ace/complete-sm83.js';

// ---------------------------------------------------------------------------
// 辅助：跟随系统暗色模式
// ---------------------------------------------------------------------------
const runColorMode = (editor) => {
  if (!window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (isDark) => {
    editor.setTheme(isDark ? 'ace/theme/tomorrow_night_eighties' : 'ace/theme/tomorrow');
  };
  apply(query.matches);
  query.addEventListener('change', (event) => apply(event.matches));
};

// ---------------------------------------------------------------------------
// TextEditor 类
// ---------------------------------------------------------------------------

export class TextEditor {
  /**
   * @param {object} opts
   * @param {string} opts.divId               Ace 挂载容器 ID
   * @param {import('./storage.js').Storage} opts.storage  文件仓库实例
   * @param {import('./compiler.js').Compiler} opts.compiler 编译器实例
   * @param {Function} opts.compileCallback   编辑后触发编译的回调
   * @param {Function} opts.onBreakpointChange 断点变更回调
   */
  constructor({ divId, storage, compiler, compileCallback, onBreakpointChange }) {
    this.storage = storage;
    this.compiler = compiler;
    this.compileCallback = compileCallback;
    this.onBreakpointChange = onBreakpointChange || (() => {});

    /** @type {Array<[string, number]>} [filename, lineNr] */
    this.breakpoints = [];

    /** @type {Object<string, any>} 每文件光标位置 */
    this.cursorPositionPerFile = {};

    this.currentFile = null;
    this.cpuLineFilename = null;
    this.cpuLineNr = null;
    this.cpuLineMarker = null;

    // 创建 Ace 编辑器
    ace.config.set('basePath', 'assets/ace');

    const e = ace.edit(divId);
    new TokenTooltip(e);
    runColorMode(e);
    e.session.setMode('ace/mode/sm83');
    e.setOptions({
      tabSize: 2,
      useSoftTabs: true,
      navigateWithinSoftTabs: true,
      enableBasicAutocompletion: true,
      enableLiveAutocompletion: true,
      enableSnippets: true,
    });
    ace.require('ace/ext/language_tools').addCompleter(sm83Completer);

    const self = this;
    e.session.on('change', function (delta) {
      if (e.curOp && e.curOp.command.name) {
        self.storage.update(self.currentFile, e.getValue());
        self.compileCallback();
      }
    });
    e.on('guttermousedown', function (event) {
      const target = event.domEvent.target;
      if (target.className.indexOf('ace_gutter-cell') === -1) return;
      const row = event.getDocumentPosition().row;
      self._toggleBreakpoint(self.currentFile, row + 1);
      event.stop();
    });

    this._setupFontSize(e);
    this._setupViewMenu();

    this.editor = e;
  }

  // ---- 文件切换 ----

  setCurrentFile(filename) {
    if (this.currentFile != null) {
      this.cursorPositionPerFile[this.currentFile] = this.editor.selection.getCursor();
    }
    this.currentFile = filename;
    this.editor.setValue(this.storage.getFiles()[filename]);
    this.editor.selection.clearSelection();
    this.editor.session.getUndoManager().reset();
    const pos = this.cursorPositionPerFile[filename];
    if (pos) this.editor.selection.moveCursorToPosition(pos);
    else this.editor.selection.moveCursorTo(0, 0);
    this.editor.scrollToLine(this.editor.selection.getCursor().row, true);
    this.editor.focus();
    this.updateErrors();
    this._updateCpuLine();
  }

  // ---- 错误标注 ----

  updateErrors() {
    const annotations = [];
    for (const [type, filename, lineNr, message] of this.compiler.getErrors()) {
      if (filename !== this.currentFile) continue;
      annotations.push({ row: lineNr - 1, column: 0, type, text: message });
    }
    this.editor.session.setAnnotations(annotations);
  }

  // ---- CPU 调试行 ----

  setCpuLine(filename, lineNr, scrollToLine) {
    this.cpuLineFilename = filename;
    this.cpuLineNr = lineNr;
    this._updateCpuLine(scrollToLine);
  }

  _updateCpuLine(scrollToLine) {
    if (scrollToLine && this.currentFile != null && this.currentFile !== this.cpuLineFilename) {
      this.setCurrentFile(this.cpuLineFilename);
    }

    if (this.cpuLineMarker != null) {
      this.editor.session.removeMarker(this.cpuLineMarker);
      this.cpuLineMarker = null;
    }

    if (this.cpuLineFilename === this.currentFile) {
      this.cpuLineMarker = this.editor.session.addMarker(
        new ace.Range(this.cpuLineNr - 1, 0, this.cpuLineNr - 1, 1),
        'cpuLineMarker',
        'fullLine',
      );
      if (scrollToLine) this.editor.scrollToLine(this.cpuLineNr - 1, true, false, () => {});
    }
  }

  // ---- 断点 ----

  getBreakpoints() {
    return this.breakpoints.map(([fn, ln]) => [fn, ln, true]);
  }

  _addBreakpoint(filename, lineNr) {
    this.breakpoints.push([filename, lineNr]);
    this.onBreakpointChange();
    this._renderBreakpoints();
  }

  _removeBreakpoint(filename, lineNr) {
    this.breakpoints = this.breakpoints.filter((d) => d[0] !== filename || d[1] !== lineNr);
    this.onBreakpointChange();
    this._renderBreakpoints();
  }

  _toggleBreakpoint(filename, lineNr) {
    const idx = this.breakpoints.findIndex((d) => d[0] === filename && d[1] === lineNr);
    if (idx > -1) this._removeBreakpoint(filename, lineNr);
    else this._addBreakpoint(filename, lineNr);
  }

  _renderBreakpoints() {
    this.editor.session.clearBreakpoints();
    for (const [filename, lineNr] of this.breakpoints) {
      if (filename === this.currentFile) {
        this.editor.session.setBreakpoint(lineNr - 1, 'ace_breakpoint');
      }
    }
  }

  // ---- 显隐 ----

  hide() {
    this.editor.renderer.getContainerElement().style.display = 'none';
  }

  show() {
    this.editor.renderer.getContainerElement().style.display = '';
    this.editor.resize();
    this.editor.renderer.updateFull();
  }

  // ---- 字体大小控制 ----

  _setupFontSize(e) {
    const DEFAULT = 14;
    const MIN = 8;
    const MAX = 32;
    const KEY = 'aceFontSize';

    let currentSize = parseInt(localStorage.getItem(KEY)) || DEFAULT;
    e.setFontSize(currentSize + 'px');

    const apply = (size) => {
      e.setFontSize(size + 'px');
      const display = document.getElementById('view_font_size_display');
      if (display) display.textContent = size;
    };

    window.changeEditorFontSize = (delta) => {
      const ns = currentSize + delta;
      if (ns < MIN || ns > MAX) return;
      currentSize = ns;
      apply(currentSize);
      localStorage.setItem(KEY, currentSize);
    };

    apply(currentSize);

    e.commands.addCommand({
      name: 'increaseFontSize',
      bindKey: { win: 'Ctrl-=', mac: 'Command-=' },
      exec: () => window.changeEditorFontSize(1),
    });
    e.commands.addCommand({
      name: 'decreaseFontSize',
      bindKey: { win: 'Ctrl--', mac: 'Command--' },
      exec: () => window.changeEditorFontSize(-1),
    });
    e.commands.addCommand({
      name: 'resetFontSize',
      bindKey: { win: 'Ctrl-0', mac: 'Command-0' },
      exec: () => { currentSize = DEFAULT; apply(currentSize); localStorage.setItem(KEY, currentSize); },
    });
  }

  _setupViewMenu() {
    const decr = document.getElementById('view_font_decrease');
    const incr = document.getElementById('view_font_increase');
    if (decr) decr.addEventListener('click', () => window.changeEditorFontSize(-1));
    if (incr) incr.addEventListener('click', () => window.changeEditorFontSize(1));

    const cb = document.getElementById('view_insert_match_only');
    if (cb) {
      cb.checked = localStorage.getItem('insertMatchOnly') === 'true';
      cb.addEventListener('change', () => {
        localStorage.setItem('insertMatchOnly', cb.checked);
        window._insertMatchOnly = cb.checked;
      });
      window._insertMatchOnly = cb.checked;
    }
  }
}

// ---------------------------------------------------------------------------
// 向后兼容：模块级导出
// 这些模块级函数需要一个"注册过的"全局单例来代理。
// 默认情况下由 main.js 调用 register() 后设置，这里先留空。
// ---------------------------------------------------------------------------

let _defaultInstance = null;

export function setDefaultInstance(inst) { _defaultInstance = inst; }
export function getCurrentFilename()  { return _defaultInstance ? _defaultInstance.currentFile : null; }
export function getBreakpoints()      { return _defaultInstance ? _defaultInstance.getBreakpoints() : []; }
export function setCurrentFile(fn)    { if (_defaultInstance) _defaultInstance.setCurrentFile(fn); }
export function updateErrors()        { if (_defaultInstance) _defaultInstance.updateErrors(); }
export function setCpuLine(fn, ln, s) { if (_defaultInstance) _defaultInstance.setCpuLine(fn, ln, s); }
export function hide()                { if (_defaultInstance) _defaultInstance.hide(); }
export function show()                { if (_defaultInstance) _defaultInstance.show(); }
export function getInstance()         { return _defaultInstance; }