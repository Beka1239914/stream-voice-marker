/* CEP browser side. No shell interpolation, no network service, no external UI assets. */
(function () {
  'use strict';
  var nodeRequire = typeof require === 'function' ? require : window.cep_node.require;
  var fs = nodeRequire('fs'), path = nodeRequire('path'), childProcess = nodeRequire('child_process');
  var nodeProcess = nodeRequire('process');
  var root = path.dirname(decodeURIComponent(window.location.pathname).replace(/^\/([A-Za-z]:)/, '$1'));
  var configPath = path.join(root, 'runtime.json');
  var source = null, references = [], worker = null, result = null, analysisOutput = null, busy = false, stopped = false;
  var profiles = [];
  var jumpSource = null, jumpResult = null;
  var preferences = {};
  var preferenceIds = ['threshold', 'gap', 'padding', 'min_speech', 'label', 'jumpMinimum', 'jumpPadding', 'jumpNoise', 'jumpNest'];
  var $ = function (id) { return document.getElementById(id); };
  function status(message, error) { $('status').textContent = message; $('status').className = error ? 'error' : ''; }
  function validPreference(id, value) {
    if (typeof value !== 'string' || value.trim() === '') { return false; }
    if (id === 'jumpNest') { return value === 'true' || value === 'false'; }
    if (id === 'label') { return value === '5' || value === '13'; }
    var field = $(id), n = Number(value);
    return Number.isFinite(n) && n >= Number(field.min) && n <= Number(field.max);
  }
  function savePreferences() {
    preferenceIds.forEach(function (id) {
      var value = id === 'jumpNest' ? String($(id).checked) : $(id).value;
      if (validPreference(id, value)) { preferences[id] = value; }
    });
    try { localStorage.setItem('svm.settings.v1', JSON.stringify(preferences)); }
    catch (e) { status('Не удалось сохранить настройки: ' + e.message, true); }
  }
  function restorePreferences() {
    try {
      var saved = JSON.parse(localStorage.getItem('svm.settings.v1') || '{}');
      preferenceIds.forEach(function (id) {
        if (saved && validPreference(id, saved[id])) {
          if(id === 'jumpNest') { $(id).checked = saved[id] === 'true'; } else { $(id).value = saved[id]; }
          preferences[id] = saved[id];
        }
      });
    } catch (_) { /* Damaged settings must not prevent opening the panel. */ }
    $('thresholdValue').textContent = Number($('threshold').value).toFixed(2);
    preferenceIds.forEach(function (id) {
      $(id).addEventListener('input', savePreferences);
      $(id).addEventListener('change', savePreferences);
    });
  }
  function host(method, args) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__) { reject(new Error('Откройте панель внутри Premiere.')); return; }
      // Initialize in the panel's own ExtendScript context, not the connector's engine.
      // Version checks preserve an in-progress assembly between step calls.
      var script = '(function(){try{' +
        'if(typeof $._SVM === "undefined" || $._SVM.apiVersion !== "0.6.2" || typeof $._SVMJump === "undefined"){' +
        '$._SVMExtensionRoot=' + JSON.stringify(root) + ';' +
        '$.evalFile(new File(' + JSON.stringify(path.join(root, 'loader.jsx')) + '));' +
        'if($._SVMLoadError){throw new Error($._SVMLoadError);}}' +
        'return $._SVM.' + method + '(' + args.map(function (v) { return JSON.stringify(v); }).join(',') + ');' +
        '}catch(e){return "SVM_ERROR:"+String(e)+" (строка "+e.line+")";}}())';
      var responsePath, requestPath;
      try {
        var bridgeDir = path.join(runtime().data, 'bridge');
        fs.mkdirSync(bridgeDir, {recursive: true});
        var token = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
        requestPath = path.join(bridgeDir, token + '.jsx');
        responsePath = path.join(bridgeDir, token + '.response');
        // File transport avoids CEP's script-string encoding and response-size limits.
        // Keep each file until its callback; never reuse a previous response.
        var fileScript = 'var svmBridgeResponse=' + script + ';\n' +
          'var svmBridgeFile=new File(' + JSON.stringify(responsePath.replace(/\\/g, '/')) + ');\n' +
          'svmBridgeFile.encoding="UTF8";if(svmBridgeFile.open("w")){svmBridgeFile.write(svmBridgeResponse);svmBridgeFile.close();}\n' +
          '"SVM_BRIDGE_DONE";';
        fs.writeFileSync(requestPath, '\uFEFF' + fileScript, 'utf8');
        script = '$.evalFile(new File(' + JSON.stringify(requestPath.replace(/\\/g, '/')) + '))';
        script = script.replace(/[^\x00-\x7F]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); });
      } catch (e) { reject(new Error('Не удалось подготовить команду Premiere: ' + e.message)); return; }
      window.__adobe_cep__.evalScript(script, function (raw) {
        try {
          if (fs.existsSync(responsePath)) { raw = fs.readFileSync(responsePath, 'utf8').replace(/^\uFEFF/, ''); }
          fs.writeFileSync(path.join(path.dirname(requestPath), 'last-call.json'), JSON.stringify({method: method, response: raw, date: new Date().toISOString()}), 'utf8');
        } catch (e) { raw = 'Не удалось прочитать ответ Premiere: ' + e.message; }
        try { if (fs.existsSync(responsePath)) { fs.unlinkSync(responsePath); } fs.unlinkSync(requestPath); } catch (_) {}
        if (typeof raw !== 'string' || !/^\s*\{/.test(raw)) {
          reject(new Error('Premiere: ' + (String(raw || 'Нет ответа от Premiere').replace(/^SVM_ERROR:/, '')) +
            '\nЕсли ошибка повторяется, закройте и заново откройте панель плагина.')); return;
        }
        try { var value = JSON.parse(raw); if (value.error) { throw new Error(value.error); } resolve(value); }
        catch (e) { reject(new Error('Premiere: ' + e.message)); }
      });
    });
  }
  function lock(value) {
    busy = value;
    ['source', 'addRef', 'analyze', 'replan', 'threshold', 'gap', 'padding', 'refStart', 'refEnd', 'label', 'openResult', 'voiceProfile', 'voiceName', 'saveVoice', 'jumpAnalyze', 'jumpMinimum', 'jumpPadding', 'jumpNoise'].forEach(function (id) { $(id).disabled = value; });
    $('min_speech').disabled = value;
    $('jumpNest').disabled = value;
    $('cancel').disabled = !worker;
    $('apply').disabled = value || !result;
    $('jumpApply').disabled = value || !jumpResult || !jumpResult.plan.parts.length;
    $('jumpApplyHere').disabled = value || !jumpResult || !jumpResult.plan.parts.length;
    Array.prototype.forEach.call($('refs').querySelectorAll('button'), function (b) { b.disabled = value; });
  }
  function invalidate() { result = null; $('apply').disabled = true; $('summary').textContent = 'Параметры изменены. Выполните анализ или пересчитайте отбор.'; $('segments').textContent = ''; }
  function seconds(text) {
    var bits = text.trim().split(':');
    if (bits.length > 3 || !bits.every(function (s) { return /^\d+(\.\d+)?$/.test(s); })) { throw new Error('Введите время ЧЧ:ММ:СС или секунды.'); }
    if (bits.length > 1 && bits.slice(1).some(function (s) { return Number(s) >= 60; })) { throw new Error('Минуты и секунды должны быть меньше 60.'); }
    return bits.reduce(function (sum, value) { return sum * 60 + Number(value); }, 0);
  }
  function time(value) {
    var h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = Math.floor(value % 60);
    return [h, m, s].map(function (v) { return ('0' + v).slice(-2); }).join(':');
  }
  function drawRefs() {
    $('refs').textContent = '';
    references.forEach(function (ref, i) {
      var li = document.createElement('li'), remove = document.createElement('button');
      li.textContent = time(ref.start) + ' — ' + time(ref.end); remove.textContent = '×';
      remove.title = 'Убрать образец'; remove.onclick = function () { references.splice(i, 1); drawRefs(); invalidate(); };
      li.appendChild(remove); $('refs').appendChild(li);
    });
  }
  $('source').onclick = async function () {
    $('sourceName').textContent = 'Получаю выделенный клип из Premiere…';
    try { source = await host('source', []); analysisOutput = null; references = []; drawRefs(); invalidate(); $('sourceName').textContent = source.path; status(selectedVoice() ? 'Исходник выбран. Сохранённый голос готов к поиску.' : 'Исходник выбран. Добавьте образец голоса.'); }
    catch (e) { $('sourceName').textContent = e.message; status(e.message, true); }
  };
  $('addRef').onclick = function () {
    try {
      var a = seconds($('refStart').value), b = seconds($('refEnd').value);
      if (b-a < 3 || b-a > 60 || references.length >= 20) { throw new Error('Образец: от 3 до 60 секунд. Максимум 20 образцов.'); }
      references.push({start: a, end: b}); drawRefs(); invalidate();
    } catch (e) { status(e.message, true); }
  };
  $('threshold').oninput = function () { $('thresholdValue').textContent = Number(this.value).toFixed(2); invalidate(); };
  $('gap').oninput = $('padding').oninput = invalidate;
  $('min_speech').oninput = invalidate;
  function runtime() {
    if (!fs.existsSync(configPath)) { throw new Error('Не найдена настройка Python. Запустите install.ps1 из папки плагина.'); }
    return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  }
  function selectedVoice() {
    return profiles.find(function (p) { return p.file === $('voiceProfile').value; }) || null;
  }
  function describeVoice() {
    var voice = selectedVoice();
    $('voiceInfo').textContent = voice ? 'Голос «' + voice.name + '» готов. Новые образцы не нужны.' : 'Для разового анализа добавьте образцы из выбранной записи.';
    $('voiceSetup').open = !voice;
  }
  function reloadProfiles(preferred) {
    var cfg = runtime();
    profiles = [];
    if (fs.existsSync(cfg.profiles)) {
      fs.readdirSync(cfg.profiles).filter(function (name) { return /\.json$/i.test(name); }).sort().forEach(function (name) {
        try {
          var data = JSON.parse(fs.readFileSync(path.join(cfg.profiles, name), 'utf8').replace(/^\uFEFF/, ''));
          if (data.schema === 1 && typeof data.name === 'string' && Array.isArray(data.embedding) && data.embedding.length === 192) {
            profiles.push({file: name, path: path.join(cfg.profiles, name), name: data.name});
          }
        } catch (_) { /* A damaged profile never becomes an automatic fallback voice. */ }
      });
    }
    $('voiceProfile').textContent = '';
    profiles.forEach(function (voice) {
      var option = document.createElement('option'); option.value = voice.file; option.textContent = voice.name;
      $('voiceProfile').appendChild(option);
    });
    var manual = document.createElement('option'); manual.value = ''; manual.textContent = 'Образцы из текущего видео (разово)'; $('voiceProfile').appendChild(manual);
    var saved = localStorage.getItem('svm.voice');
    var wanted = preferred !== undefined ? preferred : (saved !== null ? saved : cfg.default_profile);
    $('voiceProfile').value = profiles.some(function (p) { return p.file === wanted; }) ? wanted : '';
    describeVoice();
  }
  $('voiceProfile').onchange = function () {
    localStorage.setItem('svm.voice', this.value); describeVoice(); invalidate();
  };
  function showResult(filename) {
    var plan = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    if (!source || plan.schema !== 1 || !Array.isArray(plan.parts) || !Number.isFinite(plan.fps) || plan.fps <= 0 ||
        path.resolve(plan.source).toLowerCase() !== path.resolve(source.path).toLowerCase()) {
      throw new Error('Выберите исходный клип, которому соответствует этот результат.');
    }
    result = {path: filename, plan: plan};
    analysisOutput = path.dirname(filename);
    if (Array.isArray(plan.references)) { references = plan.references; drawRefs(); }
    if (plan.voice_profile) {
      var matching = profiles.find(function (p) { return path.resolve(p.path).toLowerCase() === path.resolve(plan.voice_profile.path).toLowerCase(); });
      if (!matching) { throw new Error('Профиль этого результата не найден в библиотеке голосов.'); }
      $('voiceProfile').value = matching.file;
    } else { $('voiceProfile').value = ''; }
    describeVoice();
    if (plan.settings) {
      ['threshold', 'gap', 'padding', 'min_speech'].forEach(function (key) { if (plan.settings[key] !== undefined) { $(key).value = plan.settings[key]; } });
      $('min_speech').value = plan.settings.min_speech || 0;
      $('thresholdValue').textContent = Number($('threshold').value).toFixed(2);
    }
    $('summary').textContent = 'Моментов: ' + plan.speech_count + ' · вместе с паузами: ' + time(plan.speech_seconds);
    $('segments').textContent = '';
    plan.parts.filter(function (p) { return p.speech; }).slice(0, 200).forEach(function (p) {
      var row = document.createElement('div'); row.className = 'segment';
      row.textContent = time(p.start_frame/plan.fps) + ' — ' + time(p.end_frame/plan.fps);
      $('segments').appendChild(row);
    });
    status('Анализ готов. Можно создать последовательность или изменить порог и пересчитать отбор.');
    savePreferences();
  }
  $('openResult').onchange = function () {
    try { if (this.files.length) { showResult(this.files[0].path); lock(false); } }
    catch (e) { invalidate(); status(e.message, true); }
    this.value = '';
  };
  function launch(replan, enroll) {
    if (busy) { return; }
    try {
      var voice = selectedVoice();
      if (!source || ((!voice || enroll) && !references.length)) { throw new Error('Выберите исходник и сохранённый голос либо добавьте образцы.'); }
      var cfg = runtime();
      var output = enroll ? path.join(cfg.data, 'enrollment') : (analysisOutput || path.join(cfg.data, 'jobs', nodeRequire('crypto').createHash('sha256').update(source.path).digest('hex').slice(0, 20)));
      fs.mkdirSync(output, {recursive: true});
      var request = {source: source.path, premiere_fps: source.fps, references: references, output: output,
        ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe, device: 'cpu',
        settings: {threshold: Number($('threshold').value), gap: Number($('gap').value), padding: Number($('padding').value), minimum: .4, min_speech: Number($('min_speech').value)}};
      if (enroll) {
        if (!$('voiceName').value.trim()) { throw new Error('Введите название нового голоса.'); }
        request.enroll_path = path.join(cfg.profiles, 'voice-' + nodeRequire('crypto').randomBytes(8).toString('hex') + '.json');
        request.voice_name = $('voiceName').value.trim();
      } else if (voice) { request.profile = voice.path; }
      var requestPath = path.join(output, 'request.json');
      fs.writeFileSync(requestPath, JSON.stringify(request), 'utf8');
      result = null; stopped = false;
      var args = ['-u', cfg.worker, requestPath]; if (replan) { args.push('--replan'); }
      if (enroll) { args.push('--enroll'); }
      worker = childProcess.spawn(cfg.python, args, {windowsHide: true, shell: false,
        env: Object.assign({}, nodeProcess.env, {PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1'})});
      lock(true); $('progress').value = 0; status('Запуск обработки…');
      var pending = '', stderr = '', failure = '', completed = null, enrolled = null;
      worker.stdout.setEncoding('utf8'); worker.stderr.setEncoding('utf8');
      worker.stdout.on('data', function (data) {
        pending += data; var lines = pending.split('\n'); pending = lines.pop();
        lines.forEach(function (line) {
          if (!line.trim()) { return; }
          var event; try { event = JSON.parse(line); } catch (_) { return; }
          if (event.progress !== undefined) { $('progress').value = event.progress; }
          if (event.message) { status(event.message, event.stage === 'error'); }
          if (event.stage === 'error') { failure = event.message; }
          if (event.stage === 'done') { completed = event.result; }
          if (event.stage === 'enrolled') { enrolled = event.profile; }
        });
      });
      worker.stderr.on('data', function (data) { stderr = (stderr + data).slice(-5000); });
      worker.on('error', function (e) { failure = e.message; });
      worker.on('close', function (code) {
        worker = null;
        try {
          if (stopped) { status('Остановлено. Готовые минутные блоки сохранены; нажмите «Найти речь» для продолжения.'); }
          else if (code !== 0 || (!completed && !enrolled)) { status(failure || stderr || 'Обработка завершилась без результата.', true); }
          else if (enrolled) {
            reloadProfiles(path.basename(enrolled)); localStorage.setItem('svm.voice', $('voiceProfile').value);
            status('Новый голос сохранён и выбран. Теперь его можно использовать на других записях.');
          }
          else {
            showResult(completed);
          }
        } catch (e) { result = null; status(e.message, true); }
        lock(false);
      });
    } catch (e) { worker = null; lock(false); status(e.message, true); }
  }
  $('analyze').onclick = function () { launch(false); };
  $('replan').onclick = function () { launch(true); };
  $('saveVoice').onclick = function () { launch(false, true); };
  $('cancel').onclick = function () {
    if (worker) {
      stopped = true;
      var stopping = worker;
      childProcess.spawn('taskkill.exe', ['/PID', String(stopping.pid), '/T', '/F'], {windowsHide: true, shell: false})
        .on('error', function () { if (!stopping.killed) { stopping.kill(); } });
    }
  };
  async function applyPlan(chosenSource, chosenResult, inPlace) {
    if (!chosenResult || busy) { return; }
    lock(true);
    var timeline = chosenResult.plan.mode === 'jumpcut' && chosenSource.sequence_id;
    try {
      if (timeline) { await host('jumpBegin', [chosenSource, chosenResult.path, !!inPlace]); }
      else { await host('begin', [chosenSource.id, chosenResult.path, Number($('label').value)]); }
      var progress;
      do {
        progress = await host(timeline ? 'jumpStep' : 'step', []);
        status('Создание фрагментов: ' + progress.completed + ' / ' + progress.total);
        $('progress').value = progress.completed/progress.total*100;
      } while (!progress.done);
      var done = await host(timeline ? 'jumpFinish' : 'finish', []);
      if(timeline && $('jumpNest').checked) {
        if(!done.verified){throw new Error('Проверка нарезки не прошла. Упаковка в блоки отменена.');}
        for(var bi=0;bi<done.blocks.length;bi++) {
          $('jumpSummary').textContent='Сборка цельного блока '+(bi+1)+' / '+done.blocks.length;
          await host('nestBlock',[done.id,done.blocks[bi]]);
        }
      }
      var message = done.verified ? 'Готово: ' + done.name : 'Последовательность создана, но проверка границ не прошла. Проверьте её перед использованием.';
      status(message, !done.verified);
      if (chosenResult.plan.mode === 'jumpcut') { $('jumpSummary').textContent = message; }
      if(inPlace){jumpResult=null;}
    } catch (e) {
      await host(timeline ? 'jumpAbort' : 'abort', []).catch(function () {});
      status(e.message + (inPlace ? '\nОбработка внутри эпизода могла завершиться частично. Проверьте монтаж; изменения можно отменить командами Premiere.' : (timeline ? '\nНезавершённая копия Jump Cut может остаться в проекте. Исходный монтаж сохранён.' : '\nНезавершённые подклипы могут остаться в отдельной папке SVM.')), true);
      if(inPlace){jumpResult=null;}
    } finally { lock(false); }
  }
  $('apply').onclick = function () { applyPlan(source, result); };
  $('jumpApply').onclick = function () { applyPlan(jumpSource, jumpResult); };
  $('jumpApplyHere').onclick = function () { applyPlan(jumpSource, jumpResult, true); };
  ['jumpMinimum', 'jumpPadding', 'jumpNoise'].forEach(function (id) {
    $(id).oninput = function () { jumpResult = null; $('jumpApply').disabled = true; $('jumpApplyHere').disabled = true; $('jumpSummary').textContent = 'Настройки изменены. Повторите расчёт.'; };
  });
  $('jumpAnalyze').onclick = async function () {
    if (busy) { return; }
    lock(true); jumpResult = null;
    try {
      jumpSource = await host('jumpSelection', []);
      var cfg = runtime(), output = path.join(cfg.data, 'jumpcut', String(Date.now()));
      fs.mkdirSync(output, {recursive: true});
      var request = {source: jumpSource.path, premiere_fps: jumpSource.fps, ranges: jumpSource.ranges,
        output: output, ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe,
        settings: {noise: Number($('jumpNoise').value), minimum: Number($('jumpMinimum').value), padding: Number($('jumpPadding').value)}};
      var filename = path.join(output, 'request.json');
      fs.writeFileSync(filename, JSON.stringify(request), 'utf8');
      stopped = false;
      worker = childProcess.spawn(cfg.python, ['-u', path.join(path.dirname(cfg.worker), 'jumpcut.py'), filename],
        {windowsHide: true, shell: false, env: Object.assign({}, nodeProcess.env, {PYTHONIOENCODING: 'utf-8'})});
      lock(true); $('jumpSummary').textContent = 'Поиск тишины в выбранных клипах…';
      var pending = '', failure = '', completed = null;
      worker.stdout.setEncoding('utf8'); worker.stderr.setEncoding('utf8');
      worker.stdout.on('data', function (data) {
        pending += data; var lines = pending.split('\n'); pending = lines.pop();
        lines.forEach(function (line) {
          var event; try { event = JSON.parse(line); } catch (_) { return; }
          if (event.message) { $('jumpSummary').textContent = event.message; status(event.message, event.stage === 'error'); }
          if (event.progress !== undefined) { $('progress').value = event.progress; }
          if (event.stage === 'error') { failure = event.message; }
          if (event.stage === 'done') { completed = event.result; }
        });
      });
      worker.stderr.on('data', function (data) { failure = (failure + data).slice(-3000); });
      worker.on('error', function (e) { failure = e.message; });
      worker.on('close', function (code) {
        worker = null;
        try {
          if (stopped) { throw new Error('Расчёт Jump Cut остановлен.'); }
          if (code !== 0 || !completed) { throw new Error(failure || 'Не удалось рассчитать Jump Cut.'); }
          var plan = JSON.parse(fs.readFileSync(completed, 'utf8'));
          if (plan.mode !== 'jumpcut' || !Array.isArray(plan.parts)) { throw new Error('Неверный результат Jump Cut.'); }
          jumpResult = {path: completed, plan: plan};
          $('jumpSummary').textContent = plan.parts.length ?
            'Участков выбрано: ' + jumpSource.ranges.length + ' · фрагментов останется: ' + plan.parts.length +
            ' · удалится: ' + plan.removed_seconds.toFixed(1) + ' сек · итог: ' + time(plan.total_frames/plan.fps) + '. Можно создать последовательность.' :
            'Всё выделение оказалось тишиной. Уменьшите порог или выберите другие клипы.';
          status('Расчёт Jump Cut завершён. Результат — в блоке 5.');
        } catch (e) { jumpResult = null; $('jumpSummary').textContent = e.message; status(e.message, true); }
        lock(false);
      });
    } catch (e) { worker = null; lock(false); $('jumpSummary').textContent = e.message; status(e.message, true); }
  };
  window.addEventListener('beforeunload', function (e) {
    if (busy) { e.preventDefault(); e.returnValue = 'Выполняется обработка. Сначала остановите её.'; }
  });
  restorePreferences();
  try { reloadProfiles(); } catch (e) { status(e.message, true); }
}());
