Rolley XGBoost Retraining Guide
================================

Overview
--------
This guide captures the exact steps and locations used to retrain the Rolley
XGBoost model and deploy it to production. It is written to be run on the VPS
or from the Coolify terminal for the rolley-service resource.

Key Locations
-------------
- Repo on VPS: `/root/banter-mobil-app-rolley-service`
- Data volume (persistent): `/var/lib/docker/volumes/r10gspctl78j5av1au93rdu8-rolley-data/_data`
- Scripts:
  - `scripts/backfill_match_history.py`
  - `scripts/export_training_dataset.py`
  - `scripts/train_xgboost.py`
  - `scripts/promote_candidate_model.py`
- Config:
  - `app/config.py` (uses `XGBOOST_MODEL_PATH`)
  - `.env` (for local runs; production uses Coolify env vars)

Requirements
------------
- A running rolley-service container image (find with `docker ps`)
- Admin key for rebuild endpoint (`ADMIN_REFRESH_KEY`)
- Persistent model path in production:
  `XGBOOST_MODEL_PATH=/app/data/models/rolley_xgb_v1.json`

Step 1: Locate the Rolley Image
--------------------------------
```bash
docker ps --format "{{.Names}}\t{{.Image}}" | grep r10gsp
IMAGE="r10gspctl78j5av1au93rdu8:c975a75bec8ab4d89663d6d843c2b3008d537540"
```

Step 2: Backfill Match History (if needed)
------------------------------------------
```bash
cd /root/banter-mobil-app-rolley-service

START=2023-01-01
END=2026-03-13

while [ "$START" \< "$END" ] || [ "$START" = "$END" ]; do
  NEXT=$(date -I -d "$START +30 days")
  if [ "$NEXT" \< "$END" ]; then
    CHUNK_END="$NEXT"
  else
    CHUNK_END="$END"
  fi

  echo "Backfill $START -> $CHUNK_END"
  docker run --rm -v "$PWD":/app -w /app --env-file .env -e PYTHONPATH=/app "$IMAGE" \
    python -u scripts/backfill_match_history.py --start-date "$START" --end-date "$CHUNK_END" --sports SOCCER,BASKETBALL || break

  START=$(date -I -d "$CHUNK_END +1 day")
done
```

Step 3: Export Training Dataset
-------------------------------
```bash
docker run --rm -v "$PWD":/app -w /app --env-file .env -e PYTHONPATH=/app "$IMAGE" \
  python -u scripts/export_training_dataset.py --output data/historical_training.csv --lookback 12 --min-team-games 5
```

Step 4: Train the Model
-----------------------
```bash
docker run --rm -v "$PWD":/app -w /app --env-file .env -e PYTHONPATH=/app "$IMAGE" \
  python -u scripts/train_xgboost.py --dataset data/historical_training.csv --output models/rolley_xgb_v1.json --version xgb-v3-YYYY-MM-DD
```

Step 5: Persist Model to Volume
-------------------------------
```bash
VOL=/var/lib/docker/volumes/r10gspctl78j5av1au93rdu8-rolley-data/_data
mkdir -p "$VOL/models"
cp /root/banter-mobil-app-rolley-service/models/rolley_xgb_v1.json "$VOL/models/rolley_xgb_v1.json"
cp /root/banter-mobil-app-rolley-service/models/rolley_xgb_v1.meta.json "$VOL/models/rolley_xgb_v1.meta.json"
```

Step 6: Set the Production Path (Coolify)
-----------------------------------------
In Coolify → rolley-service → Environment Variables:
```
XGBOOST_MODEL_PATH=/app/data/models/rolley_xgb_v1.json
```
Restart or redeploy the service.

Step 7: Rebuild Picks and Verify
--------------------------------
```bash
ADMIN_KEY=$(grep -m1 '^ADMIN_REFRESH_KEY=' .env | cut -d= -f2-)
DATE=$(date -u +%F)

curl -s -X POST "http://127.0.0.1:8090/api/v1/admin/picks/rebuild?pick_date=$DATE&sport=SOCCER" \
  -H "X-Admin-Key: $ADMIN_KEY"

curl -s -X POST "http://127.0.0.1:8090/api/v1/admin/picks/rebuild?pick_date=$DATE&sport=BASKETBALL" \
  -H "X-Admin-Key: $ADMIN_KEY"
```

Verify the model version:
```bash
curl -s "http://127.0.0.1:8090/api/v1/picks/history?sport=SOCCER&limit=1" | grep -o '"model_version":"[^"]*"'
```

Troubleshooting
---------------
- If the container name changes, re-run:
  `docker ps --format "{{.Names}}\t{{.Image}}" | grep r10gsp`
- If the model does not persist after redeploy, confirm `XGBOOST_MODEL_PATH`
  points to `/app/data/models/...` and the files exist in the volume.
