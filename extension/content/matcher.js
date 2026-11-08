/**
 * 语义层 - 规则匹配：把字段特征包对应到 Profile 路径。
 * 优先级：autocomplete 标准名 > 主线索(label/placeholder) > 次线索(name/id)。
 * 关键词越长越具体，得分越高；命中 exclude 直接跳过该规则。
 */
(function () {
  if (window.__RJ_MATCHER__) return;

  function normalize(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[*:：()（）\[\]【】<>《》{}"'`/\\_\-.,。，、;；!！?？~·]/g, '');
  }

  function getByPath(obj, path) {
    return String(path).split('.').reduce(function (o, k) {
      return (o == null ? undefined : o[k]);
    }, obj);
  }

  function bestHit(hay, rules) {
    if (!hay) return null;
    var best = null;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var excluded = false;
      if (r.exclude) {
        for (var x = 0; x < r.exclude.length; x++) {
          var ex = normalize(r.exclude[x]);
          if (ex && hay.indexOf(ex) !== -1) { excluded = true; break; }
        }
      }
      if (excluded) continue;
      for (var k = 0; k < r.keywords.length; k++) {
        var kw = normalize(r.keywords[k]);
        if (kw && hay.indexOf(kw) !== -1 && (!best || kw.length > best.klen)) {
          // 把规则本身也带出去：重复块要靠 rule.block / rule.anchor 判断归属
          best = { path: r.path, kw: r.keywords[k], klen: kw.length, rule: r };
        }
      }
    }
    return best;
  }

  function matchField(field, rules) {
    var ac = String((field.attrs && field.attrs.autocomplete) || '').toLowerCase();
    if (ac && ac !== 'off' && ac !== 'on') {
      for (var i = 0; i < rules.length; i++) {
        var list = rules[i].autocomplete || [];
        for (var j = 0; j < list.length; j++) {
          var a = list[j].toLowerCase();
          if (ac === a || ac.indexOf(a + '-') === 0) {
            return { path: rules[i].path, confidence: 0.95, reason: 'autocomplete=' + ac, source: 'rule' };
          }
        }
      }
    }

    var primary = normalize([field.labelText, field.attrs && field.attrs.placeholder].join(' '));
    var secondary = normalize([
      field.attrs && field.attrs.name,
      field.attrs && field.attrs.id,
      field.attrs && field.attrs.autocomplete
    ].join(' '));

    var p = bestHit(primary, rules);
    if (p) {
      return {
        path: p.path,
        block: (p.rule && p.rule.block) || null,
        anchor: !!(p.rule && p.rule.anchor),
        confidence: Math.min(0.95, 0.62 + p.klen * 0.05),
        reason: 'label匹配 "' + p.kw + '"',
        source: 'rule'
      };
    }
    var s = bestHit(secondary, rules);
    if (s) {
      return {
        path: s.path,
        block: (s.rule && s.rule.block) || null,
        anchor: !!(s.rule && s.rule.anchor),
        confidence: Math.min(0.8, 0.4 + s.klen * 0.05),
        reason: '属性匹配 "' + s.kw + '"',
        source: 'rule'
      };
    }
    return null;
  }

  window.__RJ_MATCHER__ = { normalize: normalize, getByPath: getByPath, matchField: matchField };
})();
