"""Frame-aligned edit plans. No ML dependencies; independently testable."""
import math


def number(value, name, low, high):
    value = float(value)
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{name}: expected {low}..{high}')
    return value


def make_plan(scores, duration, fps, threshold=.55, gap=30, padding=.2, minimum=.4, min_speech=0):
    duration = number(duration, 'duration', .001, 86400)
    fps = number(fps, 'fps', 1, 240)
    threshold = number(threshold, 'threshold', -1, 1)
    gap = number(gap, 'gap', 0, 120)
    padding = number(padding, 'padding', 0, 5)
    minimum = number(minimum, 'minimum', 0, 10)
    min_speech = number(min_speech, 'min_speech', 0, 3600)
    # Include the final partial source frame once, never introduce gaps.
    total = max(1, round(duration * fps))
    merged = []
    for row in sorted(scores, key=lambda r: r['start']):
        start = number(row['start'], 'start', 0, duration)
        end = number(row['end'], 'end', start, duration)
        score = number(row['score'], 'score', -1.001, 1.001)
        if score < threshold or end <= start:
            continue
        if merged and start <= merged[-1][1] + gap:
            # Matching windows overlap: count their union, excluding pauses.
            merged[-1][2] += max(0, end - max(start, merged[-1][1]))
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end, end-start])
    ranges = []
    for start, end, spoken in merged:
        if end - start < minimum or spoken <= min_speech + 1e-9:
            continue
        a = max(0, math.floor((start - padding) * fps))
        b = min(total, math.ceil((end + padding) * fps))
        if ranges and a <= ranges[-1][1]:
            ranges[-1][1] = max(ranges[-1][1], b)
        elif b > a:
            ranges.append([a, b])
    parts, cursor = [], 0
    for start, end in ranges:
        if start > cursor:
            parts.append({'start_frame': cursor, 'end_frame': start, 'speech': False})
        parts.append({'start_frame': start, 'end_frame': end, 'speech': True})
        cursor = end
    if cursor < total:
        parts.append({'start_frame': cursor, 'end_frame': total, 'speech': False})
    return {'fps': fps, 'total_frames': total, 'parts': parts,
            'speech_count': len(ranges),
            'speech_seconds': sum(b-a for a, b in ranges)/fps}
