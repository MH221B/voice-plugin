import math


WEIGHTS = {"calm": -0.12, "excited": 0.18, "sad": -0.16,
           "reassuring": -0.08, "serious": -0.06}


def number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def delivery(emotions: dict[str, float], voice: str, speed: float) -> tuple[str, float]:
    if not isinstance(voice, str) or not voice.startswith(("af_", "am_", "bf_", "bm_")) or len(voice) <= 3:
        raise ValueError("invalid English voice")
    if not number(speed) or not 0.7 <= speed <= 1.3:
        raise ValueError("invalid speed")
    if not isinstance(emotions, dict):
        raise ValueError("invalid emotions")
    adjustment = sum(WEIGHTS[name] * weight for name, weight in emotions.items()
                     if name in WEIGHTS and number(weight) and 0 <= weight <= 1)
    return voice, max(0.7, min(1.3, speed + adjustment))
