/* Browser rendering/workflow smoke test. Pass the installed Playwright module path. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.argv[2] || 'playwright');

(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 440, height: 1100}, deviceScaleFactor: 1});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // CEP supplies Node and the host bridge. Simulate only those boundaries.
    await page.addInitScript(() => {
      window.require = name => {
        if (name === 'path') return {dirname: p => p.substring(0, p.lastIndexOf('/')), join: (...p) => p.join('/'), basename: p => p.split('/').pop()};
        if (name === 'process') return {env: {}};
        if (name === 'fs') return {
          existsSync: p => !p.endsWith('.response'), readdirSync: () => ['streamer-main.json'], mkdirSync: () => {}, unlinkSync: () => {},
          readFileSync: p => JSON.stringify(p.endsWith('runtime.json') ?
            {profiles: '/voices', default_profile: 'streamer-main.json', data: '/data', worker: 'analyze.py', python: 'python'} :
            {schema: 1, name: 'Мой стример', embedding: [1, ...Array(191).fill(0)]}),
          writeFileSync: (p, data) => {
            if (p.endsWith('.jsx')) { window.lastHostFile = data; }
            else if (!p.endsWith('last-call.json')) { window.testRequest = JSON.parse(data); }
          }
        };
        if (name === 'crypto') return {createHash: () => ({update: () => ({digest: () => 'job-test'})})};
        if (name === 'child_process') return {spawn: () => ({
          stdout: {setEncoding: () => {}, on: () => {}}, stderr: {setEncoding: () => {}, on: () => {}},
          on: function (event, callback) { if (event === 'close') setTimeout(() => callback(1), 20); return this; }
        })};
        return {};
      };
      window.__adobe_cep__ = {evalScript: (script, callback) => { window.lastHostScript = script; callback(window.testHostError || JSON.stringify({
        id: 'test', name: 'stream.mp4', path: 'C:\\Streams\\stream.mp4', fps: 60,
        ranges: [{start_frame: 600, end_frame: 1800}]
      })); }};
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../cep/index.html')).href);
    assert.equal(await page.locator('#apply').isDisabled(), true);
    assert.equal(await page.locator('#jumpNest').isChecked(), false);
    assert.equal(await page.locator('#gap').inputValue(), '30');
    assert.equal(await page.locator('#min_speech').inputValue(), '40');
    assert.equal(await page.locator('#voiceProfile').inputValue(), 'streamer-main.json');
    assert.equal(await page.locator('#voiceSetup').getAttribute('open'), null);
    await page.evaluate(() => { window.testHostError = 'EvalScript error.'; });
    await page.locator('#source').click();
    assert.match(await page.locator('#status').innerText(), /EvalScript error/);
    assert.doesNotMatch(await page.locator('#status').innerText(), /Unexpected token/);
    assert.match(await page.evaluate(() => window.lastHostFile), /apiVersion/);
    assert.match(await page.evaluate(() => window.lastHostScript), /evalFile/);
    const bridgeFixture = await page.evaluate(() => window.lastHostFile);
    const fixturePath = path.resolve(__dirname, '../test-output/bridge-fixture.jsx');
    fs.mkdirSync(path.dirname(fixturePath), {recursive: true});
    fs.writeFileSync(fixturePath, bridgeFixture.replace(/new File\("\/data\/bridge\/[^"\n]+\.response"\)/,
      'new File(' + JSON.stringify(path.resolve(__dirname, '../test-output/bridge-fixture.response').replace(/\\/g, '/')) + ')'));
    await page.evaluate(() => { window.testHostError = null; });
    assert.equal(await page.locator('#jumpApply').isDisabled(), true);
    await page.locator('#jumpAnalyze').click();
    await page.waitForFunction(() => window.testRequest && !document.querySelector('#jumpAnalyze').disabled);
    assert.deepEqual(await page.evaluate(() => window.testRequest.settings), {noise: -45, minimum: .6, padding: .1});
    assert.deepEqual(await page.evaluate(() => window.testRequest.ranges), [{start_frame: 600, end_frame: 1800}]);
    assert.equal(await page.locator('#jumpApply').isDisabled(), true);
    await page.locator('#source').click();
    await page.locator('#analyze').click();
    await page.waitForFunction(() => window.testRequest && !document.querySelector('#analyze').disabled);
    assert.equal(await page.evaluate(() => window.testRequest.profile), '/voices/streamer-main.json');
    assert.equal(await page.evaluate(() => window.testRequest.settings.min_speech), 40);
    assert.deepEqual(await page.evaluate(() => window.testRequest.references), []);
    await page.locator('#voiceProfile').selectOption('');
    await page.locator('#refStart').fill('00:11:15');
    await page.locator('#refEnd').fill('00:11:45');
    await page.locator('#addRef').click();
    assert.equal(await page.locator('#refs li').count(), 1);
    await page.locator('#refEnd').fill('00:13:00');
    await page.locator('#addRef').click();
    assert.equal(await page.locator('#refs li').count(), 1);
    assert.match(await page.locator('#status').innerText(), /от 3 до 60/);
    await page.locator('#refStart').fill('00:11:45');
    await page.locator('#refEnd').fill('00:12:15');
    await page.locator('#addRef').click();
    await page.locator('#refStart').fill('00:12:15');
    await page.locator('#refEnd').fill('00:12:47');
    await page.locator('#addRef').click();
    assert.equal(await page.locator('#refs li').count(), 3);
    await page.locator('#voiceProfile').selectOption('streamer-main.json');
    await page.evaluate(() => { document.querySelector('#status').textContent = 'Готов к анализу'; document.querySelector('#status').className = ''; });
    const output = path.resolve(__dirname, '../test-output/panel.png');
    fs.mkdirSync(path.dirname(output), {recursive: true});
    await page.screenshot({path: output, fullPage: true});
    assert.deepEqual(errors, []);
    const choices = {threshold: '0.63', gap: '24', padding: '0.3', min_speech: '55',
      jumpMinimum: '0.9', jumpPadding: '0.15', jumpNoise: '-51'};
    for (const [id, value] of Object.entries(choices)) {
      await page.locator('#' + id).fill(value);
    }
    await page.locator('#label').selectOption('13');
    await page.locator('#jumpNest').check();
    // Incomplete input during typing must not erase the last valid choice.
    await page.locator('#gap').fill('');
    await page.reload();
    for (const [id, value] of Object.entries(choices)) {
      assert.equal(await page.locator('#' + id).inputValue(), value);
    }
    assert.equal(await page.locator('#label').inputValue(), '13');
    assert.equal(await page.locator('#jumpNest').isChecked(), true);
    assert.equal(await page.locator('#thresholdValue').innerText(), '0.63');
    await page.evaluate(() => localStorage.setItem('svm.settings.v1', '{broken'));
    await page.reload();
    assert.equal(await page.locator('#gap').inputValue(), '30');
    assert.deepEqual(errors, []);
    console.log('Panel smoke passed:', output);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
