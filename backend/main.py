from fastapi import FastAPI, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import numpy as np
import librosa
import soundfile as sf
import tempfile
import os

app = FastAPI()

# Allow Next.js dev server

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ----------------------------
# Helpers (adapted from your script)
# ----------------------------
def safe_norm(x: np.ndarray) -> np.ndarray:
    m = float(np.max(np.abs(x)) + 1e-9)
    return (x / m) if m > 1.0 else x

def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x)) + 1e-12))

def match_rms(x: np.ndarray, target_rms: float = 0.13) -> np.ndarray:
    x = x.astype(np.float32)
    r = rms(x)
    if r < 1e-8:
        return x
    return x * (target_rms / r)

def soft_clip(x: np.ndarray, clip: float = 0.98) -> np.ndarray:
    x = x.astype(np.float32)
    return np.tanh(x / clip) * clip

def crop_to_max_duration(x: np.ndarray, sr: int, max_sec: float) -> np.ndarray:
    nmax = int(round(max_sec * sr))
    nmax = max(1, nmax)
    return x[: min(len(x), nmax)].astype(np.float32)

def fade_out(x: np.ndarray, sr: int, fade_sec: float) -> np.ndarray:
    x = x.astype(np.float32)
    n = int(round(fade_sec * sr))
    if n <= 1 or len(x) <= n:
        return x
    w = np.linspace(1.0, 0.0, n, dtype=np.float32)
    y = x.copy()
    y[-n:] *= w
    return y

def overlay_samples_at_times(length_samples: int, sr: int, times_sec: np.ndarray,
                             sample_audio: np.ndarray, gains: np.ndarray | None = None) -> np.ndarray:
    out = np.zeros(length_samples, dtype=np.float32)
    sample_audio = sample_audio.astype(np.float32)

    if gains is None:
        gains = np.ones(len(times_sec), dtype=np.float32)
    else:
        gains = gains.astype(np.float32)

    for t, g in zip(times_sec, gains):
        start = int(round(float(t) * sr))
        if start >= length_samples:
            continue
        end = min(length_samples, start + len(sample_audio))
        out[start:end] += float(g) * sample_audio[: end - start]
    return out

def load_upload_to_temp(upload: UploadFile) -> str:
    suffix = os.path.splitext(upload.filename)[1].lower() or ".wav"
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    with open(path, "wb") as f:
        f.write(upload.file.read())
    return path

def beat_track_section(y: np.ndarray, sr: int, start_sec: float, end_sec: float):
    # Slice section
    start_samp = int(round(max(0.0, start_sec) * sr))
    end_samp = int(round(min(end_sec, len(y) / sr) * sr))
    if end_samp <= start_samp:
        raise ValueError("section_end must be > section_start")
    y_section = y[start_samp:end_samp].astype(np.float32)

    if len(y_section) < sr * 3:
        raise ValueError("Section too short for beat tracking; choose 3–6+ seconds.")

    hop_length = 512
    oenv = librosa.onset.onset_strength(y=y_section, sr=sr, hop_length=hop_length)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=hop_length)

    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length).astype(np.float32)

    # Convert to absolute song times (not relative to section)
    beat_times_abs = beat_times + float(start_sec)

    return float(tempo), beat_times_abs

# ----------------------------
# API
# ----------------------------

@app.post("/analyze")
async def analyze(
    audio: UploadFile = File(...),
    section_start: float = Query(...),
    section_end: float = Query(...),
):
    audio_path = load_upload_to_temp(audio)
    try:
        y, sr = librosa.load(audio_path, sr=None, mono=True)
        bpm, beat_times = beat_track_section(y, sr, section_start, section_end)

        return {
            "ok": True,
            "sr": int(sr),
            "bpm": float(round(bpm, 2)),
            "beat_times": [float(round(t, 6)) for t in beat_times],
        }
    except Exception as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    finally:
        try:
            os.remove(audio_path)
        except:
            pass


