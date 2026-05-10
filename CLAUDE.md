# Lang Audio Tool — CLAUDE.md

## What this project is

A local-first web app for language learning audio processing. The user uploads an audio file, gets a Whisper transcription with timestamps, edits segments in the browser, and exports individual audio clips + metadata as a ZIP (for Anki, shadowing, etc.).

## Stack

| Layer | Tech |
|---|---|
| Backend | FastAPI + Uvicorn |
| Transcription | faster-whisper (`large-v2` model, CPU, int8) |
| Audio cutting | FFmpeg — installed via winget, on PATH |
| Frontend | Plain HTML + JS + CSS (no build step) |
| Storage | Local filesystem — JSON project files (UTF-8) |

## Running

```powershell
# From project root
pip install --user -r requirements.txt

cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
# Open http://localhost:8000
```

**Note:** The server must be started in a shell that has the updated PATH (ffmpeg was installed by winget after the initial server was started). Use the PowerShell launcher or open a fresh terminal.

## Python version

**Anaconda Python 3.9** is on this machine. Strict rules:
- Use `Optional[X]` from `typing` instead of `X | None`
- Use `List[X]` from `typing` instead of `list[X]` in function signatures
- Avoid any Python 3.10+ syntax (`match`, `X | Y` unions, etc.)

## Critical: file encoding on Windows

Windows defaults to `cp1252` which cannot encode Thai, Khmer, Japanese, or most non-Latin scripts. **Always pass `encoding="utf-8"` to every file read/write.** Use the helpers in `processor.py`:

```python
def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def _read_json(path: Path) -> Optional[dict]:
    try:
        text = path.read_text(encoding="utf-8")
        if not text.strip():
            return None
        return json.loads(text)
    except (json.JSONDecodeError, OSError):
        return None
```

Never use bare `path.write_text(...)` or `path.read_text()` — always add `encoding="utf-8"`.

## File layout

```
backend/
  main.py            ← FastAPI routes
  processor.py       ← project CRUD + export orchestration
  whisper_service.py ← faster-whisper wrapper (model lazy-loaded on first use)
  ffmpeg_service.py  ← FFmpeg clip cutting

frontend/
  index.html         ← single-page shell
  app.js             ← all UI logic (upload, waveform, playback, save, export)
  style.css          ← dark theme

uploads/             ← raw uploaded audio files
projects/            ← one JSON file per project (source of truth)
exports/             ← generated ZIPs
temp/                ← scratch space
```

## Key design decisions

- **Timestamp is source of truth.** Segment start/end drive everything — playback, FFmpeg cuts, export filenames.
- **Non-destructive.** Original audio is never modified; JSON edits are separate.
- **Project = one audio file.** `projects/<uuid>.json` holds all segments and metadata.
- **Model loads lazily.** `_model` in `whisper_service.py` is `None` until the first upload; avoids slow startup.
- **Frontend served by FastAPI.** `StaticFiles` mounts `frontend/` at `/`. No separate dev server needed.
- **`condition_on_previous_text=False`** is set on all transcriptions so each segment is decoded independently — essential for mixed-language audio.

## Whisper / transcription

- **Current model:** `large-v2` (best multilingual quality, slow on CPU — ~5–10× real-time)
- **Faster alternative:** change to `"medium"` or `"base"` in `whisper_service.py:8` — tradeoff is worse multilingual accuracy
- **Language selection:** user picks a language in the upload form; passed as `language=` to `model.transcribe()`. If left as "Auto-detect", Whisper infers from the first ~30s of audio and may lock onto English for mixed files — forcing a language is more reliable for non-English audio
- **Mixed-language limitation:** Whisper is not great at true code-switching (e.g. English and Thai alternating sentence-by-sentence). `large-v2` + `condition_on_previous_text=False` is the best available approach without a GPU

## Waveform (frontend)

Each segment card renders a canvas waveform:
- Audio is decoded once via `AudioContext.decodeAudioData()` after project load
- Waveforms render lazily via `IntersectionObserver` as segments scroll into view
- Window shows ±1.5s of context around the segment by default
- **Drag green handle** to move segment start, **drag orange handle** to move segment end
- **Drag the waveform background** to pan the view
- **Mouse wheel** to scroll left/right; **Ctrl+Wheel** to zoom in/out
- Auto-pan: dragging a handle to the canvas edge scrolls the window automatically
- Clicking a timestamp label below the waveform allows typing an exact value

## Segment export selection

Each segment has a checkbox. Unchecked segments are excluded from the ZIP export. The export button shows `Export ZIP (N/total)` when a subset is selected. The backend `POST /export/{id}` accepts `{ "segment_ids": [...] }` — omit or pass `null` to export all.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Server + ffmpeg check |
| POST | `/upload` | Upload audio + optional `language` form field → transcribe → return project JSON |
| GET | `/projects` | List all projects (summary) |
| GET | `/project/{id}` | Full project JSON |
| PUT | `/project/{id}/segments` | Save edited segments (text + timestamps) |
| POST | `/export/{id}` | Cut selected clips, package ZIP, return file |
| GET | `/audio/{id}` | Stream original audio to browser |

## Known gotchas

- **Corrupt project files:** if the server crashes mid-write (e.g. encoding error), a zero-byte `.json` is left in `projects/`. `list_projects()` skips these silently. Delete them manually or they stay harmless.
- **ffmpeg PATH:** ffmpeg was installed by winget after the initial session. Any server started in an old shell won't see it. Always start the server in a fresh terminal or refresh the PATH explicitly.
- **large-v2 first run:** downloads ~3 GB from Hugging Face on first transcription, cached at `~/.cache/huggingface/`. Subsequent runs use the cache.
- **GPU / cublas64_12.dll:** CTranslate2 4.7.1 requires CUDA 12.x runtime DLLs (`cublas64_12.dll`). The app auto-detects and falls back to CPU if they are missing. To enable GPU, install CUDA Toolkit 12.x from `https://developer.nvidia.com/cuda-12-4-1-download-archive` (Windows → x86_64 → 11 → exe local, ~3 GB). After install, open a fresh terminal — `where.exe cublas64_12.dll` should return a path. CUDA 13.x does NOT provide `cublas64_12.dll`. winget's `Nvidia.CUDA` package is currently 13.2 and will not fix this — get 12.x from nvidia.com directly.

## Planned future phases

- **Phase 5:** Merge/split segments, keyboard shortcuts
- **Phase 6:** Anki export (`.apkg`), translation field, tags
- **Later:** GPU Whisper (CUDA), SRT/VTT subtitle export, batch folder processing
