import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../web/pelican.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const PROMPT = '用svg绘制一个2D鹈鹏骑自行车的动画的html，不要用skill，不用测试';
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(id = '') {
    this.id = id;
    this.tagName = id.toUpperCase();
    this.children = [];
    this.options = [];
    this.handlers = new Map();
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.textContent = '';
    this.dataset = {};
    this.attributes = new Map();
    this.parent = null;
    this.scrollHeight = this.clientHeight = 100;
    this.scrollTop = 0;
    this.style = {};
    this.classList = { toggle() {}, remove() {} };
  }
  get value() { return this.currentValue ?? this.options[0]?.value ?? ''; }
  set value(value) { this.currentValue = value; }
  append(...children) {
    for (const child of children) if (child && typeof child === 'object') child.parent = this;
    this.children.push(...children);
  }
  prepend(...children) {
    for (const child of children) if (child && typeof child === 'object') child.parent = this;
    this.children.unshift(...children);
  }
  replaceChildren(...children) {
    for (const child of children) if (child && typeof child === 'object') child.parent = this;
    this.children = children;
    this.options = children.filter(child => child?.isOption);
    this.currentValue = undefined;
  }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  async fire(name) { return this.handlers.get(name)?.({ preventDefault() {} }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  setAttributeNS(_ns, name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  cloneNode() {
    const copy = new Element(this.id);
    copy.tagName = this.tagName;
    copy.attributes = new Map(this.attributes);
    copy.raw = this.raw;
    return copy;
  }
  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
  }
  closest(selector) {
    const tags = selector.split(',').map(s => s.trim().toLowerCase());
    let cur = this;
    while (cur) {
      if (tags.includes(cur.tagName?.toLowerCase())) return cur;
      cur = cur.parent;
    }
    return null;
  }
  querySelector() { return new Element(); }
  querySelectorAll(selector) { return this._qsa?.get(selector) ?? []; }
  focus() {}
  select() {}
  remove() {
    if (this.parent?.children) {
      const idx = this.parent.children.indexOf(this);
      if (idx >= 0) this.parent.children.splice(idx, 1);
    }
    this.parent = null;
  }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.get('close')?.(); }
}

function storage(maxEntries = Infinity) {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      if (!entries.has(key) && entries.size >= maxEntries) throw new DOMException('Full', 'QuotaExceededError');
      entries.set(key, value);
    },
    snapshot: () => [...entries.values()].join('\n'),
  };
}

async function page({ fetch: fetchImpl, bridge, proxy = false, localStorage = storage(), clipboard, clock } = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element(match[1])]));
  elements.get('effort').value = 'low';
  elements.get('verbosity').value = 'auto';
  elements.get('schedule-verbosity').value = 'auto';
  const document = {
    documentElement: new Element(), body: new Element(),
    getElementById: id => elements.get(id) ?? null,
    querySelector: selector => proxy && selector.includes('pelican-local-proxy') ? { content: '1' } : null,
    createElement: tag => {
      const node = new Element(tag);
      if (tag === 'template') {
        node.content = {
          querySelector: selector => {
            if (selector === 'svg[data-pelican-scene]' && /data-pelican-scene/i.test(node.innerHTML || '')) {
              const svgs = parseTemplateSvgs(node.innerHTML);
              return svgs.find(s => s.hasAttribute('data-pelican-scene')) ?? null;
            }
            return null;
          },
          querySelectorAll: selector => selector === 'svg' ? parseTemplateSvgs(node.innerHTML || '') : [],
        };
      }
      return node;
    },
    createElementNS: (_ns, tag) => new Element(tag),
    createTextNode: text => text,
  };
  let timestamp = 1_700_000_000_000;
  let timerId = 0;
  const timers = new Map();
  const timeouts = new Map();
  const now = () => clock?.now ?? Date.now();
  const windowHandlers = new Map();
  const context = {
    document, location: { protocol: proxy ? 'http:' : 'file:', hostname: proxy ? '127.0.0.1' : '', origin: proxy ? 'http://127.0.0.1:3217' : 'null' },
    window: { codexProxyPlugin: bridge, localStorage, addEventListener: (name, callback) => windowHandlers.set(name, callback) },
    crypto: webcrypto,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [timestamp += 1_000])); }
      static now() { return now(); }
    },
    Option: class { constructor(text, value) { this.text = this.textContent = text; this.value = value; this.isOption = true; } },
    fetch: fetchImpl ?? (() => { throw new Error('Unexpected network request'); }),
    navigator: clipboard ? { clipboard } : {},
    XMLSerializer: class { serializeToString(node) { return node.raw || '<svg></svg>'; } },
    performance, Intl, URL, Headers, Response, Blob, TextDecoder, TextEncoder, AbortController, AbortSignal, DOMException, TypeError,
    setTimeout(callback, delay) {
      timeouts.set(++timerId, { callback, at: now() + delay });
      return timerId;
    },
    clearTimeout: id => timeouts.delete(id),
    setInterval(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame: callback => { queueMicrotask(callback); return 1; }, cancelAnimationFrame() {},
  };
  vm.runInNewContext(script, context, { filename: 'pelican.html' });
  await tick();
  return { elements, document, close() { windowHandlers.get('pagehide')?.(); }, async poll(delay) {
    for (const timer of timers.values()) if (timer.delay === delay) await timer.callback();
    await tick();
  }, async advance(ms) {
    clock.now += ms;
    for (const [id, timer] of timeouts) {
      if (timer.at > clock.now) continue;
      timeouts.delete(id);
      timer.callback();
    }
    await tick();
  }, async submit() {
    elements.get('connection-dialog').showModal();
    elements.get('gateway-url').value = 'https://gateway.example.test/';
    elements.get('gateway-key').value = 'test-key-not-a-real-secret';
    await elements.get('connection-form').fire('submit');
    await tick();
  } };
}

