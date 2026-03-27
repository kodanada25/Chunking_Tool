var SlicerCore = (function () {
  'use strict';

  var ENC = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function fmtB(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n >= 10240 ? 1 : 2) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function getLine(charIdx, text) {
    var s = charIdx;
    while (s > 0 && text[s - 1] !== '\n') s--;
    var e = charIdx;
    while (e < text.length && text[e] !== '\n') e++;
    return text.slice(s, e);
  }

  function isOnBlankLine(charIdx, text) {
    if (!text || !text.length || charIdx < 0) return false;
    if (charIdx >= text.length) return true;
    if (getLine(charIdx, text).trim().length === 0) return true;
    var nextNl = text.indexOf('\n', charIdx);
    if (nextNl !== -1 && nextNl + 1 < text.length) {
      if (getLine(nextNl + 1, text).trim().length === 0) return true;
    }
    // Allow cuts at any line break boundary
    if (charIdx > 0 && text[charIdx - 1] === '\n') return true;
    // Allow cuts after sentence-ending punctuation
    var line = getLine(charIdx, text).trim();
    if (/[。！？!?\)]$/.test(line)) return true;
    return false;
  }

  /**
   * @param {string} rawContent
   * @param {number} chunkIndex  0-based
   * @param {number} totalChunks
   * @param {object} i18n
   * @param {string} i18n.trigger          – pattern to match in first chunk
   * @param {string} i18n.replacementBase  – base replacement text
   * @param {function(number):string} i18n.formatReportIntro  – returns intro line with count
   * @param {function(number):string} i18n.formatReportHeader – returns header with chunk number
   */
  function transformContent(rawContent, chunkIndex, totalChunks, i18n) {
    var content = rawContent;
    var n = chunkIndex + 1;
    var trigger = i18n.trigger;
    var replacementBase = i18n.replacementBase;
    var fmtIntro = i18n.formatReportIntro;
    var fmtHeader = i18n.formatReportHeader;

    if (n === 1 && content.includes(trigger)) {
      var intro = replacementBase + '\n' + fmtIntro(totalChunks) + '\n' + fmtHeader(1) + '\n';
      content = content.replace(trigger, intro);
    } else {
      content = fmtHeader(n) + '\n' + content;
    }
    return content;
  }

  function getSegments(text, cutChars, activeBottomChar, enc) {
    var encoder = enc || ENC;
    var charBorders = [0].concat(cutChars);
    var lastCutCh = cutChars.length ? cutChars[cutChars.length - 1] : 0;
    if (activeBottomChar > lastCutCh) charBorders.push(activeBottomChar);
    return charBorders.slice(0, -1).map(function (startCh, i) {
      var endCh = charBorders[i + 1];
      var content = text.slice(startCh, endCh);
      return {
        bytes: encoder.encode(content).length,
        chars: endCh - startCh,
        content: content,
        colorIdx: i
      };
    }).filter(function (s) { return s.chars > 0; });
  }

  return {
    fmtB: fmtB,
    getLine: getLine,
    isOnBlankLine: isOnBlankLine,
    transformContent: transformContent,
    getSegments: getSegments
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SlicerCore;
}
