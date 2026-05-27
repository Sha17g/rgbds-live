import JSZip from 'jszip';
import LZString from 'lz-string';

import HARDWARE_INC from '../hardware.inc/hardware.inc?raw';
import HARDWARE_COMPAT_INC from '../hardware.inc/hardware_compat.inc?raw';
import MAIN_ASM from '../starting_project/main.asm?raw';

export const config = {
  autoUrl: false,
  autoLocalStorage: false,
};

const HARDWARE_FILES = {
  'hardware.inc': HARDWARE_INC,
  'hardware_compat.inc': HARDWARE_COMPAT_INC,
};

const DEFAULT_FILES = {
  ...HARDWARE_FILES,
  'main.asm': MAIN_ASM,
};

export class Storage {
  /** @type {Object<string, string|Uint8Array>} */
  files;

  /** @type {Function|null} 加载完成后更新 UI 的回调 */
  onUIUpdate = null;

  constructor() {
    this.reset();
  }

  reset() {
    this.files = { ...DEFAULT_FILES };
  }

  getFiles() {
    return this.files;
  }

  setOnUIUpdate(fn) {
    this.onUIUpdate = fn;
  }

  autoLoad() {
    if (location.hash.length > 1) {
      if (location.hash.startsWith('#https://gist.github.com/')) {
        this.loadGithubGist(location.hash.slice(1));
        location.hash = '';
      } else if (location.hash.startsWith('#http://') || location.hash.startsWith('#https://')) {
        this.loadSingleUrl(location.hash.slice(1));
        location.hash = '';
      } else {
        this.loadUrlHash();
        config.autoUrl = true;
      }
    } else if ('rgbds_storage' in localStorage) {
      this.files = { ...HARDWARE_FILES };
      for (const [filename, data] of Object.entries(JSON.parse(localStorage['rgbds_storage']))) {
        if (data instanceof Object) data = Uint8Array.from(Object.values(data));
        this.files[filename] = data;
      }
      config.autoLocalStorage = true;
    }
  }

  update(name, code) {
    if (typeof name !== 'undefined') {
      if (code instanceof ArrayBuffer) code = new Uint8Array(code);
      if (code === null) delete this.files[name];
      else this.files[name] = code;
    }

    if (config.autoUrl) document.location.hash = new URL(this.getHashUrl()).hash;
    if (config.autoLocalStorage) localStorage['rgbds_storage'] = JSON.stringify(this.files);
  }

  loadUrlHash() {
    const all_code = LZString.decompressFromEncodedURIComponent(location.hash.slice(1));
    if (all_code == null) return false;

    if (all_code.indexOf('\0') < 0) {
      this.files['main.asm'] = all_code;
      return true;
    }
    const parts = all_code.split('\0');
    this.files = { ...HARDWARE_FILES };
    for (let idx = 0; idx < parts.length - 1; idx += 2) {
      this.files[parts[idx]] = parts[idx + 1];
    }
    return true;
  }

  getHashUrl() {
    let all_code = '';
    for (const [name, data] of Object.entries(this.files)) {
      if (name === 'hardware.inc' && data === HARDWARE_INC) continue;
      all_code += name + '\0' + data + '\0';
    }
    const url = new URL(document.location);
    url.hash = LZString.compressToEncodedURIComponent(all_code);
    if (url.hash.length > 1024 * 2) return 'Sorry, code too large for direct URL generation';
    return url.toString();
  }

  loadGithubGist(url) {
    const gist_id = urlToGistID(url);
    if (gist_id == null) return;

    const req = new XMLHttpRequest();
    req.open('GET', 'https://api.github.com/gists/' + gist_id, false);
    req.send();

    const result = JSON.parse(req.responseText);
    this.files = { ...HARDWARE_FILES };
    for (const [name, data] of Object.entries(result.files)) {
      this.files[name] = data.content;
    }
    this.postLoadUIUpdate();
  }