function parseTemplateSvgs(markup) {
  const results = [];
  for (const match of markup.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi)) {
    const el = new Element('svg');
    el.raw = match[0];
    const attrs = match[1];
    for (const attr of attrs.matchAll(/([a-zA-Z0-9:-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/g)) {
      el.setAttribute(attr[1], attr[2] ?? attr[3] ?? '');
    }
    const inner = match[2];
    const defsMatches = inner.match(/<(?:defs|symbol)\b/gi) || [];
    const outsideDefs = inner.replace(/<(defs|symbol|clipPath|mask|pattern|marker)\b[\s\S]*?<\/\1>/gi, '');
    const shapeMatches = outsideDefs.match(/<(?:path|circle|ellipse|rect|polygon|polyline|line|text|image|use)\b/gi) || [];
    const toNodeList = items => ({
      length: items.length,
      [Symbol.iterator]: () => items[Symbol.iterator](),
    });
    el._qsa = new Map([
      ['defs, symbol', toNodeList(defsMatches.map(() => new Element('defs')))],
      ['path, circle, ellipse, rect, polygon, polyline, line, text, image, use', toNodeList(shapeMatches.map(() => new Element('path')))],
    ]);
    const before = markup.slice(0, match.index);
    let parent = null;
    if (/<(?:header|nav|button)\b[^>]*>(?![\s\S]*<\/(?:header|nav|button)>)/i.test(before)) {
      parent = new Element('header');
    } else if (/<div\b([^>]*)>(?![\s\S]*<\/div>)/i.test(before)) {
      const divMatch = before.match(/<div\b([^>]*)>(?![\s\S]*<\/div>)/i);
      parent = new Element('div');
      if (/\bhidden\b/i.test(divMatch[1])) parent.setAttribute('hidden', '');
      const styleMatch = divMatch[1].match(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (styleMatch) parent.setAttribute('style', styleMatch[1] ?? styleMatch[2] ?? '');
    }
    el.parent = el.parentElement = parent;
    results.push(el);
  }
  return results;
}

test('a failed connection exposes its reason inside the still-open dialog', async () => {
  let calls = 0;
  const p = await page({ fetch: async () => { calls++; throw new TypeError('Failed to fetch'); } });
  await p.submit();
  assert.equal(calls, 1);
  assert.equal(p.elements.get('connection-dialog').open, true);
  const error = p.elements.get('connection-error');
  assert.ok(error, 'The open connection dialog must contain an error element');
  assert.equal(error.hidden, false, 'The connection error must be visible inside the dialog');
  assert.match(error.textContent, /跨域|本地服务|连接失败/);
  assert.equal(p.elements.get('save-connection').disabled, false);
});

test('the localhost page reads models through its same-origin proxy', async () => {
  const calls = [];
  const p = await page({ proxy: true, fetch: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ data: [{ id: 'test-model' }] });
  } });
  await p.submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/models');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('X-Pelican-Gateway'), 'https://gateway.example.test/v1');
  assert.equal(headers.get('Authorization'), 'Bearer test-key-not-a-real-secret');
  assert.equal(p.elements.get('connection-dialog').open, false);
  assert.equal(p.elements.get('model').value, 'test-model');
  assert.equal(p.elements.get('run').disabled, false);
});

test('HTTP 401 is explained as an API-key failure inside the dialog', async () => {
  const p = await page({ fetch: async () => Response.json({ error: { message: 'unauthorized' } }, { status: 401 }) });
  await p.submit();
  const error = p.elements.get('connection-error');
  assert.ok(error);
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /401/);
  assert.match(error.textContent, /API.*密钥|API Key|Client Key/);
});

test('standalone mode sends the literal prompt with optional verbosity and saves local history', async () => {
  const bodies = [];
  const localStorage = storage();
  const output = '<!doctype html><html><body><p>鹈鹕</p></body></html>';
  const events = [
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: output },
    { type: 'response.completed', response: { id: 'fixture-response', model: 'test-model', status: 'completed', output: [], usage: { input_tokens: 21, output_tokens: 31, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 8 } } } },
  ];
  const bytes = new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
  const p = await page({
    proxy: true,
    localStorage,
    fetch: async (url, init) => {
      if (url === '/api/models') return Response.json({ data: [{ id: 'test-model' }] });
      assert.equal(url, '/api/responses');
      bodies.push(JSON.parse(init.body));
      return new Response(new ReadableStream({ start(stream) {
        for (let index = 0; index < bytes.length; index += 7) stream.enqueue(bytes.slice(index, index + 7));
        stream.close();
      } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'provider-request-1' } });
    },
  });
  await p.submit();
  p.elements.get('verbosity').value = 'high';
  await p.elements.get('run').fire('click');
  await tick();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].input[0].content[0].text, PROMPT);
  assert.equal(bodies[0].reasoning.effort, 'low');
  assert.deepEqual(bodies[0].text, { verbosity: 'high' });
  assert.equal(p.elements.get('source').textContent, output);
  assert.equal(p.elements.get('input-tokens').textContent, '21');
  assert.equal(p.elements.get('output-tokens').textContent, '31');
  assert.equal(p.elements.get('history-rows').children[0].children[3].children[0].textContent, '未返回 SVG');

  p.elements.get('verbosity').value = 'auto';
  await p.elements.get('run').fire('click');
  await tick();
  assert.equal(bodies[1].text, undefined);
});

