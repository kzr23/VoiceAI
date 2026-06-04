import subprocess

TEXT = "Hello. Welcome to Voice AI."

MODEL = "models/en_US-lessac-medium/en_US-lessac-medium.onnx"

with open("input.txt", "w") as f:
    f.write(TEXT)

cmd = f'cat input.txt | piper --model {MODEL} --output_file output.wav'

subprocess.run(cmd, shell=True)

print("Generated output.wav")
