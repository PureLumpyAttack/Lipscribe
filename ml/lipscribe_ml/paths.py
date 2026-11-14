from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
CHAPLIN_DIR = ML_DIR / "third_party" / "chaplin"
MODELS_DIR = ML_DIR / "models"
VSR_MODEL_DIR = MODELS_DIR / "LRS3_V_WER19.1"
LM_MODEL_DIR = MODELS_DIR / "lm_en_subword"
EXPORTS_DIR = ML_DIR / "exports"
DATA_DIR = ML_DIR / "data"
GRID_DIR = DATA_DIR / "grid"
RECORDINGS_DIR = DATA_DIR / "recordings"
RESULTS_DIR = ML_DIR / "results"
CACHE_DIR = RESULTS_DIR / "cache"
MEAN_FACE = CHAPLIN_DIR / "pipelines" / "detectors" / "mediapipe" / "20words_mean_face.npy"
TOKENS_FILE = CHAPLIN_DIR / "pipelines" / "tokens" / "unigram5000_units.txt"
FACE_DETECTOR_MODEL = MODELS_DIR / "blaze_face_short_range.tflite"
FACE_DETECTOR_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
)
