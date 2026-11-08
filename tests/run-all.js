/**
 * 全量测试入口。
 *
 *   node run-all.js                  跑全部（单元 + 界面 + 真实投递页门禁）
 *   node run-all.js --fast           只跑单元（纯 Node，几秒出结果）
 *   node run-all.js --only=real-site 只跑真实投递页那条门禁
 *
 * 三组的分工：
 *   unit       纯 Node，不需要浏览器。规则、匹配、存储、AI 协议这类逻辑都在这儿
 *   ui         起无头 Chrome 把扩展真装上，验证弹窗 / 资料页 / 后台 / AI 兜底
 *   real-site  **门禁**：真浏览器 + 真投递页 + 登录态，端到端填一遍（含清理）
 *
 * 退出码：0 全过 · 1 有失败 · 2 有「没跑成」（环境不具备，没验证任何东西）
 *
 * 关于退出码 2 为什么单独区分：门禁最怕的不是报错，而是**看起来通过了其实没跑**。
 * 所以「环境不具备」绝不能被算成绿色，必须显式冒头。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GROUPS = [
  { key: 'unit', dir: 'unit', title: '单元 / 集成（纯 Node，不需要浏览器）' },
  { key: 'ui', dir: 'ui', title: '界面（起无头 Chrome，把扩展真装上）' },
  {
    key: 'real-site', dir: 'real-site', title: '真实投递页（门禁）',
    gate: true, verbose: true
  }
];

const argv = process.argv.slice(2);
const FAST = argv.indexOf('--fast') !== -1;
const onlyArg = (argv.filter(function (a) { return a.indexOf('--only=') === 0; })[0] || '').split('=')[1];

function listTests(dir) {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter(function (f) { return /\.js$/.test(f) && f[0] !== '_'; })
    .sort()
    .map(function (f) { return path.join(full, f); });
}

function countsOf(out) {
  const m = out.match(/通过\s+(\d+)\s*\/\s*失败\s+(\d+)/);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  return null;
}

(async () => {
  console.log('=== 简历自动投递助手 · 全量测试 ===\n');

  const groups = GROUPS.filter(function (g) {
    if (onlyArg) return g.key === onlyArg;
    if (FAST) return g.key === 'unit';
    return true;
  });
  if (!groups.length) {
    console.log('没有匹配的测试组（--only 的值看看是不是写错了）');
    process.exit(1);
  }

  const summary = [];
  let totalPass = 0, totalFail = 0, totalSkip = 0;
  const started = Date.now();

  for (const g of groups) {
    const files = listTests(g.dir);
    console.log('--- ' + g.title + ' ---');
    if (!files.length) {
      console.log('  （这个目录里没有测试）\n');
      continue;
    }
    let gPass = 0, gFail = 0, gSkipped = 0;

    for (const f of files) {
      const name = path.basename(f, '.js').padEnd(28);
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [f], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60 * 1000,
        env: process.env
      });
      const ms = Date.now() - t0;
      const out = (r.stdout || '') + (r.stderr || '');
      const c = countsOf(out);
      const code = r.status;

      if (g.verbose) {
        // 门禁的输出整段放出来 —— 它跑得慢，用户需要看到它到底验证了什么
        console.log('\n' + out.replace(/^\s+|\s+$/g, '') + '\n');
      }

      if (code === 2) {
        gSkipped++;
        console.log('  ⚠️  ' + name + ' 未执行（环境不具备）  ' + (ms / 1000).toFixed(1) + 's');
      } else if (code === 0) {
        if (c) { gPass += c.pass; }
        // 没打印 N/M 汇总的，只能按退出码判断 —— 明确标出来。
        // 不然「什么都不测、直接 exit 0」也会显示成绿色，正是门禁最怕的假通过。
        console.log('  ✓  ' + name +
          (c ? ('通过 ' + c.pass + ' / 失败 0') : '退出码 0（没有汇总行，无法核对项数）') +
          '  ' + (ms / 1000).toFixed(1) + 's');
      } else {
        gFail += c ? c.fail : 1;
        if (c) gPass += c.pass;
        console.log('  ✗  ' + name + (c ? ('通过 ' + c.pass + ' / 失败 ' + c.fail) : ('退出码 ' + code)) +
          '  ' + (ms / 1000).toFixed(1) + 's');
        if (!g.verbose) console.log(indent(out, '      '));
      }
    }
    console.log('');
    summary.push({ title: g.title, pass: gPass, fail: gFail, skip: gSkipped });
    totalPass += gPass; totalFail += gFail; totalSkip += gSkipped;
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('================================');
  summary.forEach(function (s) {
    console.log('  ' + s.title + '：通过 ' + s.pass + ' / 失败 ' + s.fail +
      (s.skip ? (' / 未执行 ' + s.skip) : ''));
  });
  console.log('  ----');
  console.log('  合计：通过 ' + totalPass + ' / 失败 ' + totalFail +
    (totalSkip ? (' / 未执行 ' + totalSkip) : '') + '   耗时 ' + secs + 's');

  if (totalFail) {
    console.log('\n❌ 未通过');
    process.exit(1);
  }
  if (totalSkip) {
    console.log('\n⚠️  有 ' + totalSkip + ' 组没跑成（环境不具备）。这不算通过 ——');
    console.log('   真实投递页那条需要：调试浏览器开着 + 投递页打开并登录 + 扩展已启用。');
    console.log('   先跑 node tools/ext-state.js 看缺哪一项。');
    process.exit(2);
  }
  console.log('\n✅ 全部通过');
  process.exit(0);
})().catch(function (e) {
  console.log('运行异常：' + String((e && e.stack) || e).slice(0, 600));
  process.exit(1);
});

function indent(text, pad) {
  return String(text).replace(/^\s+|\s+$/g, '').split('\n').slice(-12)
    .map(function (l) { return pad + l; }).join('\n');
}
