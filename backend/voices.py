"""Portable voice profiles: numeric embeddings, never executable model files."""
import hashlib
import json
import math
from pathlib import Path

MODEL = 'speechbrain/spkrec-ecapa-voxceleb'


def validate_profile(profile):
    if not isinstance(profile, dict):
        raise ValueError('Повреждён файл профиля голоса.')
    if profile.get('schema') != 1 or profile.get('model') != MODEL or profile.get('sample_rate') != 16000:
        raise ValueError('Несовместимая версия профиля голоса.')
    vector = profile.get('embedding')
    if not isinstance(vector, list) or len(vector) != 192:
        raise ValueError('Повреждён профиль голоса: ожидаются 192 значения.')
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in vector):
        raise ValueError('Повреждён профиль голоса: некорректные значения.')
    norm = math.sqrt(sum(x*x for x in vector))
    if abs(norm-1) > .001:
        raise ValueError('Повреждён профиль голоса: вектор не нормализован.')
    if not isinstance(profile.get('name'), str) or not profile['name'].strip():
        raise ValueError('У профиля голоса нет названия.')
    return profile


def fingerprint(profile):
    validate_profile(profile)
    payload = {key: profile[key] for key in ('schema', 'model', 'sample_rate', 'embedding')}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def load_profile(path):
    return validate_profile(json.loads(Path(path).read_text(encoding='utf-8-sig')))
