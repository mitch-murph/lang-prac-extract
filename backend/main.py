import shutil
import threading
import uuid
from pathlib import Path
from typing import Dict, Any, Optional

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import processor
from ffmpeg_service import check_ffmpeg
import whisper_service

UPLOADS_DIR  = Path(__file__).parent.parent / "uploads"
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

app = FastAPI(title="Lang Audio Tool")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory job tracker (local use only, lost on server restart) ──────────
jobs: Dict[str, Any] = {}


def _run_transcription(job_id: str, audio_path: str, filename: str, language: Optional[str]):
    try:
        jobs[job_id]["status"] = "transcribing"

        def on_segment(n: int):
            jobs[job_id]["segments_found"] = n

        project = processor.create_project(
            audio_path, filename, language=language, progress_cb=on_segment
        )
        jobs[job_id].update({"status": "done", "project_id": project["id"]})
    except Exception as e:
        jobs[job_id].update({"status": "error", "error": str(e)})


# ── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "ffmpeg": check_ffmpeg(),
        "whisper_device": whisper_service.get_device(),
    }


@app.post("/upload")
async def upload_audio(file: UploadFile = File(...), language: str = Form(default="")):
    allowed = {".mp3", ".m4a", ".wav", ".ogg", ".flac"}
    suffix = Path(file.filename).suffix.lower()
    if suffix not in allowed:
        raise HTTPException(400, f"Unsupported file type: {suffix}")

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOADS_DIR / file.filename
    counter = 1
    while dest.exists():
        dest = UPLOADS_DIR / f"{Path(file.filename).stem}_{counter}{suffix}"
        counter += 1

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    job_id = str(uuid.uuid4())
    lang = language.strip() or None
    jobs[job_id] = {
        "status": "pending",
        "audio_file": file.filename,
        "segments_found": 0,
        "project_id": None,
        "error": None,
    }

    threading.Thread(
        target=_run_transcription,
        args=(job_id, str(dest), file.filename, lang),
        daemon=True,
    ).start()

    return {"job_id": job_id}


@app.get("/job/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@app.get("/projects")
def list_projects():
    return processor.list_projects()


@app.get("/project/{project_id}")
def get_project(project_id: str):
    project = processor.get_project(project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    return project


class SegmentsPayload(BaseModel):
    segments: list


@app.put("/project/{project_id}/segments")
def update_segments(project_id: str, payload: SegmentsPayload):
    project = processor.update_segments(project_id, payload.segments)
    if project is None:
        raise HTTPException(404, "Project not found")
    return project


class ExportPayload(BaseModel):
    segment_ids: list = None


@app.post("/export/{project_id}")
def export_project(project_id: str, payload: ExportPayload = None):
    project = processor.get_project(project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    ids = payload.segment_ids if payload else None
    zip_path = processor.build_export(project_id, ids)
    if zip_path is None:
        raise HTTPException(400, "No segments selected for export")
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{project['audio_file']}_export.zip",
    )


@app.get("/audio/{project_id}")
def stream_audio(project_id: str):
    project = processor.get_project(project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    audio_path = Path(project["audio_path"])
    if not audio_path.exists():
        raise HTTPException(404, "Audio file not found")
    return FileResponse(audio_path, media_type="audio/mpeg")


# Serve frontend last so API routes take precedence
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