@app.post("/render")
async def render(
    audio: UploadFile = File(...),
    # voice files: 1..8 required
    v1: UploadFile = File(...),
    v2: UploadFile = File(...),
    v3: UploadFile = File(...),
    v4: UploadFile = File(...),
    v5: UploadFile = File(...),
    v6: UploadFile = File(...),
    v7: UploadFile = File(...),
    v8: UploadFile = File(...),
    section_start: float = Query(...),
    section_end: float = Query(...),

    # knobs (matching your script defaults)
    voice_advance_ms: float = Query(70.0),
    voice_target_rms: float = Query(0.13),
    song_gain: float = Query(0.75),
    voice_gain: float = Query(2.0),
):
    # Save temp files
    audio_path = load_upload_to_temp(audio)
    voice_uploads = [v1, v2, v3, v4, v5, v6, v7, v8]
    voice_paths = []
    try:
        for vu in voice_uploads:
            voice_paths.append(load_upload_to_temp(vu))

        y, sr = librosa.load(audio_path, sr=None, mono=True)
        bpm, beat_times_abs = beat_track_section(y, sr, section_start, section_end)

        # Work only in section for rendering
        start_samp = int(round(section_start * sr))
        end_samp = int(round(section_end * sr))
        y_section = y[start_samp:end_samp].astype(np.float32)
        section_len = len(y_section)

        # Beat times relative to section
        beat_times = (beat_times_abs - section_start).astype(np.float32)
        beat_times = beat_times[(beat_times >= 0) & (beat_times <= (section_len / sr))]

        if len(beat_times) < 4:
            raise ValueError("Too few beats detected in section.")

        spb = float(np.median(np.diff(beat_times))) if len(beat_times) >= 2 else (60.0 / max(bpm, 1e-6))
        max_voice_sec = 0.62 * spb
        fade_sec = min(0.12 * spb, 0.06)

        # Load + process voice samples 1..8
        voice_samples = {}
        for k, path in enumerate(voice_paths, start=1):
            samp, samp_sr = librosa.load(path, sr=None, mono=True)
            samp = samp.astype(np.float32)
            if samp_sr != sr:
                samp = librosa.resample(samp, orig_sr=samp_sr, target_sr=sr).astype(np.float32)

            samp, _ = librosa.effects.trim(samp, top_db=35)
            samp = match_rms(samp, target_rms=voice_target_rms)
            samp = crop_to_max_duration(samp, sr, max_voice_sec)
            samp = fade_out(samp, sr, fade_sec)
            voice_samples[k] = samp

        # Assign counts 1..8 across beats
        counts = (np.arange(len(beat_times)) % 8) + 1
        gains = np.where(counts == 1, 1.7, 1.0).astype(np.float32)

        voice_advance_sec = voice_advance_ms / 1000.0

        voice_track = np.zeros(section_len, dtype=np.float32)
        for k in range(1, 9):
            idx = np.where(counts == k)[0]
            if idx.size == 0:
                continue
            times_k = np.maximum(0.0, beat_times[idx] - voice_advance_sec)
            gains_k = gains[idx]
            voice_track += overlay_samples_at_times(
                length_samples=section_len,
                sr=sr,
                times_sec=times_k,
                sample_audio=voice_samples[k],
                gains=gains_k,
            )

        # Normalize tracks and mix
        song_base = y_section / (np.max(np.abs(y_section)) + 1e-9)
        song_base = song_base * float(song_gain)

        voice_track = voice_track / (np.max(np.abs(voice_track)) + 1e-9)

        out = safe_norm(song_base + float(voice_gain) * voice_track)
        out = soft_clip(out)

        # Write to temp wav
        out_path = tempfile.mktemp(suffix=".wav")
        sf.write(out_path, out, sr)

        return FileResponse(out_path, media_type="audio/wav", filename="countcoach_section.wav")
    except Exception as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    finally:
        for p in voice_paths:
            try:
                os.remove(p)
            except:
                pass
        try:
            os.remove(audio_path)
        except:
            pass
