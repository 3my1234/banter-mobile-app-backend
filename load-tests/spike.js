import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://sportbanter.online";

export const options = {
  stages: [
    { duration: "30s", target: 50 },
    { duration: "45s", target: 300 },
    { duration: "45s", target: 600 },
    { duration: "1m", target: 200 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<1800", "p(99)<3500"],
  },
};

export default function () {
  const health = http.get(`${BASE_URL}/health`);
  check(health, { "health 200": (r) => r.status === 200 });

  const apiHealth = http.get(`${BASE_URL}/api/health`);
  check(apiHealth, { "api health 200": (r) => r.status === 200 });

  sleep(0.5);
}
