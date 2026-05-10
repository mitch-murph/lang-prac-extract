import shutil
from pathlib import Path
from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import processor
from ffmpeg_service import check_ffmpeg

UPLOADS_DIR = Path(__file__).parent.parent / "uploads"
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

app = FastAPI(title="Lang Audio Tool")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "ffmpeg": check_ffmpeg()}


@app.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    allowed = {".mp3", ".m4a", ".wav", ".ogg", ".flac"}
    suffix = Path(file.filename).suffix.lower()
    if suffix not in allowed:
        raise HTTPException(400, f"Unsupported file type: {suffix}")

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOADS_DIR / file.filename
    # avoid collisions
    counter = 1
    while dest.exists():
        dest = UPLOADS_DIR / f"{Path(file.filename).stem}_{counter}{suffix}"
        counter += 1

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    project = processor.create_project(str(dest), file.filename)
    return project


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
    segments: list[dict]


@app.put("/project/{project_id}/segments")
def update_segments(project_id: str, payload: SegmentsPayload):
    project = processor.update_segments(project_id, payload.segments)
    if project is None:
        raise HTTPException(404, "Project not found")
    return project


@app.post("/export/{project_id}")
def export_project(project_id: str):
    project = processor.get_project(project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    zip_path = processor.build_export(project_id)
    if zip_path is None:
        raise HTTPException(500, "Export failed")
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


# Serve frontend
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
