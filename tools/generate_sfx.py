"""Synthesize the four Circle Check+ feedback cues as 16-bit mono WAV (stdlib only, no licensed audio)."""
import math
import struct
import sys
import wave
from pathlib import Path

RATE = 44100


def tone(freq: float, dur: float, amp: float = 0.5, shape: str = "sine") -> list[float]:
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        phase = 2 * math.pi * freq * t
        s = math.sin(phase) if shape == "sine" else (1.0 if math.sin(phase) >= 0 else -1.0) * 0.6
        # 5 ms attack + exponential decay keeps cues click-free on the waveguide speakers.
        env = min(1.0, t / 0.005) * math.exp(-4.0 * t / dur)
        out.append(s * env * amp)
    return out


def silence(dur: float) -> list[float]:
    return [0.0] * int(RATE * dur)


CUES = {
    "sfx_intercept": tone(440, 0.16, shape="square") + silence(0.05) + tone(330, 0.24, shape="square"),
    "sfx_zone_verified": tone(880, 0.12) + tone(1320, 0.22),
    "sfx_trike_snap": tone(1800, 0.03, amp=0.4) + tone(660, 0.14),
    "sfx_depart_cleared": tone(523.25, 0.14) + tone(659.25, 0.14) + tone(783.99, 0.32),
}


def write(path: Path, samples: list[float]) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples))


if __name__ == "__main__":
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "Assets/Audio")
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, samples in CUES.items():
        write(out_dir / f"{name}.wav", samples)
        print(f"{name}.wav {len(samples) / RATE:.2f}s")
