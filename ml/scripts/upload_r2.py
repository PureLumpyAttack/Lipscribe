# /// script
# requires-python = ">=3.10"
# dependencies = ["boto3"]
# ///
"""Upload exports/web/ (from package_web.py) to the public Cloudflare R2 bucket
the website loads the model from (modelBaseUrl in web/public/js/config.js).

Run from ml/:
  CLOUDFLARE_API_TOKEN=... uv run scripts/upload_r2.py

The token needs "Workers R2 Storage: Edit" and is only needed for uploading,
never in production: visitors read the bucket through its public URL. Instead
of a token you can pass R2 S3 keys (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).
Uses the S3 API with multipart uploads (single API uploads fail on 100+ MB files).
"""

import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "d1252b07d7eb576b8491077e5da85f49")
BUCKET = os.environ.get("R2_BUCKET", "lipscribe-models")
SRC = Path(__file__).resolve().parents[1] / "exports" / "web"


def credentials():
    if os.environ.get("R2_ACCESS_KEY_ID"):
        return os.environ["R2_ACCESS_KEY_ID"], os.environ["R2_SECRET_ACCESS_KEY"]
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        sys.exit("Set CLOUDFLARE_API_TOKEN (or R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY).")
    # An API token works as S3 keys: key id = token id, secret = sha256(token).
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/tokens/verify",
        headers={"Authorization": f"Bearer {token}"},
    )
    token_id = json.load(urllib.request.urlopen(req))["result"]["id"]
    return token_id, hashlib.sha256(token.encode()).hexdigest()


def main():
    if not (SRC / "manifest.json").exists():
        sys.exit(f"No {SRC}/manifest.json. Run scripts/package_web.py first.")
    key_id, secret = credentials()
    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        region_name="auto",
    )
    cfg = TransferConfig(multipart_threshold=32 << 20, multipart_chunksize=32 << 20, max_concurrency=8)
    # Model files first, manifest last, so visitors never get a manifest that
    # points at files that aren't uploaded yet.
    files = sorted(SRC.rglob("*.onnx")) + [SRC / f for f in ("tokens.json", "preprocess.json", "manifest.json")]
    for f in files:
        key = f.relative_to(SRC).as_posix()
        print(f"  {key}  {f.stat().st_size / 1e6:.1f} MB", flush=True)
        s3.upload_file(str(f), BUCKET, key, Config=cfg, ExtraArgs={
            "ContentType": "application/octet-stream" if f.suffix == ".onnx" else "application/json; charset=utf-8",
            # Browsers revalidate (cheap ETag check), so a new upload shows up at once.
            # The page keeps its own copy in the Cache API anyway.
            "CacheControl": "no-cache",
        })
    print(f"Uploaded to R2 bucket {BUCKET}.")


if __name__ == "__main__":
    main()
