/**
 * 文件读取层：把 PDF / DOCX / TXT 简历转成纯文本。
 *
 * - DOCX：零依赖。docx 本质是 ZIP，用浏览器原生 DecompressionStream('deflate-raw') 解压，
 *         再从 word/document.xml 里抽文本。
 * - PDF ：使用 vendor/pdfjs 中的 pdf.js（主线程解析 + worker）。
 * - TXT/MD：直接读。
 */
(function () {
  if (window.__RJ_FILE_TEXT__) return;

  var MAX_BYTES = 20 * 1024 * 1024; // 20MB 上限

  // ---------------------------------------------------------------- 通用

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function decodeEntities(s) {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&amp;/g, '&');
  }

  // ------------------------------------------------------------- DOCX

  /** 在字节流尾部向前扫描 ZIP 的中央目录结束标记 (EOCD) */
  function findEOCD(view, len) {
    var min = Math.max(0, len - 22 - 65535);
    for (var i = len - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持 DecompressionStream，请升级 Chrome'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) {
      return new Uint8Array(ab);
    });
  }

  /** 从 ZIP 中取出指定条目的内容（支持 store / deflate） */
  function unzipEntry(buf, targetName) {
    var view = new DataView(buf);
    var eocd = findEOCD(view, buf.byteLength);
    if (eocd < 0) return Promise.reject(new Error('不是有效的 DOCX 文件（未找到 ZIP 结构）'));

    var count = view.getUint16(eocd + 10, true);
    var ptr = view.getUint32(eocd + 16, true);

    for (var i = 0; i < count; i++) {
      if (ptr + 46 > buf.byteLength || view.getUint32(ptr, true) !== 0x02014b50) break;

      var method = view.getUint16(ptr + 10, true);
      var compSize = view.getUint32(ptr + 20, true);
      var nameLen = view.getUint16(ptr + 28, true);
      var extraLen = view.getUint16(ptr + 30, true);
      var commentLen = view.getUint16(ptr + 32, true);
      var localOff = view.getUint32(ptr + 42, true);
      var name = decode(new Uint8Array(buf, ptr + 46, nameLen));

      if (name === targetName) {
        var lhNameLen = view.getUint16(localOff + 26, true);
        var lhExtraLen = view.getUint16(localOff + 28, true);
        var dataStart = localOff + 30 + lhNameLen + lhExtraLen;
        var raw = new Uint8Array(buf, dataStart, compSize);
        if (method === 0) return Promise.resolve(raw);
        if (method === 8) return inflateRaw(raw);
        return Promise.reject(new Error('不支持的压缩方式：' + method));
      }
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return Promise.resolve(null);
  }

  /** word/document.xml -> 纯文本（段落换行、制表符保留） */
  function docxXmlToText(xml) {
    var s = xml;
    s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
    s = s.replace(/<w:br\b[^>]*\/?>/g, '\n');
    s = s.replace(/<\/w:p>/g, '\n');
    s = s.replace(/<[^>]+>/g, '');       // 去掉所有标签（含 w:t 本身）
    s = decodeEntities(s);
    s = s.replace(/[ \t]+\n/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  function docxToText(buf) {
    return unzipEntry(buf, 'word/document.xml').then(function (entry) {
      if (!entry) throw new Error('DOCX 中未找到 word/document.xml');
      return docxXmlToText(decode(entry));
    });
  }

  // -------------------------------------------------------------- PDF

  /** 把 pdf.js 的 textContent.items 还原成带换行的文本 */
  function itemsToText(items) {
    var lines = [];
    var cur = null;

    items.forEach(function (it) {
      if (!it || typeof it.str !== 'string' || it.str === '') return;
      var x = it.transform ? it.transform[4] : 0;
      var y = it.transform ? Math.round(it.transform[5]) : 0;

      if (!cur || Math.abs(cur.y - y) > 3) {
        cur = { y: y, parts: [] };
        lines.push(cur);
      }
      cur.parts.push({ x: x, w: it.width || 0, s: it.str, eol: it.hasEOL });
    });

    return lines.map(function (l) {
      var parts = l.parts.slice().sort(function (a, b) { return a.x - b.x; });
      var s = '';
      var prevEnd = null;
      parts.forEach(function (p, i) {
        if (i > 0 && prevEnd != null && p.x - prevEnd > 1.2 && needSpace(s.slice(-1), p.s.charAt(0))) {
          s += ' ';
        }
        s += p.s;
        prevEnd = p.x + p.w;
      });
      return s.replace(/\s+$/, '');
    }).filter(function (x) { return x.trim() !== ''; }).join('\n');
  }

  /** 只在「拉丁字母/数字」相邻时补空格，避免把中文句子切碎 */
  function needSpace(prevCh, nextCh) {
    if (!prevCh || !nextCh) return false;
    return /[A-Za-z0-9%)\]}.,;:!?>]/.test(prevCh) && /[A-Za-z0-9(\[{]/.test(nextCh);
  }

  function pdfToText(buf) {
    var pdfjs = window.__RJ_PDF__;
    if (!pdfjs) return Promise.reject(new Error('PDF 解析库未加载完成，请稍后重试'));

    return pdfjs.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
      cMapPacked: true,
      isEvalSupported: false,   // MV3 的 CSP 禁止 eval，必须关掉
      disableFontFace: true,
      useSystemFonts: false
    }).promise.then(function (doc) {
      var out = [];
      var chain = Promise.resolve();
      var _loop = function (i) {
        chain = chain.then(function () {
          return doc.getPage(i).then(function (page) {
            return page.getTextContent().then(function (content) {
              out.push(itemsToText(content.items));
            });
          });
        });
      };
      for (var i = 1; i <= doc.numPages; i++) _loop(i);
      return chain.then(function () {
        return out.join('\n');
      });
    });
  }

  // ------------------------------------------------------------ 入口

  function sniff(buf, fileName) {
    var ext = (fileName || '').toLowerCase().split('.').pop();
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'txt' || ext === 'md' || ext === 'text') return 'text';

    var head = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
    var sig = String.fromCharCode.apply(null, head);
    if (sig.indexOf('%PDF') === 0) return 'pdf';
    if (head[0] === 0x50 && head[1] === 0x4b) return 'docx';
    return 'text';
  }

  /**
   * 读取简历文件并返回纯文本。
   * @param {File} file
   * @returns {Promise<{ text: string, kind: string, fileName: string, bytes: number }>}
   */
  function readAsText(file) {
    if (!file) return Promise.reject(new Error('未选择文件'));
    if (file.size > MAX_BYTES) {
      return Promise.reject(new Error('文件过大（超过 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB）'));
    }
    return readAsArrayBuffer(file).then(function (buf) {
      var kind = sniff(buf, file.name);
      var task;
      if (kind === 'pdf') task = pdfToText(buf);
      else if (kind === 'docx') task = docxToText(buf);
      else task = Promise.resolve(decode(buf));

      return task.then(function (text) {
        return {
          text: (text || '').trim(),
          kind: kind,
          fileName: file.name,
          bytes: file.size
        };
      });
    });
  }

  window.__RJ_FILE_TEXT__ = {
    readAsText: readAsText,
    docxToText: docxToText,
    pdfToText: pdfToText,
    itemsToText: itemsToText,
    sniff: sniff
  };
})();
