import uuid
from pathlib import Path
from faster_whisper import WhisperModel

_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel("base", device="cpu", compute_type="int8")
    return _model


def transcribe(audio_path: str) -> dict:
    model = _get_model()
    segments_iter, info = model.transcribe(audio_path, beam_size=5, word_timestamps=False)

    segments = []
    full_text_parts = []
    for i, seg in enumerate(segments_iter):
        segments.append({
            "id": i + 1,
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
        })
        full_text_parts.append(seg.text.strip())

    return {
        "language": info.language,
        "duration": round(info.duration, 3),
        "text": " ".join(full_text_parts),
        "segments": segments,
    }