test('standalone history survives reload and opens the older animation without rerunning', async () => {
  const localStorage = storage();
  const outputs = ['first ride', 'second ride'].map(label =>
    '<html><body><svg viewBox="0 0 10 10"><title>' + label + '</title></svg></body></html>');
  let requests = 0;
  const source = await page({ proxy: true, localStorage, fetch: async url => {
    if (url === '/api/models') return Response.json({ data: [{ id: 'test-model' }] });
    assert.equal(url, '/api/responses');
    return Response.json({ status: 'completed', output_text: outputs[requests++] });
  } });
  await source.submit();
  for (const output of outputs) {
    await source.elements.get('run').fire('click');
    await tick();
    assert.equal(source.elements.get('source').textContent, output);
    assert.equal(source.elements.get('current-result').hidden, true);
  }
  assert.doesNotMatch(localStorage.snapshot(), /test-key-not-a-real-secret|gateway\.example\.test/);
  const labels = localStorage.snapshot().split('\n').map(raw => JSON.parse(raw).clientKeyName);
  assert.match(labels[0], /^#[a-f0-9]{12}$/);
  assert.equal(labels[0], labels[1]);

  const reopened = await page({ proxy: true, localStorage });
  assert.equal(reopened.elements.get('history-count').textContent, '2 条');
  const [latest, first] = reopened.elements.get('history-rows').children;
  assert.equal(latest.children[3].children[0].textContent, '已生成');
  assert.equal(latest.children[2].children[1].textContent, '上游 · 未知');
  const thumb = first.children[5].children[0].children[0];
  assert.equal(thumb.children.some(node => node.className === 'thumb-marker'), false);
  assert.match(reopened.elements.get('history-hint').textContent, /看大图/);
  await thumb.fire('click');
  assert.equal(reopened.elements.get('preview-dialog').open, true);
  const [frame] = reopened.elements.get('dialog-frame').children;
  assert.equal(frame.attributes.get('sandbox'), 'allow-scripts');
  assert.match(frame.srcdoc, /first ride/);
  assert.doesNotMatch(frame.srcdoc, /second ride/);
  await reopened.elements.get('dialog-source-button').fire('click');
  assert.equal(reopened.elements.get('dialog-source').textContent, outputs[0]);
  assert.equal(reopened.elements.get('dialog-frame').children.length, 0);
  assert.equal(requests, 2);
});

test('hosted schedule cards create, edit, pause and delete independent plans', async () => {
  const plans = [];
  const submissions = [];
  let modelRuns = 0;
  const scheduledAtMs = 1_700_000_040_000;
  const saved = {
    ...archivedRecord(1, '<svg></svg>'), id: 'scheduled-night-' + scheduledAtMs,
    startedAtMs: scheduledAtMs + 700, scheduledAtMs, trigger: 'scheduled',
    model: 'nightly-model', clientKeyName: 'Scheduled Key', accountName: 'Night Account',
  };
  const records = [
    saved, { ...saved, id: 'scheduled-' + scheduledAtMs },
    { ...saved, id: 'scheduled-INVALID-' + scheduledAtMs },
    { ...saved, id: 'scheduled-night-0' + scheduledAtMs },
    { ...saved, id: 'scheduled-night-' + (scheduledAtMs + 1), scheduledAtMs: scheduledAtMs + 1 },
    { ...saved, id: 'scheduled-night-' + (scheduledAtMs + 60000), scheduledAtMs: scheduledAtMs + 60000 },
  ];
  const bridge = {
    version: 2, theme: 'dark',
    request: async ({ method, path, body }) => {
      assert.ok(!path.startsWith('/'), 'CPR requires an instance-relative path');
      const input = body && JSON.parse(body);
      let data;
      if (path === 'bootstrap') data = { prompt: PROMPT, keys: [
        { id: 'manual-id', name: 'Manual Key', enabled: true },
        { id: 'scheduled-id', name: 'Scheduled Key', enabled: true },
      ] };
      else if (path === 'models') data = { models: [input.clientKeyId === 'manual-id' ? 'manual-model' : 'nightly-model'] };
      else if (path === 'history') data = { records, total: 2, snapshot: 2 };
      else if (path === 'refine') data = { job: { id: saved.id, trigger: 'scheduled', status: 'running' }, queue: [], maxRounds: 1 };
      else if (path === 'schedule' || path.startsWith('schedule/')) {
        data = { plans, maxPlans: 10 };
        if (method === 'POST') {
          submissions.push({ path, input });
          if (path === 'schedule') {
            const { id, name, ...settings } = input;
            const index = id ? plans.findIndex(plan => plan.id === id) : plans.length;
            const savedId = id || 'plan' + index;
            plans[index] = {
              ...plans[index], id: savedId, name, settings, keyName: settings.clientKeyId === 'scheduled-id' ? 'Scheduled Key' : 'Manual Key',
              nextRunAtMs: settings.enabled ? scheduledAtMs + 60_000 : null,
            };
            data.savedId = savedId;
          } else if (path === 'schedule/pause') {
            for (const plan of plans) if (!input.id || input.id === plan.id) plan.settings.enabled = input.enabled ?? false;
          } else if (path === 'schedule/delete') {
            plans.splice(plans.findIndex(plan => plan.id === input.id), 1);
          } else throw new Error('Unexpected schedule route: ' + path);
        }
      } else throw new Error('Unexpected management route: ' + path);
      return { status: 200, body: new TextEncoder().encode(JSON.stringify(data)) };
    },
    models: { responses: async () => { modelRuns++; throw new Error('No model request expected'); } },
  };
  const { elements, document, close } = await page({ bridge });
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(elements.get('schedule-panel').hidden, false);
  assert.equal(elements.get('schedule-form').hidden, true);
  assert.equal(elements.get('schedule-state').textContent, '未设置');
  await elements.get('schedule-add').fire('click');
  assert.equal(elements.get('schedule-enabled').checked, false);
  elements.get('schedule-key').value = 'scheduled-id';
  await elements.get('schedule-key').fire('change');
  for (const [id, value] of Object.entries({
    'schedule-name': 'Nightly', 'schedule-model': 'nightly-model', 'schedule-effort': 'high',
    'schedule-verbosity': 'high', 'schedule-cron': '0 9 * * 1-5', 'schedule-timezone': 'Asia/Shanghai',
  })) elements.get(id).value = value;
  await elements.get('schedule-model').fire('change');
  elements.get('schedule-enabled').checked = true;
  await elements.get('schedule-form').fire('submit');
  assert.deepEqual(submissions[0], { path: 'schedule', input: {
    name: 'Nightly', enabled: true, clientKeyId: 'scheduled-id', model: 'nightly-model',
    effort: 'high', verbosity: 'high', cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai',
  } });
  assert.equal(elements.get('schedule-form').hidden, true);
  assert.equal(elements.get('schedule-state').textContent, '已启用 1 / 1 个');
  const planInfo = elements.get('schedule-list').children[0].children[0];
  assert.match(planInfo.children[1].textContent, /nightly-model.*high.*Asia\/Shanghai.*Scheduled Key/);
  assert.match(planInfo.children[2].textContent, /下一次/);
  assert.equal(elements.get('model').value, 'manual-model');
  assert.match(elements.get('refine-status').textContent, /正在单次直出生成/);
  const rows = elements.get('history-rows').children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].children[0].children[1].textContent, /定时/);
  assert.equal(rows[0].children[2].children[1].textContent, '上游 · Night Account');

  await elements.get('schedule-add').fire('click');
  elements.get('schedule-name').value = 'Lunch';
  elements.get('schedule-enabled').checked = true;
  elements.get('schedule-cron').value = '0 12 * * *';
  await elements.get('schedule-form').fire('submit');
  assert.equal(plans.length, 2);
  plans[0].historySaveFailure = { slotMs: scheduledAtMs, reason: 'full' };
  plans[1].historySaveFailure = { slotMs: scheduledAtMs, reason: 'unconfirmed' };
  plans[1].runningSinceMs = scheduledAtMs + 500;
  close();

  const reopened = await page({ bridge });
  const ui = reopened.elements;
  const actions = (index) => ui.get('schedule-list').children[index].children[1].children;
  assert.equal(ui.get('schedule-state').textContent, '执行中');
  assert.match(ui.get('history-schedule-warning').textContent, /Nightly.*存储已满.*\n.*Lunch.*未确认保存/);
  assert.match(ui.get('schedule-list').children[0].children[0].children[3].textContent, /存储已满/);
  await actions(0)[1].fire('click');
  assert.equal(ui.get('schedule-key').value, 'scheduled-id');
  assert.equal(ui.get('schedule-model').value, 'nightly-model');
  ui.get('schedule-name').value = 'Nightly updated';
  await reopened.poll(30000);
  assert.equal(ui.get('schedule-name').value, 'Nightly updated');
  await ui.get('schedule-form').fire('submit');
  assert.equal(submissions[2].input.id, 'plan0');
  assert.equal(plans[0].name, 'Nightly updated');

  plans[1].runningSinceMs = null;
  await actions(0)[0].fire('click');
  assert.deepEqual(submissions[3].input, { id: 'plan0', enabled: false });
  assert.equal(ui.get('schedule-state').textContent, '已启用 1 / 2 个');
  await actions(0)[0].fire('click');
  assert.deepEqual(submissions[4].input, { id: 'plan0', enabled: true });
  await ui.get('schedule-pause').fire('click');
  assert.deepEqual(submissions[5].input, {});
  assert.equal(ui.get('schedule-state').textContent, '全部已暂停');
  await actions(0)[2].fire('click');
  assert.deepEqual(submissions[6], { path: 'schedule/delete', input: { id: 'plan0' } });
  assert.equal(ui.get('schedule-list').children.length, 1);
  assert.doesNotMatch(ui.get('history-schedule-warning').textContent, /Nightly/);
  await ui.get('schedule-add').fire('click');
  await ui.get('schedule-cancel').fire('click');
  assert.equal(ui.get('schedule-form').hidden, true);
  assert.equal(modelRuns, 0);
  reopened.close();
});

