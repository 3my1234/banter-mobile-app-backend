# MediaConvert HLS Pipeline (Starter)

This folder contains starter Lambdas for the HLS pipeline.

## 1) Start Job Lambda (S3 Trigger)
File: `start-job.js`

Trigger: S3 ObjectCreated on `user-uploads/` (mp4/mov/m4v)

Required env vars:
- `AWS_REGION` (e.g. `eu-north-1`)
- `MEDIACONVERT_ROLE_ARN`
- `MEDIACONVERT_ENDPOINT` (optional; if not set, Lambda discovers it)
- `OUTPUT_BUCKET` (same bucket or a dedicated `baze-bucket-hls`)
- `HLS_PREFIX` (e.g. `hls/`)

## 2) Completion Lambda (MediaConvert Event)
File: `complete-job.js`

Trigger: MediaConvert job state change (EventBridge) or SNS.

Required env vars:
- `BACKEND_WEBHOOK_URL` (e.g. `https://sportbanter.online/api/media/hls-complete`)
- `MEDIA_PIPELINE_SECRET` (same as backend `.env`)
- `MEDIA_CDN_BASE` (e.g. `https://media.sportbanter.online`)

## 3) Job Template
File: `job-template.json`

This is a minimal job configuration with 3 rungs (1080/720/480) and HLS output.
You can paste it into the MediaConvert console as a template.

## Notes
- You still need to create the MediaConvert IAM Role with S3 read/write.
- If your CloudFront is in front of the same bucket, use the same bucket for HLS outputs.
- The completion Lambda updates Post.mediaUrl to the `.m3u8` manifest URL.
