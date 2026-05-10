import json
import uuid
import shutil
import zipfile
from pathlib import Path
from datetime import datetime
from typing import Optional, List

from whisper_service import transcribe
from ffmpeg_service import export_clips

PROJECTS_DIR = Path(__file__).parent.parent / "projects"
EXPORTS_DIR  = Path(__file__).parent.parent / "exports"
UPLOADS_DIR  = Path(__file__).parent.parent / "uploads"


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


def create_project(audio_path: str, original_filename: str, language: Optional[str] = None,
                   progress_cb=None) -> dict:
    project_id = str(uuid.uuid4())
    result = transcribe(audio_path, language=language, progress_cb=progress_cb)

    project = {
        "id": project_id,
        "created_at": datetime.utcnow().isoformat(),
        "audio_file": original_filename,
        "audio_path": audio_path,
        "language": result["language"],
        "duration": result["duration"],
        "text": result["text"],
        "segments": result["segments"],
    }

    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    _write_json(PROJECTS_DIR / f"{project_id}.json", project)
    return project


def get_project(project_id: str) -> Optional[dict]:
    return _read_json(PROJECTS_DIR / f"{project_id}.json")


def list_projects() -> list:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    projects = []
    for f in sorted(PROJECTS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        data = _read_json(f)
        if data is None:
            continue  # skip empty / corrupt files
        projects.append({
            "id": data["id"],
            "audio_file": data["audio_file"],
            "created_at": data["created_at"],
            "duration": data["duration"],
            "language": data.get("language", ""),
            "segment_count": len(data["segments"]),
        })
    return projects


def update_segments(project_id: str, segments: List[dict]) -> Optional[dict]:
    project = get_project(project_id)
    if project is None:
        return None
    project["segments"] = segments
    _write_json(PROJECTS_DIR / f"{project_id}.json", project)
    return project


def build_export(project_id: str, segment_ids: Optional[List] = None) -> Optional[str]:
    project = get_project(project_id)
    if project is None:
        return None

    segments = project["segments"]
    if segment_ids is not None:
        id_set = set(segment_ids)
        segments = [s for s in segments if s["id"] in id_set]
    if not segments:
        return None

    export_dir = EXPORTS_DIR / project_id
    clips_dir  = export_dir / "clips"
    export_clips(project["audio_path"], segments, str(clips_dir))

    meta = {
        "id": project["id"],
        "audio_file": project["audio_file"],
        "language": project.get("language", ""),
        "duration": project["duration"],
        "segments": segments,
    }
    _write_json(export_dir / "project.json", meta)

    zip_path = EXPORTS_DIR / f"{project_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in export_dir.rglob("*"):
            if file.is_file():
                zf.write(file, file.relative_to(export_dir))

    shutil.rmtree(export_dir)
    return str(zip_path)