function archivedRecord(n, source) {
  return {
    id: n.toString(16).padStart(32, '0'), startedAtMs: 1_690_000_000_000 + n,
    model: 'test-model', effort: 'low', outcome: 'generated', durationMs: 10,
    source, sourceOmitted: false,
  };
}

test('hosted manual button enqueues refinement, selects main SVG, and opens external playback', async () => {
  let job = null;
  let saved = null;
  let directCalls = 0;
  const mutations = [];
  const openedExternal = [];
  const copiedTexts = [];
  let callbackOrigin = 'https://cpr.example.test';
  let ticketCounter = 0;
  const draftHtml = '<!doctype html><html><body><div hidden><svg viewBox="0 0 2400 2400"><circle r="40"/></svg></div><svg class="sprite" viewBox="0 0 2000 2000"><defs><symbol id="sp"><path d="M0 0h10"/></symbol></defs></svg><header><svg width="24" height="24" viewBox="0 0 24 24"></svg></header><svg viewBox="0 0 1080 540"><circle r="10"/><title>Single ride</title></svg><script>requestAnimationFrame(()=>{})</script></body></html>';
  const bridge = {
    version: 2,
    callbackTicket: async ({ path, ttlSeconds }) => {
      assert.equal(path, 'preview');
      assert.equal(ttlSeconds, 300);
      ticketCounter += 1;
      return {
        state: 'ticket-' + ticketCounter,
        expiresAtMs: Date.now() + 300_000,
        callbackUrl: callbackOrigin + '/api/v1/plugins/callbacks/inst/sha/1/preview?state=ticket-' + ticketCounter,
      };
    },
    openExternal: async url => { openedExternal.push(url); },
    request: async ({ method, path, body, query }) => {
      const input = body && JSON.parse(body);
      let data;
      if (path === 'bootstrap') data = { prompt: PROMPT, keys: [{ id: 'test-key', enabled: true }] };
      else if (path === 'models') data = { models: ['test-model'] };
      else if (path === 'schedule') data = { plans: [], maxPlans: 10 };
      else if (path === 'history') data = { records: saved ? [saved] : [], total: saved ? 1 : 0, snapshot: saved ? 1 : 0 };
      else if (path === 'refine' || path === 'refine/stop') {
        if (method === 'POST') {
          mutations.push({ path, input });
          if (path === 'refine') job = { ...input, trigger: 'manual', status: 'queued', rounds: 0 };
          else job = { ...job, stopRequested: true };
        }
        data = { job, queue: [], queuedCount: 0, maxRounds: 1 };
      } else if (path === 'refine/draft') {
        assert.equal(query, 'id=' + job.id + '&version=latest');
        data = { record: { ...saved, refinement: undefined, source: draftHtml } };
      } else throw new Error('Unexpected route ' + path);
      return { status: 200, body: new TextEncoder().encode(JSON.stringify(data)) };
    },
    models: { responses() { directCalls++; throw new Error('Unexpected model request'); } },
  };

  const original = await page({ bridge, clipboard: { writeText: async text => { copiedTexts.push(text); } } });
  original.elements.get('verbosity').value = 'high';
  const begin = original.elements.get('run');
  assert.equal(begin.disabled, false);
  await begin.fire('click');
  assert.equal(mutations.length, 1);
  assert.match(job.id, /^[a-f\d]{32}$/);
  assert.deepEqual(mutations[0].input, { id: job.id, clientKeyId: 'test-key', model: 'test-model', effort: 'low', verbosity: 'high' });
  assert.match(original.elements.get('refine-status').textContent, /排队等待 CPR 后台执行/);
  assert.doesNotMatch(original.elements.get('refine-status').textContent, /已记录/);
  original.close();

  job = { ...job, status: 'running', rounds: 0, hasDraft: false, hasComparison: false };
  const reopened = await page({ bridge, clipboard: { writeText: async text => { copiedTexts.push(text); } } });
  const { elements } = reopened;
  assert.match(elements.get('refine-status').textContent, /正在单次直出生成/);
  await elements.get('refine-stop').fire('click');
  assert.deepEqual(mutations[1], { path: 'refine/stop', input: { id: job.id } });
  assert.match(elements.get('refine-status').textContent, /已请求停止/);
  job = { ...job, status: 'done', end: 'accepted', archive: 'saved', rounds: 1, hasDraft: true };
  saved = { ...archivedRecord(1, draftHtml), id: job.id, trigger: 'manual', verbosity: 'high' };
  await reopened.poll(4000);
  assert.match(elements.get('refine-status').textContent, /已完成.*已存入生成记录/);
  assert.equal(elements.get('history-count').textContent, '1 条');
  assert.equal(elements.get('refine-first').hidden, true);
  const thumbBtn = elements.get('history-rows').children[0].children[5].children[0].children[0];
  const thumbImg = thumbBtn.children.find(c => c.tagName === 'IMG');
  assert.ok(thumbImg);
  assert.match(decodeURIComponent(thumbImg.src), /1080 540/);
  assert.doesNotMatch(decodeURIComponent(thumbImg.src), /2400 2400/);
  assert.doesNotMatch(decodeURIComponent(thumbImg.src), /24 24/);

  await elements.get('refine-latest').fire('click');
  assert.match(elements.get('dialog-title').textContent, /本次结果/);
  assert.equal(elements.get('open-external').hidden, false);
  assert.equal(elements.get('dialog-preview-note').hidden, false);
  assert.match(elements.get('dialog-preview-note').textContent, /新标签页播放/);
  // Archived saved result uses permanent id= URL so rotating state.active never breaks playback;
  // changing callbackOrigin before click 1 primes click 2's HTTP clipboard fallback prefetch.
  callbackOrigin = 'http://127.0.0.1:8080';
  await elements.get('open-external').fire('click');
  assert.equal(openedExternal.length, 1);
  assert.match(openedExternal[0], new RegExp(`&id=${job.id}$`));
  await elements.get('open-external').fire('click');
  assert.equal(copiedTexts.length, 1);
  assert.match(copiedTexts[0], new RegExp(`^http:\\/\\/127\\.0\\.0\\.1:8080\\/.*&id=${job.id}$`));
  await elements.get('close-dialog').fire('click');
  assert.equal(mutations.length, 2);
  assert.equal(directCalls, 0);
});

