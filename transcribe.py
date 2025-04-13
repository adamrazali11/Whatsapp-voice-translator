# transcribe.py
import whisper
import sys
import logging

logging.basicConfig(level=logging.DEBUG)

audio_path = sys.argv[1]
logging.debug(f"Processing file: {audio_path}")

model = whisper.load_model("base")
result = model.transcribe(audio_path)

print(result["text"])  # make sure this is the last thing printed
