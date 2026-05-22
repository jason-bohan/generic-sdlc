import torch

print(f"torch: {torch.__version__}")
print(f"cuda available: {torch.cuda.is_available()}")
print(f"cuda version: {torch.version.cuda}")
if torch.cuda.is_available():
    print(f"device name: {torch.cuda.get_device_name(0)}")
    props = torch.cuda.get_device_properties(0)
    print(f"vram: {props.total_mem / 1024**3:.1f} GB")
    print(f"compute capability: {props.major}.{props.minor}")
else:
    print("NO CUDA - training will fail")
