/* ES3 only. Independent subclips keep labels isolated from the original item. */
// Capture before nested evalFile calls: CEP may evaluate ScriptPath without a useful $.fileName.
var svmExtensionRoot = $._SVMExtensionRoot || new File($.fileName).parent.fsName;
if (typeof JSON === 'undefined') { $.evalFile(new File(svmExtensionRoot + '/vendor/json2.js')); }
if (typeof $._SVMJump === 'undefined') { $.evalFile(new File(svmExtensionRoot + '/jump-timeline.jsx')); }
$._SVM = (function () {
    var state = null;
    var TPS = 254016000000;
    function reply(value) { return JSON.stringify(value); }
    function fail(error) { return reply({error: String(error)}); }
    function find(item, id) {
        if (String(item.nodeId) === String(id)) { return item; }
        if (item.children) {
            for (var i = 0; i < item.children.numItems; i++) {
                var match = find(item.children[i], id);
                if (match) { return match; }
            }
        }
        return null;
    }
    function validSource(item) {
        if (!item || !item.getMediaPath || item.isSequence()) { throw new Error('Выберите обычный видеофайл.'); }
        var path = item.getMediaPath();
        if (!path || !new File(path).exists) { throw new Error('Исходный файл недоступен.'); }
        return {id: String(item.nodeId), name: item.name, path: path, project: app.project.path,
                fps: item.getFootageInterpretation().frameRate};
    }
    function readPlan(path) {
        var file = new File(path);
        file.encoding = 'UTF8';
        if (!file.open('r')) { throw new Error('Не удалось открыть результат анализа.'); }
        var content = file.read(); file.close();
        var plan = JSON.parse(content);
        if (plan.schema !== 1 || !plan.parts || !plan.parts.length || plan.parts.length > 20000 ||
            !isFinite(plan.fps) || plan.fps < 1 || plan.fps > 240 ||
            !isFinite(plan.total_frames) || plan.total_frames < 1 || plan.total_frames !== Math.floor(plan.total_frames)) {
            throw new Error('Неверный формат плана.');
        }
        var cursor = 0;
        for (var i = 0; i < plan.parts.length; i++) {
            var p = plan.parts[i];
            if ((plan.mode !== 'jumpcut' && p.start_frame !== cursor) ||
                !isFinite(p.start_frame) || p.start_frame < 0 || p.start_frame !== Math.floor(p.start_frame) ||
                !isFinite(p.end_frame) || p.end_frame <= p.start_frame ||
                p.end_frame !== Math.floor(p.end_frame) || typeof p.speech !== 'boolean') {
                throw new Error('План содержит разрыв или неверные границы.');
            }
            if (plan.mode === 'jumpcut') {
                if (!isFinite(plan.source_frames) || p.end_frame > plan.source_frames) { throw new Error('Неверные границы исходника.'); }
                cursor += p.end_frame - p.start_frame;
            } else { cursor = p.end_frame; }
        }
        if (cursor !== plan.total_frames) { throw new Error('План покрывает не весь исходник.'); }
        return plan;
    }
    return {
        apiVersion: '0.6.2',
        jumpSelection: function () {
            try {
                var seq = app.project.activeSequence;
                if (!seq) { throw new Error('Откройте последовательность и выделите видеоклипы.'); }
                var selected = seq.getSelection(), clips = [], source = null, i, j, t;
                for (i = 0; i < selected.length; i++) {
                    var clip = selected[i];
                    if (clip.mediaType !== 'Video') { continue; }
                    var candidate = validSource(clip.projectItem);
                    if (source && candidate.path.toLowerCase() !== source.path.toLowerCase()) { throw new Error('Выделите клипы одного исходного файла.'); }
                    source = candidate;
                    if (clip.getSpeed() !== 1 || clip.isSpeedReversed()) { throw new Error('Jump Cut поддерживает обычную скорость 100%.'); }
                    clips.push(clip);
                }
                if (!clips.length) { throw new Error('Выделите видеоклипы на таймлайне.'); }
                clips.sort(function(a,b) { return a.start.seconds - b.start.seconds; });
                var ranges = [], tolerance = 1.1/source.fps;
                for (i = 0; i < clips.length; i++) {
                    var c = clips[i], found = false;
                    if (i && c.start.seconds < clips[i-1].end.seconds - tolerance) {
                        var previous=clips[i-1];
                        if(Math.abs(c.start.seconds-previous.start.seconds)<tolerance && Math.abs(c.end.seconds-previous.end.seconds)<tolerance &&
                           Math.abs(c.inPoint.seconds-previous.inPoint.seconds)<tolerance) { continue; }
                        throw new Error('Перекрывающиеся видеослои должны иметь одинаковые границы и исходное время.');
                    }
                    for (t = 0; t < seq.audioTracks.numTracks; t++) {
                        var track = seq.audioTracks[t];
                        for (j = 0; j < track.clips.numItems; j++) {
                            var a = track.clips[j];
                            if (a.end.seconds <= c.start.seconds || a.start.seconds >= c.end.seconds) { continue; }
                            if (!a.projectItem || a.projectItem.getMediaPath().toLowerCase() !== source.path.toLowerCase() ||
                                a.getSpeed() !== 1 || a.isSpeedReversed() ||
                                Math.abs((a.inPoint.seconds-a.start.seconds)-(c.inPoint.seconds-c.start.seconds)) > tolerance) {
                                throw new Error('На выбранном участке есть дополнительный или смещённый звук. Используйте клипы с исходным звуком.');
                            }
                            if (a.start.seconds <= c.start.seconds + tolerance && a.end.seconds >= c.end.seconds - tolerance) { found = true; }
                        }
                    }
                    if (!found) { throw new Error('У выбранного видео должен быть полный синхронный исходный звук.'); }
                    ranges.push({start_frame: Math.round(c.inPoint.seconds*source.fps), end_frame: Math.round(c.outPoint.seconds*source.fps), timeline_start_frame: Math.round(c.start.seconds*source.fps)});
                }
                source.ranges = ranges;
                return reply($._SVMJump.capture(source));
            } catch(e) { return fail(e); }
        },
        jumpBegin: function(source,path,inPlace) { return $._SVMJump.begin(source,path,inPlace); },
        nestBlock: function(sequenceId,block) { return $._SVMNestBlock(sequenceId,block); },
        jumpStep: function() { return $._SVMJump.step(); },
        jumpFinish: function() { return $._SVMJump.finish(); },
        jumpAbort: function() { return $._SVMJump.abort(); },
        source: function () {
            try {
                var seq = app.project.activeSequence, items, item = null, i;
                if (seq) {
                    items = seq.getSelection();
                    for (i = 0; i < items.length; i++) {
                        if (items[i].mediaType === 'Video') {
                            if (item && item.nodeId !== items[i].projectItem.nodeId) { throw new Error('Выделите один исходник.'); }
                            item = items[i].projectItem;
                        }
                    }
                }
                if (!item) {
                    items = app.getCurrentProjectViewSelection();
                    if (items && items.length === 1) { item = items[0]; }
                }
                return reply(validSource(item));
            } catch(e) { return fail(e); }
        },
        begin: function (sourceId, resultPath, label) {
            try {
                if (state) { throw new Error('Сборка уже выполняется.'); }
                var item = find(app.project.rootItem, sourceId), source = validSource(item);
                var plan = readPlan(resultPath);
                if (Math.abs(source.fps - plan.fps)/plan.fps > 0.00001) { throw new Error('Частота кадров исходника изменилась. Повторите анализ.'); }
                if (new File(source.path).fsName.toLowerCase() !== new File(plan.source).fsName.toLowerCase()) {
                    throw new Error('Результат относится к другому исходнику.');
                }
                if (new File(source.path).length !== plan.source_size) { throw new Error('Размер исходника изменился. Повторите анализ.'); }
                if (plan.source_mtime_ms && Math.abs(new File(source.path).modified.getTime() - plan.source_mtime_ms) > 2000) {
                    throw new Error('Дата изменения исходника изменилась. Повторите анализ.');
                }
                if (label !== 5 && label !== 13) { throw new Error('Неверная цветовая метка.'); }
                var stamp = String(new Date().getTime());
                var bin = app.project.rootItem.createBin('SVM ' + stamp);
                if (!bin) { throw new Error('Не удалось создать папку проекта.'); }
                if (plan.mode === 'jumpcut') {
                    // Import a fresh master: selected items may themselves be bounded subclips.
                    if (!app.project.importFiles([source.path], true, bin, false) || !bin.children.numItems) {
                        throw new Error('Не удалось импортировать исходник для Jump Cut.');
                    }
                    item = bin.children[0];
                }
                state = {source: item, plan: plan, label: label, bin: bin, clips: [], index: 0,
                         project: app.project.documentID, name: (plan.mode === 'jumpcut' ? 'Jump Cut — ' : 'SVM — ') + item.name + ' — ' + stamp};
                return reply({count: plan.parts.length});
            } catch(e) { return fail(e); }
        },
        step: function () {
            try {
                if (!state || app.project.documentID !== state.project) { throw new Error('Проект изменился.'); }
                var s = state, stop = Math.min(s.index + 15, s.plan.parts.length);
                for (; s.index < stop; s.index++) {
                    var p = s.plan.parts[s.index];
                    var start = String(Math.round(p.start_frame / s.plan.fps * TPS));
                    var end = String(Math.round(p.end_frame / s.plan.fps * TPS));
                    var name = (s.plan.mode === 'jumpcut' ? 'JUMP ' : (p.speech ? 'VOICE ' : 'WATCH ')) + ('00000' + (s.index+1)).slice(-5);
                    var sub = s.source.createSubClip(name, start, end, 0, 1, 1);
                    if (!sub) { throw new Error('Не удалось создать подклип ' + name); }
                    sub.setColorLabel(p.speech ? s.label : 4);
                    sub.moveBin(s.bin);
                    s.clips.push(sub);
                }
                return reply({done: s.index === s.plan.parts.length, completed: s.index, total: s.plan.parts.length});
            } catch(e) { state = null; return fail(e); }
        },
        finish: function () {
            try {
                if (!state || app.project.documentID !== state.project || state.index !== state.plan.parts.length) {
                    throw new Error('Подклипы ещё не готовы либо проект изменился.');
                }
                var s = state;
                var seq = app.project.createNewSequenceFromClips(s.name, s.clips, s.bin);
                if (!seq) { throw new Error('Premiere не создал последовательность.'); }
                seq.name = s.name;
                var expected = s.plan.total_frames / s.plan.fps;
                var actual = Number(seq.end) / TPS;
                var verification = Math.abs(actual-expected) <= 1.1/s.plan.fps;
                var videos = seq.videoTracks[0].clips;
                var timelineFrames = 0;
                for (var pi = 0; pi < s.plan.parts.length; pi++) {
                    var part = s.plan.parts[pi];
                    part.timeline_start = timelineFrames;
                    timelineFrames += part.end_frame - part.start_frame;
                    part.timeline_end = timelineFrames;
                }
                if (videos.numItems !== s.plan.parts.length) { verification = false; }
                for (var i = 0; i < videos.numItems && i < s.plan.parts.length; i++) {
                    var p = s.plan.parts[i], clip = videos[i], tolerance = 1.1 / s.plan.fps;
                    if (Math.abs(clip.start.seconds - p.timeline_start/s.plan.fps) > tolerance ||
                        Math.abs(clip.end.seconds - p.timeline_end/s.plan.fps) > tolerance ||
                        Math.abs(clip.inPoint.seconds - p.start_frame/s.plan.fps) > tolerance ||
                        Math.abs(clip.outPoint.seconds - p.end_frame/s.plan.fps) > tolerance ||
                        clip.projectItem.getColorLabel() !== (p.speech ? s.label : 4)) { verification = false; }
                }
                var audioFound = false;
                for (var track = 0; track < seq.audioTracks.numTracks; track++) {
                    var audios = seq.audioTracks[track].clips;
                    if (!audios.numItems) { continue; }
                    audioFound = true;
                    if (audios.numItems !== s.plan.parts.length) { verification = false; }
                    for (var a = 0; a < audios.numItems && a < s.plan.parts.length; a++) {
                        var ap = s.plan.parts[a], ac = audios[a];
                        if (Math.abs(ac.start.seconds-ap.timeline_start/s.plan.fps) > 1.1/s.plan.fps ||
                            Math.abs(ac.end.seconds-ap.timeline_end/s.plan.fps) > 1.1/s.plan.fps ||
                            Math.abs(ac.inPoint.seconds-ap.start_frame/s.plan.fps) > 1.1/s.plan.fps ||
                            Math.abs(ac.outPoint.seconds-ap.end_frame/s.plan.fps) > 1.1/s.plan.fps ||
                            ac.projectItem.getColorLabel() !== (ap.speech ? s.label : 4)) { verification = false; }
                    }
                }
                if (!audioFound) { verification = false; }
                app.project.openSequence(seq.sequenceID);
                state = null;
                return reply({name: seq.name, id: seq.sequenceID, verified: verification, expected: expected, actual: actual});
            } catch(e) { state = null; return fail(e); }
        },
        abort: function () { state = null; return reply({ok:true}); }
    };
}());
