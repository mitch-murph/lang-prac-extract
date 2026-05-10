import json
import uuid
import shutil
import zipfile
from pathlib import Path
from datetime import datetime

from whisper_service import transcribe
from ffmpeg_service import export_clips

PROJECTS_DIR = Path(__file__).parent.parent / "projects"
EXPORTS_DIR = Path(__file__).parent.parent / "exports"
UPLOADS_DIR = Path(__file__).parent.parent / "uploads"


def create_project(audio_path: str, original_filename: str) -> dict:
    project_id = str(uuid.uuid4())
    result = transcribe(audio_path)

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
    project_file = PROJECTS_DIR / f"{project_id}.json"
    project_file.write_text(json.dumps(project, ensure_ascii=False, indent=2))

    return project


def get_project(project_id: str) -> dict | None:
    project_file = PROJECTS_DIR / f"{project_id}.json"
    if not project_file.exists():
        return None
    return json.loads(project_file.read_text())


def list_projects() -> list[dict]:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    projects = []
    for f in sorted(PROJECTS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        data = json.loads(f.read_text())
        projects.append({
            "id": data["id"],
            "audio_file": data["audio_file"],
            "created_at": data["created_at"],
            "duration": data["duration"],
            "language": data.get("language", ""),
            "segment_count": len(data["segments"]),
        })
    return projects


def update_segments(project_id: str, segments: list[dict]) -> dict | None:
    project = get_project(project_id)
    if project is None:
        return None
    project["segments"] = segments
    project_file = PROJECTS_DIR / f"{project_id}.json"
    project_file.write_text(json.dumps(project, ensure_ascii=False, indent=2))
    return project


def build_export(project_id: str) -> str | None:
    project = get_project(project_id)
    if project is None:
        return None

    export_dir = EXPORTS_DIR / project_id
    clips_dir = export_dir / "clips"
    export_clips(project["audio_path"], project["segments"], str(clips_dir))

    meta = {
        "id": project["id"],
        "audio_file": project["audio_file"],
        "language": project.get("language", ""),
        "duration": project["duration"],
        "segments": project["segments"],
    }
    (export_dir / "project.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    zip_path = EXPORTS_DIR / f"{project_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in export_dir.rglob("*"):
            if file.is_file():
                zf.write(file, file.relative_to(export_dir))

    shutil.rmtree(export_dir)
    return str(zip_path)
