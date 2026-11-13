import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeTabTap } from './nativeTabs.js';

// The page counts someone else's profile as the Profile tab and selects it in
// the bar. UIKit reports that change the same way it reports a tap, as the
// tab you're now on without `reselect`. Taken as a tap, it opened your own
// profile a moment after Sam's (found in the iPad simulator on 11/13/2026).

test("selecting Profile for Sam's profile is not a tap", () => {
  const onSams = { pathname: '/profile/samkelly', currentTab: 'profile' };
  assert.equal(nativeTabTap({ id: 'profile', reselect: false }, onSams), null);
});

test('no change the page makes on any tab counts as a tap', () => {
  assert.equal(nativeTabTap({ id: 'feed', reselect: false }, { pathname: '/feed', currentTab: 'feed' }), null);
  assert.equal(nativeTabTap({ id: 'journal', reselect: false }, { pathname: '/dream/d1', currentTab: 'journal' }), null);
  assert.equal(nativeTabTap({ id: 'profile', reselect: false }, { pathname: '/profile', currentTab: 'profile' }), null);
});

test("a tap on Profile from Sam's profile opens your own", () => {
  const onSams = { pathname: '/profile/samkelly', currentTab: 'profile' };
  assert.equal(nativeTabTap({ id: 'profile', reselect: true }, onSams), '/profile');
});

test('a tap on Profile from another tab opens your own profile', () => {
  assert.equal(nativeTabTap({ id: 'profile', reselect: false }, { pathname: '/feed', currentTab: 'feed' }), '/profile');
  // A dream of Sam's opened from the feed counts as Feed.
  const onDream = { pathname: '/profile/samkelly/dream/d1', currentTab: 'feed' };
  assert.equal(nativeTabTap({ id: 'profile', reselect: false }, onDream), '/profile');
});

test('a tap on a tab from a page outside the tabs opens that tab', () => {
  assert.equal(nativeTabTap({ id: 'profile', reselect: true }, { pathname: '/settings' }), '/profile');
  assert.equal(nativeTabTap({ id: 'feed', reselect: false }, { pathname: '/settings' }), '/feed');
});

test("a tap on the tab whose own page you're on goes back to its top", () => {
  assert.equal(nativeTabTap({ id: 'feed', reselect: true }, { pathname: '/feed', currentTab: 'feed' }), 'top');
  assert.equal(nativeTabTap({ id: 'profile', reselect: true }, { pathname: '/profile', currentTab: 'profile' }), 'top');
});

test("a tap on the tab you're on, below its own page, goes to that page", () => {
  const onDream = { pathname: '/profile/samkelly/dream/d1', currentTab: 'feed' };
  assert.equal(nativeTabTap({ id: 'feed', reselect: true }, onDream), '/feed');
});

test('a tab the page does not know does nothing', () => {
  assert.equal(nativeTabTap({ id: 'messages', reselect: false }, { pathname: '/feed', currentTab: 'feed' }), null);
  assert.equal(nativeTabTap(undefined, undefined), null);
});
