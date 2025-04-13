import sys
import whisper

file_path = sys.argv[1]
model = whisper.load_model("base")

result = model.transcribe(file_path, task="translate")
print(result["text"])