  saveGithubGist(username, token, url) {
    const file_data = {};
    for (const [name, data] of Object.entries(this.files)) file_data[name] = { content: data };

    if (url === '') {
      const req = new XMLHttpRequest();
      req.open('POST', 'https://api.github.com/gists', false);
      req.setRequestHeader('Authorization', 'Basic ' + btoa(username + ':' + token));
      req.send(JSON.stringify({ files: file_data }));
      if (req.status >= 400) {
        return null;
      }
      return JSON.parse(req.response).html_url;
    }

    const gist_id = urlToGistID(url);
    if (gist_id == null) return null;

    const req = new XMLHttpRequest();
    req.open('PATCH', 'https://api.github.com/gists/' + gist_id, false);
    req.setRequestHeader('Authorization', 'Basic ' + btoa(username + ':' + token));
    req.send(JSON.stringify({ files: file_data }));
    if (req.status >= 400) {
      return null;
    }
    return url;
  }

  downloadZip() {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(this.files)) zip.file(name, data);
    zip.generateAsync({ type: 'blob' }).then((blob) => {
      const element = document.createElement('a');
      const url = window.URL.createObjectURL(blob, {
        type: 'application/octet-stream',
      });
      element.setAttribute('href', url);
      element.setAttribute('download', 'source.zip');

      element.style.display = 'none';
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
      window.URL.revokeObjectURL(url);
    });
  }

  loadZip(file) {
    this.files = { ...HARDWARE_FILES };
    JSZip.loadAsync(file).then((zip) => {
      const entries = Object.values(zip.files);
      const loadNextFile = () => {
        if (entries.length < 1) return;
        const entry = entries.pop();
        const type = editors_getFileType(entry.name) === 'text' ? 'string' : 'uint8array';
        entry.async(type).then((contents) => {
          this.files[entry.name] = contents;
          loadNextFile();
          this.postLoadUIUpdate();
        });
      };
      loadNextFile();
    });
  }

  loadSingleUrl(url) {
    this.files = { ...HARDWARE_FILES };
    const req = new XMLHttpRequest();
    req.open('GET', url, false);
    req.send();
    this.files['main.asm'] = req.response;
    this.postLoadUIUpdate();
  }

  postLoadUIUpdate() {
    if (this.onUIUpdate) this.onUIUpdate(this);
  }
}

function urlToGistID(url) {
  const m = /https:\/\/gist\.github\.com\/\w+\/(\w+)/.exec(url);
  if (m) return m[1];
  return null;
}

// ---------------------------------------------------------------------------
// 向后兼容：模块级导出（单例 + 方法代理）
// Storage 的 loadZip 中需要用到 editors.getFileType，这里通过一个可设置的
// 模块级函数来解决循环依赖问题。
// ---------------------------------------------------------------------------

/** @type {(name: string) => string} */
let editors_getFileType = (name) => {
  const idx = name.lastIndexOf('.');
  if (idx < 0) return 'binary';
  const ext = name.substr(idx + 1).toLowerCase();
  if (['inc', 'asm', 'z80', 'h', 'c', 'cpp', 'hpp', 'txt'].includes(ext)) return 'text';
  return 'binary';
};

export function setEditorsGetFileType(fn) {
  editors_getFileType = fn;
}

// 默认单例
const defaultInstance = new Storage();
let _defaultInstance = null;

function _inst() { return _defaultInstance || defaultInstance; }

export function setDefaultInstance(inst) { _defaultInstance = inst; }

export const reset = () => _inst().reset();
export const autoLoad = () => _inst().autoLoad();
export const getFiles = () => _inst().getFiles();
export const update = (name, code) => _inst().update(name, code);
export const getHashUrl = () => _inst().getHashUrl();
export const loadGithubGist = (url) => _inst().loadGithubGist(url);
export const saveGithubGist = (username, token, url) => _inst().saveGithubGist(username, token, url);
export const downloadZip = () => _inst().downloadZip();
export const loadZip = (file) => _inst().loadZip(file);
export const loadSingleUrl = (url) => _inst().loadSingleUrl(url);
export const loadUrlHash = () => _inst().loadUrlHash();
export const setOnUIUpdate = (fn) => { _inst().onUIUpdate = fn; };
export const getInstance = () => _inst();
