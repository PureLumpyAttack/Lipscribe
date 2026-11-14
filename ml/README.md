# Lipscribe ML

All model work for Lipscribe lives here, separate from the website in `../web/`.

Plan:

1. Export the pretrained Auto-AVSR visual speech recognition model (LRS3, WER 19.1%) to ONNX and verify it matches PyTorch.
2. Build quantized variants (fp16, int8, 4-bit) and measure the accuracy cost on GRID clips and our own labeled recordings.
3. Add target-person selection and tracking to the mouth-crop preprocessing.
4. Ship the chosen ONNX model to the website for in-browser inference (ONNX Runtime Web, WebGPU).

Setup and usage instructions will be added as each step lands.
