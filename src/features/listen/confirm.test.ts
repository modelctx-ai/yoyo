import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, test } from 'vite-plus/test';

import { confirmSend, reduceConfirm } from './confirm.ts';
import type { ConfirmState } from './confirm.ts';

const start: ConfirmState = { text: '今天海淀下雨吗', held: false, done: false, deadline: 3_000 };

/** 往确认页发一个决定，返回状态码。可以改请求头，模拟别的网页。 */
function post(url: string, body: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL('/decision', url),
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function decision(action: string, text?: string): string {
  return JSON.stringify({ action, text });
}

/** 模拟浏览器：打开确认页，读完页面，再按 `decide` 发回决定。 */
function browser(decide: (url: string) => Promise<void>) {
  let visit: Promise<{ readonly url: string; readonly page: string }> | undefined;
  return {
    open: (url: string): void => {
      visit = (async () => {
        const page = await (await fetch(url)).text();
        await decide(url);
        return { url, page };
      })();
    },
    visited: () => {
      assert.ok(visit, '确认页没有打开');
      return visit;
    },
  };
}

describe('confirm', () => {
  test('没人动，到点就用原文发送', () => {
    const sent = reduceConfirm(start, { type: 'tick', now: 3_000 });
    assert.equal(sent.action, 'send');
    assert.equal(sent.text, '今天海淀下雨吗');
  });

  test('任何介入只停下自动发送', () => {
    const held = reduceConfirm(start, { type: 'intervene' });
    assert.equal(held.held, true);
    assert.equal(held.done, false);
    const still = reduceConfirm(held, { type: 'tick', now: 9_000 });
    assert.equal(still.done, false);
  });

  test('介入之后要用户自己发送，可以改字', () => {
    const held = reduceConfirm(start, { type: 'intervene' });
    const sent = reduceConfirm(held, { type: 'send', text: '海淀现在下雨吗' });
    assert.equal(sent.text, '海淀现在下雨吗');
  });

  test('取消就不再发送', () => {
    assert.equal(reduceConfirm(start, { type: 'cancel' }).action, 'cancel');
  });

  test('发送空字只算介入；没到点不发；结束以后不再变', () => {
    const blank = reduceConfirm(start, { type: 'send', text: '  ' });
    assert.equal(blank.held, true);
    assert.equal(blank.done, false);
    assert.equal(reduceConfirm(start, { type: 'send' }).text, '今天海淀下雨吗');
    assert.equal(reduceConfirm(start, { type: 'tick', now: 2_999 }), start);
    const cancelled = reduceConfirm(start, { type: 'cancel' });
    assert.equal(reduceConfirm(cancelled, { type: 'send', text: '再发' }), cancelled);
  });

  test('确认页发回发送，就返回页面里改过的字，然后关掉服务', async () => {
    const statuses: number[] = [];
    const page = browser(async (url) => {
      statuses.push((await fetch(new URL('/favicon.ico', url))).status);
      statuses.push(await post(url, decision('send', ' 海淀现在下雨吗 ')));
    });
    assert.equal(await confirmSend('今天海淀下雨吗', { open: page.open }), '海淀现在下雨吗');
    const { url, page: html } = await page.visited();
    assert.deepEqual(statuses, [404, 204]);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(html.includes('const original = "今天海淀下雨吗";'));
    assert.ok(html.includes('3 秒内没有操作会自动发送'));
    assert.ok(html.includes("window.addEventListener('pagehide', () => finish('cancel', ''));"));
    await assert.rejects(fetch(url));
  });

  test('确认页取消、或者发回读不懂的内容，都返回空字符串', async () => {
    for (const body of [decision('cancel', ''), decision('send', '   '), '不是 JSON', 'null']) {
      const page = browser(async (url) => {
        await post(url, body);
      });
      assert.equal(await confirmSend('今天海淀下雨吗', { open: page.open }), '', body);
      await page.visited();
    }
  });

  test('页面没人理，超时返回空字符串', async () => {
    let opened = '';
    const text = await confirmSend('今天海淀下雨吗', {
      open: (url) => {
        opened = url;
      },
      timeoutMs: 50,
    });
    assert.equal(text, '');
    assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    await assert.rejects(fetch(opened));
  });

  test('别的网页借浏览器发来的决定不算', async () => {
    const statuses: number[] = [];
    const page = browser(async (url) => {
      const { host, origin } = new URL(url);
      statuses.push(await post(url, decision('send', '别的网页写的'), { origin: 'https://evil.example' }));
      statuses.push(await post(url, decision('send', '重绑定写的'), { host: `evil.example:${new URL(url).port}` }));
      statuses.push(await post(url, decision('send', '自己改的'), { host, origin }));
    });
    assert.equal(await confirmSend('今天海淀下雨吗', { open: page.open }), '自己改的');
    await page.visited();
    assert.deepEqual(statuses, [403, 403, 204]);
  });

  test('原文里的 </script> 跳不出页面脚本，倒数秒数照参数写', async () => {
    const page = browser(async (url) => {
      await post(url, decision('cancel'));
    });
    await confirmSend('</script><script>alert(1)</script>', { open: page.open, seconds: 5 });
    const { page: html } = await page.visited();
    assert.equal(html.split('</script>').length, 2);
    assert.ok(html.includes('const original = "\\u003c/script>\\u003cscript>alert(1)\\u003c/script>";'));
    assert.ok(html.includes('const seconds = 5;'));
    assert.ok(html.includes('5 秒内没有操作会自动发送'));
  });

  test('打不开确认页就报错', async () => {
    await assert.rejects(
      confirmSend('今天海淀下雨吗', {
        open: () => {
          throw new Error('打不开浏览器');
        },
      }),
      { message: '打不开浏览器' },
    );
  });
});
