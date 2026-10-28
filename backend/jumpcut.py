"""Remove quiet intervals from selected source ranges; never classify speech."""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from analyze import emit, probe, run, save
from core import number


def detect_peak(source, start, length, noise, minimum, ffmpeg, offset=0):
    # Keep channels separate: a stereo downmix can cancel opposite-phase sound.
    cmd = [ffmpeg, '-hide_banner', '-nostdin', '-nostats', '-ss', str(start + offset),
           '-i', str(source), '-t', str(length), '-map', '0:a:0', '-vn',
           '-af', f'aresample=async=1:first_pts=0,apad,atrim=duration={length},'
                  f'silencedetect=noise={noise}dB:d={minimum}:mono=0',
           '-f', 'null', '-']
    proc = subprocess.run(cmd, capture_output=True, creationflags=0x08000000 if os.name == 'nt' else 0)
    log = proc.stderr.decode('utf-8', errors='replace')
    if proc.returncode:
        raise RuntimeError(log[-3000:])
    intervals, beginning = [], None
    for kind, value in re.findall(r'silence_(start|end):\s*([-+0-9.eE]+)', log):
        value = max(0, min(length, float(value)))
        if kind == 'start':
            beginning = value
        elif beginning is not None:
            intervals.append((beginning, value))
            beginning = None
    if beginning is not None:
        intervals.append((beginning, length))
    return intervals


def detect(source, start, length, noise, minimum, ffmpeg, offset=0):
    """20-ms RMS per channel; a single peak no longer preserves a quiet island."""
    cmd = [ffmpeg, '-v', 'error', '-nostdin', '-ss', str(start + offset),
           '-i', str(source), '-map', '0:a:0', '-vn', '-t', str(length),
           '-af', f'aresample=16000:async=1:first_pts=0,apad,atrim=duration={length},'
                  'asetnsamples=n=320,astats=metadata=1:reset=1:'
                  'measure_perchannel=RMS_level:measure_overall=none,'
                  'ametadata=mode=print:file=-', '-f', 'null', os.devnull]
    intervals, quiet, frame, levels = [], None, None, []

    def consume(position, values):
        nonlocal quiet
        if position is None or position >= length:
            return
        if not values:
            raise RuntimeError('FFmpeg не вернул уровень громкости.')
        # Preserve sound in ANY channel, including opposite-phase stereo.
        if max(values) < noise:
            if quiet is None:
                quiet = position
        elif quiet is not None:
            if position - quiet >= minimum - 1e-7:
                intervals.append((quiet, position))
            quiet = None

    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors,
                                creationflags=0x08000000 if os.name == 'nt' else 0)
        try:
            for raw in proc.stdout:
                line = raw.decode('utf-8', errors='replace').strip()
                if line.startswith('frame:'):
                    consume(frame, levels)
                    frame = float(line.split('pts_time:')[1])
                    levels = []
                elif '.RMS_level=' in line:
                    levels.append(float(line.split('=', 1)[1]))
            consume(frame, levels)
            code = proc.wait()
            if code:
                errors.seek(0)
                raise RuntimeError(errors.read().decode('utf-8', errors='replace')[-3000:])
            if frame is None:
                raise RuntimeError('Не удалось измерить звук выбранного участка.')
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            proc.stdout.close()
    if quiet is not None and length - quiet >= minimum - 1e-7:
        intervals.append((quiet, length))
    return intervals


def keep_frames(start, end, silences, fps, padding):
    cursor, kept = start, []
    for a, b in silences:
        # Round inward so the cut cannot eat a neighbouring sound.
        left = max(start, math.ceil(start + (a + padding) * fps - 1e-7))
        right = min(end, math.floor(start + (b - padding) * fps + 1e-7))
        if right <= left:
            continue
        if left > cursor:
            kept.append({'start_frame': cursor, 'end_frame': left, 'speech': True})
        cursor = max(cursor, right)
    if cursor < end:
        kept.append({'start_frame': cursor, 'end_frame': end, 'speech': True})
    return kept


def main():
    cfg = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
    source = Path(cfg['source']).resolve(strict=True)
    before = source.stat()
    duration, nominal, frame_count, offset = probe(source, cfg['ffprobe'])
    fps = number(cfg['premiere_fps'], 'fps', 1, 240)
    if abs(fps - nominal) / nominal > .001:
        raise ValueError('Нужна исходная частота кадров без переинтерпретации.')
    info = json.loads(run([cfg['ffprobe'], '-v', 'error', '-show_streams', '-of', 'json', str(source)]))
    if sum(s['codec_type'] == 'audio' for s in info['streams']) != 1:
        raise ValueError('Jump Cut пока поддерживает файл с одним аудиопотоком (моно или многоканальным).')
    settings = cfg['settings']
    noise = number(settings['noise'], 'Уровень тишины', -80, -15)
    minimum = number(settings['minimum'], 'Минимальная пауза', .1, 30)
    padding = number(settings['padding'], 'Запас', 0, 2)
    if 2 * padding >= minimum:
        raise ValueError('Минимальная пауза должна быть больше двойного запаса.')
    ranges = cfg['ranges']
    if not ranges or len(ranges) > 2000:
        raise ValueError('Выделите от 1 до 2000 видеоклипов одного исходника.')
    limit = frame_count or round(duration * fps)
    parts, original = [], 0
    for i, span in enumerate(ranges):
        start = number(span['start_frame'], 'Начало', 0, limit)
        end = number(span['end_frame'], 'Конец', start + 1, limit)
        if int(start) != start or int(end) != end:
            raise ValueError('Границы должны совпадать с кадрами.')
        start, end = int(start), int(end)
        emit(stage='detect', progress=i / len(ranges) * 100,
             message=f'Поиск тишины: клип {i + 1} из {len(ranges)}')
        silences = detect(source, start / fps, (end - start) / fps, noise, minimum, cfg['ffmpeg'], offset)
        # Entirely silent clips contribute no boundary padding fragments.
        if not (len(silences) == 1 and silences[0][0] <= 1 / fps and silences[0][1] >= (end-start-1)/fps):
            kept = keep_frames(start, end, silences, fps, padding)
            for part in kept:
                part['range_index'] = i
            parts.extend(kept)
        original += end - start
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('Исходный файл изменился во время анализа.')
    total = sum(p['end_frame'] - p['start_frame'] for p in parts)
    plan = dict(schema=1, mode='jumpcut', source=str(source), source_size=after.st_size,
                source_mtime_ms=after.st_mtime_ns / 1e6, fps=fps, source_frames=limit,
                parts=parts, total_frames=total, original_frames=original,
                removed_seconds=(original-total)/fps, ranges=ranges, settings=settings)
    target = Path(cfg['output']) / 'jumpcut-result.json'
    save(target, plan)
    emit(stage='done', progress=100, result=str(target), message='Расчёт Jump Cut готов.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit(stage='error', message=str(exc))
        sys.exit(1)