test('hosted history hydrates older thumbnails and shares the pending source request', async () => {
  const original = archivedRecord(0, '<svg><title>older ride</title><!--' + 'x'.repeat(80_000) + '--></svg>');
  const recent = Array.from({ length: 20 }, (_, n) => archivedRecord(20 - n, '<svg></svg>'));
  const calls = [];
  const opened = [];
  let ticketCount = 0;
  let inClick = false;
  let finishRecord;
  const status = new TextEncoder();
  const bridge = {
    version: 2,
    callbackTicket: async () => ({
      callbackUrl: 'https://cpr.example.test/cb?state=' + ++ticketCount,
      expiresAtMs: Date.now() + 300_000,
    }),
    openExternal: async url => {
      opened.push({ url, inClick });
    },
    request: async ({ path, query }) => {
      let data;
      if (path === 'bootstrap') data = { prompt: PROMPT, keys: [] };
      else if (path === 'schedule') data = { plans: [], maxPlans: 10 };
      else if (path === 'refine') data = { job: null, queue: [], maxRounds: 1 };
      else {
        calls.push({ path, query });
        if (path === 'history') data = { total: 21, snapshot: 21,
          records: query ? [{ ...original, source: null, hasSource: true }] : recent };
        else if (path === 'history/record') {
          await new Promise(resolve => { finishRecord = resolve; });
          data = { record: original };
        }
        else throw new Error('Unexpected route ' + path);
      }
      return { status: 200, body: status.encode(JSON.stringify(data)).buffer };
    },
    models: { responses: async () => { throw new Error('History must not generate'); } },
  };
  const { elements, close } = await page({ bridge });
  assert.equal(ticketCount, 1);
  assert.equal(elements.get('history-count').textContent, '21 条');
  assert.equal(elements.get('history-rows').children.length, 20);
  assert.deepEqual(calls, [{ path: 'history', query: undefined }]);
  await elements.get('history-next').fire('click');
  const recordCall = { path: 'history/record', query: 'id=' + original.id };
  assert.deepEqual(calls.slice(1), [{ path: 'history', query: 'offset=20&snapshot=21' }, recordCall]);
  assert.equal(elements.get('history-page').textContent, '第 2 / 2 页');
  assert.equal(elements.get('history-next').disabled, true);
  assert.equal(elements.get('history-rows').children.length, 1);
  const actions = elements.get('history-rows').children[0].children[5].children[0];
  const thumb = actions.children[0];
  assert.deepEqual(thumb.children.map(child => child.className), ['thumb-marker']);
  assert.match(elements.get('history-hint').textContent, /新标签页播放/);
  inClick = true;
  const click = thumb.fire('click');
  inClick = false;
  assert.deepEqual(opened, [{ url: 'https://cpr.example.test/cb?state=1&id=' + original.id, inClick: true }]);
  await click;
  await tick();
  assert.equal(ticketCount, 2);
  assert.equal(elements.get('preview-dialog').open, false);
  assert.match(elements.get('history-hint').textContent, /宿主弹出的确认框.*打开链接/);
  const sourceClick = actions.children[1].fire('click');
  const recordCalls = () => calls.filter(call => call.path === 'history/record');
  assert.deepEqual(recordCalls(), [recordCall]);
  finishRecord();
  await sourceClick;
  await tick();
  const [image, marker] = thumb.children;
  assert.equal(image.tagName, 'IMG');
  assert.equal(image.alt, '');
  assert.equal(image.loading, 'lazy');
  assert.equal(image.decoding, 'async');
  assert.match(decodeURIComponent(image.src), /<title>older ride<\/title>/);
  assert.equal(marker.className, 'thumb-marker');
  assert.equal(elements.get('preview-dialog').open, true);
  assert.equal(elements.get('dialog-source').textContent, original.source);
  await elements.get('close-dialog').fire('click');
  await elements.get('history-prev').fire('click');
  assert.equal(elements.get('history-rows').children.length, 20);
  await elements.get('history-next').fire('click');
  const returnedActions = elements.get('history-rows').children[0].children[5].children[0];
  assert.equal(returnedActions.children[0].children[0].src, image.src);
  assert.deepEqual(recordCalls(), [recordCall]);
  const reopen = returnedActions.children[1].fire('click');
  assert.deepEqual(recordCalls(), [recordCall, recordCall]);
  finishRecord();
  await reopen;
  assert.equal(elements.get('dialog-source').textContent, original.source);
  close();
});

