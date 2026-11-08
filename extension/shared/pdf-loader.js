/**
 * PDF 解析库加载器（独立 ESM 文件）。
 *
 * 注意：MV3 扩展页的 CSP 是 `script-src 'self'; object-src 'self'`，
 * **内联 <script> 会被直接拦掉**，所以 pdf.js 必须放在这个外部文件里 import。
 * 加载失败也不影响 DOCX / TXT，导入时会给出可读的错误提示。
 */
try {
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
  window.__RJ_PDF__ = pdfjs;
} catch (e) {
  console.warn('[RJ] pdf.js 加载失败，PDF 导入将不可用：', e);
  window.__RJ_PDF_ERROR__ = String((e && e.message) || e);
}
