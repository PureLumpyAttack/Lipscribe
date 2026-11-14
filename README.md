# Lipscribe

Lip reading in the browser: read words from a speaker's lips through the webcam.

## Repository layout

| Folder | What lives there |
|---|---|
| [`web/`](web/) | The website (Node.js localhost server + static pages). See [`web/README.md`](web/README.md). |
| [`ml/`](ml/) | Everything model-related: model export to ONNX, quantization, evaluation, test data tooling. See [`ml/README.md`](ml/README.md). |

Keep website code inside `web/` and all AI/model work inside `ml/`. Large files (model weights, datasets, exported ONNX models) are not committed; the scripts in `ml/` download or generate them.
 