function thumbnailHistoryBridge(firstPage, secondPage, readRecord) {
  const total = firstPage.length + secondPage.length;
  return {
    version: 2,
    async request({ path, query }) {
      const routes = {
        bootstrap: { prompt: PROMPT, keys: [] },
        schedule: { plans: [], maxPlans: 10 },
        refine: { job: null, queue: [], maxRounds: 1 },
        history: { records: query ? secondPage : firstPage, total, snapshot: total },
      };
      if (path === 'history/record') return readRecord(query.slice('id='.length));
      assert.ok(Object.hasOwn(routes, path), 'Unexpected route ' + path);
      return historyReply(routes[path]);
    },
  };
}

function historyReply(data, status = 200) {
  return { status, body: new TextEncoder().encode(JSON.stringify(data)) };
}

function omittedSource(record) {
  return { ...record, source: null, hasSource: true };
}

function historyThumbs(elements) {
  return elements.get('history-rows').children.map(row => row.children[5].children[0].children[0]);
}

function fullFirstPage(records) {
  return [...records.map(omittedSource), ...Array.from({ length: 20 - records.length }, (_, index) =>
    archivedRecord(100 + index, null))];
}

test('thumbnail hydration limits concurrency and discards queued work on page changes and pagehide', async () => {
  const [a, b, c, d, e, f, g] = Array.from({ length: 7 }, (_, index) => archivedRecord(index, '<svg></svg>'));
  const calls = [];
  const pending = new Map();
  const bridge = thumbnailHistoryBridge(fullFirstPage([a, b, c, d]), [e, f, g].map(omittedSource), id => {
    calls.push(id);
    return new Promise(resolve => pending.set(id, resolve));
  });
  const { elements, close } = await page({ bridge });
  const complete = async record => {
    const resolve = pending.get(record.id);
    pending.delete(record.id);
    resolve(historyReply({ record }));
    await tick();
  };
  assert.deepEqual(calls, [a.id, b.id]);
  const [previousThumb] = historyThumbs(elements);
  await elements.get('history-next').fire('click');
  assert.deepEqual(calls, [a.id, b.id]);
  await complete(a);
  assert.deepEqual(calls, [a.id, b.id, e.id]);
  assert.equal(previousThumb.children.some(child => child.tagName === 'IMG'), false);
  await complete(b);
  assert.deepEqual(calls, [a.id, b.id, e.id, f.id]);
  await complete(e);
  assert.deepEqual(calls, [a.id, b.id, e.id, f.id, g.id]);
  const [currentThumb, pendingThumb] = historyThumbs(elements);
  assert.equal(currentThumb.children[0].tagName, 'IMG');

  await elements.get('history-prev').fire('click');
  assert.deepEqual(calls, [a.id, b.id, e.id, f.id, g.id]);
  assert.equal(historyThumbs(elements)[0].children[0].tagName, 'IMG');
  close();
  await complete(f);
  await complete(g);
  assert.deepEqual(calls, [a.id, b.id, e.id, f.id, g.id]);
  assert.equal(pendingThumb.children.some(child => child.tagName === 'IMG'), false);
});

