import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// Every selector in a stylesheet, with comments and at-rule preludes left out.
const selectorsOf = (css) => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  const re = /([^{};]+)\{/g;
  let match;
  while ((match = re.exec(text))) {
    const prelude = match[1].trim();
    if (!prelude || prelude.startsWith('@')) continue;
    selectors.push(...prelude.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return selectors;
};

test('every rule in ipad.css is for the iPad app alone', () => {
  const selectors = selectorsOf(read('./ipad.css'));
  assert.ok(selectors.length > 20, 'ipad.css has its rules');
  for (const selector of selectors) {
    assert.match(
      selector,
      /^html\[data-(ipad|tab-row)\](?:$|[ .:[])/,
      `${selector} would reach phones or the website`,
    );
  }
});

test('the dream page wrappers change nothing outside the iPad', () => {
  const css = read('./pages/DreamDetail.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.detail-main,\s*\.detail-side\s*\{\s*display:\s*contents;\s*\}/);
});

test('only the native app marks the page as an iPad', () => {
  const main = read('./main.jsx');
  const native = main.indexOf("if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') {");
  const marked = main.indexOf('document.documentElement.dataset.ipad');
  assert.ok(native !== -1 && marked > native, 'data-ipad is set inside the native iOS branch');
});
