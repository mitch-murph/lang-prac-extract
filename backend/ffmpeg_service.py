import subprocess
import shutil
from pathlib import Path


def check_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def cut_segment(input_path: str, start: float, end: float, output_path: str) -> None:
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-ss", str(start),
        "-to", str(end),
        "-c", "copy",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # fallback: re-encode if stream copy fails
        cmd[cmd.index("-c") + 1] = "libmp3lame"
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg error: {result.stderr}")


def export_clips(audio_path: str, segments: list[dict], export_dir: str) -> list[str]:
    Path(export_dir).mkdir(parents=True, exist_ok=True)
    created = []
    for seg in segments:
        filename = f"clip_{seg['id']:03d}.mp3"
        out = str(Path(export_dir) / filename)
        cut_segment(audio_path, seg["start"], seg["end"], out)
        created.append(filename)
    return created
