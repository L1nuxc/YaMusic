# CPU audio model

Run from the repository root:

```sh
npm run setup:analysis
```

The setup installs the audio-only INT8 ONNX graph from [Xenova/clap-htsat-unfused](https://huggingface.co/Xenova/clap-htsat-unfused), revision `c28f2883575e590e04d3146ff0713c2448d691ba`, and Microsoft's [ONNX Runtime 1.22.0 CPU](https://github.com/microsoft/onnxruntime/releases/tag/v1.22.0). The underlying [LAION model card](https://huggingface.co/laion/clap-htsat-unfused) declares Apache-2.0; the conversion identifies that base model. Runtime license and notices are included in the downloaded official archive.

Model file: `clap-audio-int8.onnx`, 34,301,667 bytes. SHA-256:

```text
3fcff2c8824e7bcb83a983f2a49edab3b60cbcf4872ac70efee517355173bd1f
```

The model is deliberately excluded from source control. `clap-preprocessor.json` records the pinned preprocessing settings. No text model, Python runtime, Torch or GPU is required.

Processing: symphonia MP3 → mono → rubato FFT resampling to 48 kHz → 10-second windows → periodic Hann 1024 / hop 480, reflected centering → 64 Slaney-normalized Mel bands (50–14000 Hz) → log-power dB → `[1,1,1001,64]` ONNX input. Up to three windows cover the 30-second preview; output vectors are averaged and L2-normalized. Short windows use the model's repeat-and-pad convention. The result contains 512 `f32` values, stored as 2048 little-endian bytes.

Preprocessing follows the [official Transformers CLAP feature extractor](https://github.com/huggingface/transformers/blob/main/src/transformers/models/clap/feature_extraction_clap.py). Splitting a long preview into three deterministic windows instead of selecting a random crop avoids changes between analyses of the same preview.

Settings in the root `.env`:

```text
# Optional overrides for a separately installed model / runtime:
# CLAP_MODEL_PATH=models/clap-audio-int8.onnx
# ORT_DYLIB_PATH=/absolute/path/to/libonnxruntime.so
ANALYSIS_BACKFILL_LIMIT=200
```

Setup supports Windows x64 and Ubuntu/Linux x64. Other architectures require a matching official ONNX Runtime library. Linux execution and the VPS memory/load targets must still be measured on the intended VPS.
