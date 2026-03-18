/* eslint-disable no-console */
const {
  MediaConvertClient,
  DescribeEndpointsCommand,
  CreateJobCommand,
} = require("@aws-sdk/client-mediaconvert");

const REGION = process.env.AWS_REGION || "eu-north-1";
const ROLE_ARN = process.env.MEDIACONVERT_ROLE_ARN;
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;
const HLS_PREFIX = process.env.HLS_PREFIX || "hls/";
const ENDPOINT = process.env.MEDIACONVERT_ENDPOINT;
const BRAND_WATERMARK_S3_URL = process.env.BRAND_WATERMARK_S3_URL || "";
const BRAND_OUTRO_S3_URL = process.env.BRAND_OUTRO_S3_URL || "";
const BRAND_WATERMARK_WIDTH = Number(process.env.BRAND_WATERMARK_WIDTH || 180);
const BRAND_WATERMARK_HEIGHT = Number(process.env.BRAND_WATERMARK_HEIGHT || 56);
const BRAND_WATERMARK_X = Number(process.env.BRAND_WATERMARK_X || 40);
const BRAND_WATERMARK_Y = Number(process.env.BRAND_WATERMARK_Y || 40);
const BRAND_WATERMARK_OPACITY = Number(process.env.BRAND_WATERMARK_OPACITY || 70);

if (!ROLE_ARN || !OUTPUT_BUCKET) {
  throw new Error("MEDIACONVERT_ROLE_ARN and OUTPUT_BUCKET are required");
}

const getClient = async () => {
  if (ENDPOINT) {
    return new MediaConvertClient({ region: REGION, endpoint: ENDPOINT });
  }
  const probe = new MediaConvertClient({ region: REGION });
  const endpoints = await probe.send(new DescribeEndpointsCommand({ MaxResults: 1 }));
  const url = endpoints.Endpoints[0].Url;
  return new MediaConvertClient({ region: REGION, endpoint: url });
};

exports.handler = async (event) => {
  const record = event.Records?.[0];
  if (!record) return;

  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  if (!key.match(/\.(mp4|mov|m4v)$/i)) return;

  const client = await getClient();

  const inputUrl = `s3://${bucket}/${key}`;
  const baseName = key.replace(/^user-uploads\//, "").replace(/\.[^.]+$/, "");
  const outputPrefix = `${HLS_PREFIX}${baseName}/`;
  const shouldBrand = key.includes("/post/branded/");

  const buildVideoDescription = (width, height, maxBitrate) => ({
    Width: width,
    Height: height,
    CodecSettings: {
      Codec: "H_264",
      H264Settings: {
        RateControlMode: "QVBR",
        MaxBitrate: maxBitrate,
        GopSize: 2,
        GopSizeUnits: "SECONDS",
        QvbrSettings: { QvbrQualityLevel: 7 },
        SceneChangeDetect: "TRANSITION_DETECTION",
      },
    },
    ...(shouldBrand && BRAND_WATERMARK_S3_URL
      ? {
          VideoPreprocessors: {
            ImageInserter: {
              InsertableImages: [
                {
                  ImageInserterInput: BRAND_WATERMARK_S3_URL,
                  Layer: 1,
                  Opacity: BRAND_WATERMARK_OPACITY,
                  ImageX: BRAND_WATERMARK_X,
                  ImageY: BRAND_WATERMARK_Y,
                  Width: BRAND_WATERMARK_WIDTH,
                  Height: BRAND_WATERMARK_HEIGHT,
                },
              ],
            },
          },
        }
      : {}),
  });

  const inputs = [
    {
      FileInput: inputUrl,
      AudioSelectors: {
        "Audio Selector 1": {
          DefaultSelection: "DEFAULT",
        },
      },
      VideoSelector: {},
    },
  ];

  if (shouldBrand && BRAND_OUTRO_S3_URL) {
    inputs.push({
      FileInput: BRAND_OUTRO_S3_URL,
      AudioSelectors: {
        "Audio Selector 1": {
          DefaultSelection: "DEFAULT",
        },
      },
      VideoSelector: {},
    });
  }

  const job = {
    Role: ROLE_ARN,
    Settings: {
      Inputs: inputs,
      OutputGroups: [
        {
          Name: "HLS",
          OutputGroupSettings: {
            Type: "HLS_GROUP_SETTINGS",
            HlsGroupSettings: {
              Destination: `s3://${OUTPUT_BUCKET}/${outputPrefix}`,
              SegmentLength: 2,
              MinSegmentLength: 1,
            },
          },
          Outputs: [
            {
              NameModifier: "_1080",
              VideoDescription: buildVideoDescription(1920, 1080, 3500000),
              AudioDescriptions: [
                {
                  CodecSettings: {
                    Codec: "AAC",
                    AacSettings: {
                      Bitrate: 128000,
                      CodingMode: "CODING_MODE_2_0",
                      SampleRate: 48000,
                    },
                  },
                },
              ],
              ContainerSettings: { Container: "M3U8" },
            },
            {
              NameModifier: "_720",
              VideoDescription: buildVideoDescription(1280, 720, 2500000),
              AudioDescriptions: [
                {
                  CodecSettings: {
                    Codec: "AAC",
                    AacSettings: {
                      Bitrate: 128000,
                      CodingMode: "CODING_MODE_2_0",
                      SampleRate: 48000,
                    },
                  },
                },
              ],
              ContainerSettings: { Container: "M3U8" },
            },
            {
              NameModifier: "_480",
              VideoDescription: buildVideoDescription(854, 480, 1200000),
              AudioDescriptions: [
                {
                  CodecSettings: {
                    Codec: "AAC",
                    AacSettings: {
                      Bitrate: 96000,
                      CodingMode: "CODING_MODE_2_0",
                      SampleRate: 48000,
                    },
                  },
                },
              ],
              ContainerSettings: { Container: "M3U8" },
            },
          ],
        },
      ],
    },
    UserMetadata: {
      s3Key: key,
      outputPrefix,
      branded: shouldBrand ? "1" : "0",
    },
  };

  await client.send(new CreateJobCommand(job));
  console.log("MediaConvert job started", { key });
};
