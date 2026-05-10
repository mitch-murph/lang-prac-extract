from typing import Optional, Callable
from faster_whisper import WhisperModel

_model: Optional[WhisperModel] = None
_device: str = "cpu"  # updated when model loads


def _get_model() -> WhisperModel:
    global _model, _device
    if _model is None:
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                _model = WhisperModel("large-v2", device="cuda", compute_type="float16")
                _device = "cuda"
                print("INFO: Whisper running on GPU (CUDA float16)")
            else:
                raise RuntimeError("no CUDA devices")
        except Exception as e:
            print(f"WARNING: GPU unavailable ({e}) — falling back to CPU")
            _model = WhisperModel("large-v2", device="cpu", compute_type="int8")
            _device = "cpu"
    return _model


def get_device() -> str:
    return _device


def transcribe(audio_path: str, language: Optional[str] = None,
               progress_cb: Optional[Callable[[int], None]] = None) -> dict:
    model = _get_model()
    segments_iter, info = model.transcribe(
        audio_path,
        beam_size=5,
        language=language if language else None,
        condition_on_previous_text=False,
        word_timestamps=False,
    )

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
        if progress_cb:
            progress_cb(i + 1)

    return {
        "language": info.language,
        "duration": round(info.duration, 3),
        "text": " ".join(full_text_parts),
        "segments": segments,
    }
