# Count Coach

An audio practice prototype for dancers: import a mix, select a waveform section, estimate its BPM, and practice with metronome/counting audio.

The repository has Next.js configuration at the root, but its application and FastAPI backend are under `current/`. The local setup below points Next.js at that directory explicitly.

## Frontend

Use Node.js and npm. From the repository root:

```bash
npm ci
npx next dev current
```

Open `http://localhost:3000`. The checked-in frontend requests its analysis API at `http://localhost:8000`.

## Backend

In a separate terminal, with Python 3 and a virtual environment:

```bash
cd current/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

The backend uses FastAPI, Librosa, NumPy, and SoundFile. `/analyze` estimates beats for a selected section. `/render` accepts audio plus eight count-voice uploads and creates a rendered overlay. Interactive API documentation is at `http://localhost:8000/docs`.

## Code map

- `current/app/page.tsx`: waveform, analysis requests, and playback controls.
- `current/public/click.wav` and `current/public/voice/`: click and count audio.
- `current/backend/main.py`: analysis and render API.
- Root `package.json`: JavaScript dependencies.

## Limits

This is a local prototype. The backend allows the frontend origin `http://localhost:3000`; other hosts need deliberate configuration. Tempo estimates can be wrong on irregular rhythms and transitions. The unusual directory layout means the root's bare `npm run dev` is not the setup documented here. No end-to-end test suite is included, and this revised startup route was not runtime-tested for this documentation update.
