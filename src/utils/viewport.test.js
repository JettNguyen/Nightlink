import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lockedViewportContent, lockZoomInNativeApp } from './viewport.js';

const SITE_VIEWPORT = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
const APP_VIEWPORT = 'width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no';

// Stands in for the one piece of `document` the lock touches.
const pageWithViewport = (content) => {
  const meta = {
    content,
    getAttribute: (name) => (name === 'content' ? meta.content : null),
    setAttribute: (name, value) => {
      if (name === 'content') meta.content = value;
    },
  };
  return {
    meta,
    querySelector: (selector) => (selector === 'meta[name="viewport"]' ? meta : null),
  };
};

test('on the website, zoom stays on', () => {
  const page = pageWithViewport(SITE_VIEWPORT);
  assert.equal(lockZoomInNativeApp(page, false), false);
  assert.equal(page.meta.content, SITE_VIEWPORT);
});

test('in the native app, zoom is locked and the rest of the viewport is kept', () => {
  const page = pageWithViewport(SITE_VIEWPORT);
  assert.equal(lockZoomInNativeApp(page, true), true);
  assert.equal(page.meta.content, APP_VIEWPORT);
});

test('locking a viewport that is already locked changes nothing', () => {
  assert.equal(lockedViewportContent(APP_VIEWPORT), APP_VIEWPORT);
  assert.equal(
    lockedViewportContent('width=device-width, maximum-scale=5, user-scalable=yes'),
    'width=device-width, maximum-scale=1.0, user-scalable=no',
  );
});

test('a page with no viewport tag is left alone', () => {
  const page = { querySelector: () => null };
  assert.equal(lockZoomInNativeApp(page, true), false);
});

test('index.html ships with zoom on', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const tag = html.match(/<meta name="viewport" content="([^"]*)"/);
  assert.ok(tag, 'index.html has a viewport tag');
  assert.doesNotMatch(tag[1], /maximum-scale|user-scalable/);
  assert.match(tag[1], /viewport-fit=cover/);
});
