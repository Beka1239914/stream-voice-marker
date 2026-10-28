"""Local-only speech matching worker. JSON-lines progress, resumable chunk cache."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from fractions import Fraction

from core import make_plan, number
from voices import MODEL, load_profile, fingerprint, validate_profile

VERSION = 'ecapa-silero-2'
RATE = 16000


def emit(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def run(args):
    result = subprocess.run(args, capture_output=True, creationflags=0x08000000 if os.name == 'nt' else 0)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[-3000:])
    return result.stdout


def probe(path, ffprobe):
    info = json.loads(run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))
    video = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
    if not video or not any(s['codec_type'] == 'audio' for s in info['streams']):
        raise ValueError('Нужен видеофайл с аудиодорожкой.')
    fps = float(Fraction(video.get('r_frame_rate', '0/1')))
    duration = float(video.get('duration') or info['format']['duration'])
    number(fps, 'fps', 1, 240)
    number(duration, 'duration', .001, 86400)
    # FFmpeg -ss is relative to container start by default, not absolute PTS.
    # Premiere source times start at the first video frame. Account for streams
    # whose start differs from the container, without adding the TS timestamp twice.
    container_start = float(info['format'].get('start_time', 0))
    video_start = float(video.get('start_time', container_start))
    seek_offset = video_start - container_start
    number(seek_offset, 'video/container offset', 0, 86400)
    return duration, fps, int(video['nb_frames']) if video.get('nb_frames', '').isdigit() else None, seek_offset


def extract_audio(source, start, length, ffmpeg='ffmpeg', stream=0, seek_offset=0):
    return run([ffmpeg, '-v', 'error', '-nostdin',
                '-ss', str(start + seek_offset), '-i', str(source), '-t', str(length),
                '-map', '0:a:' + str(stream), '-vn',
                '-af', 'aresample=async=1:first_pts=0,apad',
                '-ac', '1', '-ar', str(RATE), '-f', 'f32le', 'pipe:1'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('request', type=Path)
    parser.add_argument('--replan', action='store_true')
    parser.add_argument('--enroll', action='store_true', help='Save a reusable voice profile, without analyzing the whole video')
    args = parser.parse_args()
    cfg = json.loads(args.request.read_text(encoding='utf-8-sig'))
    source = Path(cfg['source']).resolve(strict=True)
    output = Path(cfg['output']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    duration, fps, frame_count, seek_offset = probe(source, cfg.get('ffprobe', 'ffprobe'))
    if cfg.get('premiere_fps'):
        premiere_fps = number(cfg['premiere_fps'], 'Premiere fps', 1, 240)
        if abs(premiere_fps-fps)/fps > .001:
            raise ValueError('В Premiere переопределена частота кадров. Используйте исходную интерпретацию файла.')
        fps = premiere_fps
    if frame_count:
        frame_duration = frame_count / fps
        if abs(frame_duration-duration) > max(.1, duration*.001):
            raise ValueError('Переменная частота кадров сильно меняет длительность. Сначала конвертируйте запись в постоянную частоту кадров.')
        duration = frame_duration
    if args.enroll and args.replan:
        raise ValueError('Нельзя одновременно сохранять голос и пересчитывать отбор.')
    profile = load_profile(cfg['profile']) if cfg.get('profile') and not args.enroll else None
    refs = [] if profile else cfg.get('references', [])
    if not profile and (not refs or len(refs) > 20):
        raise ValueError('Выберите 1–20 образцов чистого голоса.')
    for ref in refs:
        a = number(ref['start'], 'reference start', 0, duration)
        b = number(ref['end'], 'reference end', a, duration)
        if not 3 <= b-a <= 60:
            raise ValueError('Каждый образец должен длиться от 3 до 60 секунд.')
    stat = source.stat()
    identity = {'version': VERSION, 'source': str(source), 'size': stat.st_size,
                'mtime': stat.st_mtime_ns, 'refs': refs, 'fps': fps, 'duration': duration,
                'audio_stream': int(cfg.get('audio_stream', 0))}
    if profile:
        identity['voice_fingerprint'] = fingerprint(profile)
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
    cache = output / 'cache' / key
    cache.mkdir(parents=True, exist_ok=True)
    scores_path = cache / 'scores.json'
    if scores_path.exists() and not args.enroll:
        scores = json.loads(scores_path.read_text(encoding='utf-8'))
        emit(stage='cache', progress=95, message='Использую сохранённый анализ')
    else:
        if args.replan:
            raise ValueError('Сначала выполните полный анализ с этими образцами.')
        emit(stage='models', progress=0, message='Загрузка моделей (при первом запуске нужен интернет)')
        model_root = Path(__file__).resolve().parents[1] / 'data' / 'models'
        os.environ.setdefault('HF_HOME', str(model_root / 'huggingface'))
        import numpy as np
        import torch
        import torch.nn.functional as F
        from silero_vad import load_silero_vad, get_speech_timestamps
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import LocalStrategy
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        device = cfg.get('device', 'cpu')
        if device not in ('cpu', 'cuda'):
            raise ValueError('device must be cpu or cuda')
        # ONNX also avoids TorchScript's Windows fopen failure on Cyrillic paths.
        vad = load_silero_vad(onnx=True)
        encoder = EncoderClassifier.from_hparams(
            source='speechbrain/spkrec-ecapa-voxceleb',
            savedir=str(model_root / 'ecapa'),
            run_opts={'device': device}, local_strategy=LocalStrategy.COPY)

        def audio(start, length):
            raw = extract_audio(source, start, length, cfg.get('ffmpeg', 'ffmpeg'),
                                identity['audio_stream'], seek_offset)
            return torch.from_numpy(np.frombuffer(raw, dtype='<f4').copy())

        def embedding(samples):
            with torch.inference_mode():
                return F.normalize(encoder.encode_batch(samples.unsqueeze(0).to(device)).reshape(-1), dim=0)

        if profile:
            reference = torch.tensor(profile['embedding'], dtype=torch.float32, device=device)
            emit(stage='voice', message='Использую сохранённый голос: ' + profile['name'])
        else:
            vectors = []
            for ref in refs:
                samples = audio(ref['start'], ref['end']-ref['start'])
                spans = get_speech_timestamps(samples, vad, sampling_rate=RATE)
                voiced = torch.cat([samples[s['start']:s['end']] for s in spans]) if spans else torch.empty(0)
                if len(voiced) < 2 * RATE:
                    raise ValueError('В одном из образцов слишком мало речи. Выберите чистую реплику стримера.')
                for start in range(0, len(voiced), 3*RATE):
                    piece = voiced[start:start+3*RATE]
                    if len(piece) >= RATE:
                        vectors.append(embedding(piece))
            reference = F.normalize(torch.stack(vectors).mean(dim=0), dim=0)
        if args.enroll:
            destination = Path(cfg['enroll_path']).resolve()
            if destination.exists():
                raise ValueError('Такой профиль уже существует. Сохраните под новым именем.')
            voice = {'schema': 1, 'model': MODEL, 'sample_rate': RATE,
                     'name': str(cfg.get('voice_name', 'Мой стример')).strip()[:80],
                     'embedding': reference.cpu().tolist(), 'reference_seconds': sum(r['end']-r['start'] for r in refs)}
            validate_profile(voice)
            if source.stat().st_mtime_ns != stat.st_mtime_ns or source.stat().st_size != stat.st_size:
                raise ValueError('Исходник изменился во время создания профиля.')
            save(destination, voice)
            emit(stage='enrolled', progress=100, profile=str(destination), name=voice['name'])
            return
        scores = []
        # Independent 60-second cores + context: bounded memory even for four-hour streams.
        for chunk, core_start in enumerate(range(0, int(duration)+1, 60)):
            if core_start >= duration:
                break
            chunk_path = cache / f'chunk-{chunk:05d}.json'
            if chunk_path.exists():
                rows = json.loads(chunk_path.read_text(encoding='utf-8'))
            else:
                left, right = max(0, core_start-3), min(duration, core_start+63)
                samples = audio(left, right-left)
                spans = get_speech_timestamps(samples, vad, sampling_rate=RATE,
                                              min_speech_duration_ms=250, min_silence_duration_ms=200)
                rows = []
                # Fixed global cells avoid double counting across chunk boundaries.
                cell_start = float(core_start)
                while cell_start < min(core_start+60, duration):
                    cell_end = min(cell_start+.75, core_start+60, duration)
                    a, b = int((cell_start-left)*RATE), int((cell_end-left)*RATE)
                    overlap = sum(max(0, min(b, s['end'])-max(a, s['start'])) for s in spans)
                    if overlap >= .25*(b-a):
                        mid = (a+b)//2
                        lo, hi = max(0, mid-int(1.25*RATE)), min(len(samples), mid+int(1.25*RATE))
                        if hi-lo >= RATE//2:
                            score = float(torch.dot(reference, embedding(samples[lo:hi])).cpu())
                            rows.append({'start': cell_start, 'end': cell_end, 'score': score})
                    cell_start = cell_end
                save(chunk_path, rows)
            scores.extend(rows)
            emit(stage='analyze', progress=min(95, round(95*min(core_start+60, duration)/duration, 1)),
                 message=f'Обработано {min(core_start+60, duration)/60:.1f} / {duration/60:.1f} мин')
        save(scores_path, scores)
    plan = make_plan(scores, duration, fps, **cfg.get('settings', {}))
    current_stat = source.stat()
    if current_stat.st_size != stat.st_size or current_stat.st_mtime_ns != stat.st_mtime_ns:
        raise ValueError('Исходник изменился во время анализа. Запустите обработку снова.')
    plan.update({'schema': 1, 'source': str(source), 'source_size': stat.st_size,
                 'source_mtime_ns': stat.st_mtime_ns, 'source_mtime_ms': stat.st_mtime_ns//1000000,
                 'duration': duration, 'cache_key': key, 'references': refs, 'settings': cfg.get('settings', {})})
    if profile:
        plan['voice_profile'] = {'path': str(Path(cfg['profile']).resolve()), 'name': profile['name'],
                                 'fingerprint': fingerprint(profile)}
    save(output / 'result.json', plan)
    emit(stage='done', progress=100, result=str(output/'result.json'),
         speech_count=plan['speech_count'], speech_seconds=plan['speech_seconds'])


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    try:
        main()
    except Exception as exc:
        emit(stage='error', message=str(exc))
        sys.exit(1)