test('thumbnail hydration skips no_svg rows and leaves their source available', async () => {
  const noSvg = { ...archivedRecord(1, '<html><p>Text only</p></html>'), outcome: 'no_svg' };
  const generated = archivedRecord(2, '<svg></svg>');
  const calls = [];
  const bridge = thumbnailHistoryBridge([noSvg, generated].map(omittedSource), [], id => {
    calls.push(id);
    return historyReply({ record: id === noSvg.id ? noSvg : generated });
  });
  const { elements, close } = await page({ bridge });
  const [fallback, hydrated] = historyThumbs(elements);
  assert.deepEqual(calls, [generated.id]);
  assert.equal(fallback.textContent, '\u64ad\u653e');
  assert.equal(fallback.children.some(child => child.tagName === 'IMG'), false);
  assert.equal(hydrated.children[0].tagName, 'IMG');
  await elements.get('history-rows').children[0].children[5].children[0].children[1].fire('click');
  assert.deepEqual(calls, [generated.id, noSvg.id]);
  assert.equal(elements.get('dialog-source').textContent, noSvg.source);
  close();
});

test('thumbnail hydration retries transient failures and caches missing and broken images', async () => {
  const retry = archivedRecord(1, '<svg><title>Retry</title></svg>');
  const missing = archivedRecord(2, '<svg></svg>');
  const broken = archivedRecord(3, '<svg><title>Broken image</title></svg>');
  const empty = archivedRecord(4, '<html><p>No SVG</p></html>');
  const records = [retry, missing, broken, empty];
  const calls = [];
  const bridge = thumbnailHistoryBridge(fullFirstPage(records), [archivedRecord(0, null)], id => {
    const firstAttempt = !calls.includes(id);
    calls.push(id);
    if (id === retry.id && firstAttempt) return historyReply({ message: 'Temporarily unavailable' }, 503);
    if (id === missing.id) return { status: 404, body: new TextEncoder().encode('Not found') };
    return historyReply({ record: records.find(record => record.id === id) });
  });
  const { elements, close } = await page({ bridge });
  const [fallback, missingThumb, brokenThumb, emptyThumb] = historyThumbs(elements);
  assert.deepEqual(calls, records.map(record => record.id));
  assert.equal(fallback.textContent, '\u64ad\u653e');
  assert.deepEqual(fallback.children.map(child => child.className), ['thumb-marker']);
  assert.equal(missingThumb.children.some(child => child.tagName === 'IMG'), false);
  assert.equal(emptyThumb.children.some(child => child.tagName === 'IMG'), false);
  const image = brokenThumb.children[0];
  assert.equal(image.tagName, 'IMG');
  await image.fire('error');
  assert.equal(brokenThumb.textContent, fallback.textContent);
  assert.deepEqual(brokenThumb.children.map(child => child.className), ['thumb-marker']);

  await elements.get('history-next').fire('click');
  await elements.get('history-prev').fire('click');
  await tick();
  assert.deepEqual(calls, [...records.map(record => record.id), retry.id]);
  const [retried, stillMissing, stillBroken, stillEmpty] = historyThumbs(elements);
  assert.match(decodeURIComponent(retried.children[0].src), /<title>Retry<\/title>/);
  for (const thumb of [stillMissing, stillBroken, stillEmpty]) {
    assert.deepEqual(thumb.children.map(child => child.className), ['thumb-marker']);
  }
  close();
});

test('browser quota preserves legacy history and keeps the rejected source accessible in the page', async () => {
  const localStorage = storage(2);
  const old = Array.from({ length: 20 }, (_, n) => archivedRecord(n, '<svg><title>legacy ' + n + '</title></svg>'));
  const legacy = JSON.stringify(old);
  localStorage.setItem('cpr-pelican.history.v1', legacy);
  let runs = 0;
  const { elements, submit } = await page({ localStorage, proxy: true, fetch: async url =>
    url === '/api/models' ? Response.json({ data: [{ id: 'test-model' }] })
      : Response.json({ status: 'completed', output_text: '<svg><title>new ' + ++runs + '</title></svg>' })
  });
  await submit();
  await elements.get('run').fire('click');
  await tick();
  assert.equal(elements.get('history-count').textContent, '21 条');
  const before = localStorage.snapshot();
  await elements.get('run').fire('click');
  await tick();
  assert.equal(localStorage.snapshot(), before);
  assert.equal(localStorage.getItem('cpr-pelican.history.v1'), legacy);
  const warning = elements.get('history-unsaved');
  assert.equal(warning.hidden, false);
  assert.match(warning.children[0].textContent, /存储已满.*未保存/);
  await warning.children[0].children[0].fire('click');
  assert.match(elements.get('dialog-source').textContent, /new 2/);
  await elements.get('history-next').fire('click');
  assert.equal(elements.get('history-rows').children.length, 1);
  const oldest = elements.get('history-rows').children[0].children[5].children[0];
  await oldest.children[1].fire('click');
  assert.match(elements.get('dialog-source').textContent, /legacy 0/);
});

