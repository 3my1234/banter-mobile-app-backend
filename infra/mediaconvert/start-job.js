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

  const job = {
    Role: ROLE_ARN,
    Settings: {
      Inputs: [
        {
          FileInput: inputUrl,
          AudioSelectors: {
            "Audio Selector 1": {
              DefaultSelection: "DEFAULT",
            },
          },
          VideoSelector: {},
        },
      ],
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
              VideoDescription: {
                Width: 1920,
                Height: 1080,
                CodecSettings: {
                  Codec: "H_264",
                  H264Settings: {
                    RateControlMode: "QVBR",
                    SceneChangeDetect: "TRANSITION_DETECTION",
                  },
                },
              },
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
              VideoDescription: {
                Width: 1280,
                Height: 720,
                CodecSettings: {
                  Codec: "H_264",
                  H264Settings: {
                    RateControlMode: "QVBR",
                    SceneChangeDetect: "TRANSITION_DETECTION",
                  },
                },
              },
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
              VideoDescription: {
                Width: 854,
                Height: 480,
                CodecSettings: {
                  Codec: "H_264",
                  H264Settings: {
                    RateControlMode: "QVBR",
                    SceneChangeDetect: "TRANSITION_DETECTION",
                  },
                },
              },
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
    },
  };

  await client.send(new CreateJobCommand(job));
  console.log("MediaConvert job started", { key });
};