test('external playback refreshes expired prefetched tickets and ignores stale clipboard writes after closing', async () => {
  const sample = archivedRecord(1, '<svg class="sprite" viewBox="0 0 2000 2000"><defs><symbol id="bg"><path d="M0 0"/></symbol></defs></svg><svg viewBox="0 0 600 300"><circle r="8"/></svg>');
  const issuedTickets = [];
  const copied = [];
  let rejectExternal = null;
  let ticketCall = 0;
  const bridge = {
    version: 2,
    callbackTicket: async () => {
      ticketCall += 1;
      const ticket = {
        state: 't-' + ticketCall,
        expiresAtMs: ticketCall === 1 ? Date.now() - 10_000 : Date.now() + 300_000,
        callbackUrl: 'https://cpr.example.test/cb?state=t-' + ticketCall,
      };
      issuedTickets.push(ticket.state);
      return ticket;
    },
    openExternal: () => new Promise((_, reject) => { rejectExternal = reject; }),
    request: async ({ path }) => {
      let data;
      if (path === 'bootstrap') data = { prompt: PROMPT, keys: [{ id: 'k1', enabled: true }] };
      else if (path === 'models') data = { models: ['m1'] };
      else if (path === 'schedule') data = { plans: [], maxPlans: 10 };
      else if (path === 'refine') data = { job: null, queue: [], queuedCount: 0, maxRounds: 1 };
      else if (path === 'history') data = { records: [sample], total: 1, snapshot: 1 };
      else throw new Error('Unexpected route ' + path);
      return { status: 200, body: new TextEncoder().encode(JSON.stringify(data)) };
    },
    models: { responses() { throw new Error('Unexpected direct model call'); } },
  };
  const { elements } = await page({ bridge, clipboard: { writeText: async text => copied.push(text) } });
  const thumbBtn = elements.get('history-rows').children[0].children[5].children[0].children[0];
  const thumbImg = thumbBtn.children.find(c => c.tagName === 'IMG');
  assert.match(decodeURIComponent(thumbImg.src), /600 300/);
  assert.doesNotMatch(decodeURIComponent(thumbImg.src), /2000 2000/);

  await elements.get('history-rows').children[0].children[5].children[0].children[1].fire('click');
  await tick();
  assert.deepEqual(issuedTickets, ['t-1', 't-2']);

  const clickPromise = elements.get('open-external').fire('click');
  await tick();
  assert.deepEqual(issuedTickets, ['t-1', 't-2', 't-3']);
  elements.get('close-dialog').fire('click');
  rejectExternal(new Error('user dismissed'));
  await clickPromise;
  assert.deepEqual(copied, []);
});

function playbackFixture(sample, methods) {
  return {
    version: 2,
    ...methods,
    async request({ path }) {
      const routes = {
        bootstrap: { prompt: PROMPT, keys: [] },
        schedule: { plans: [], maxPlans: 10 },
        refine: { job: null, queue: [], maxRounds: 1 },
        history: { records: [sample], total: 1, snapshot: 1 },
      };
      assert.ok(Object.hasOwn(routes, path), 'Unexpected route ' + path);
      return { status: 200, body: new TextEncoder().encode(JSON.stringify(routes[path])) };
    },
  };
}

test('the hosted spare is renewed at expiry and shared while a ticket request is pending', async () => {
  const sample = archivedRecord(1, '<svg></svg>');
  const clock = { now: 1_700_000_000_000 };
  const opened = [];
  let finishTicket;
  let issued = 0;
  const bridge = playbackFixture(sample, {
    callbackTicket() {
      issued += 1;
      return new Promise(resolve => {
        finishTicket = () => resolve({
          callbackUrl: 'https://cpr.example.test/cb?state=' + issued,
          expiresAtMs: clock.now + 300_000,
        });
      });
    },
    openExternal: async url => { opened.push(url); },
  });
  const ui = await page({ bridge, clock });
  const thumb = ui.elements.get('history-rows').children[0].children[5].children[0].children[0];
  const firstClick = thumb.fire('click');
  const click = thumb.fire('click');
  await tick();
  assert.equal(issued, 1);
  assert.deepEqual(opened, []);
  finishTicket();
  await Promise.all([firstClick, click]);
  assert.deepEqual(opened, ['https://cpr.example.test/cb?state=1&id=' + sample.id]);
  assert.equal(issued, 2);
  finishTicket();
  await tick();
  await ui.advance(295_000);
  assert.equal(issued, 3);
  finishTicket();
  await tick();
  const next = thumb.fire('click');
  assert.equal(opened[1], 'https://cpr.example.test/cb?state=3&id=' + sample.id);
  await next;
  ui.close();
});

test('thumbnail playback copies the link on HTTP or host refusal and offers a manual fallback', async () => {
  const sample = archivedRecord(1, '<svg></svg>');
  for (const [origin, openExternal, clipboardAllowed] of [
    ['http://127.0.0.1:3217', () => assert.fail('HTTP must not call the host opener'), true],
    ['https://cpr.example.test', () => { throw new Error('Host refused'); }, true],
    ['https://cpr.example.test', undefined, true],
    ['https://cpr.example.test', undefined, false],
  ]) {
    const url = origin + '/cb';
    const copied = [];
    const bridge = playbackFixture(sample, { callbackTicket: async () => ({ callbackUrl: url }), openExternal });
    const ui = await page({ bridge, clipboard: { async writeText(text) {
      if (!clipboardAllowed) throw new Error('Clipboard unavailable');
      copied.push(text);
    } } });
    const actions = ui.elements.get('history-rows').children[0].children[5].children[0].children;
    await actions[0].fire('click');
    assert.equal(ui.elements.get('preview-dialog').open, false);
    const hint = ui.elements.get('history-hint').textContent;
    const link = url + '?id=' + sample.id;
    if (clipboardAllowed) {
      assert.deepEqual(copied, [link]);
      assert.equal(hint, '已复制一次性播放链接，请粘贴到新标签页打开');
    } else {
      assert.ok(hint.includes(link));
      await actions[1].fire('click');
      assert.equal(ui.elements.get('dialog-source').textContent, sample.source);
    }
    ui.close();
  }
  const bridge = playbackFixture(sample, { callbackTicket: async () => { throw new Error('Ticket unavailable'); } });
  const ui = await page({ bridge });
  await ui.elements.get('history-rows').children[0].children[5].children[0].children[0].fire('click');
  assert.equal(ui.elements.get('preview-dialog').open, true);
  ui.close();
});
