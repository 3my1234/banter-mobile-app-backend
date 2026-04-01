import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://sportbanter.online";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || "2m",
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<1200", "p(99)<2500"],
  },
};

const authHeaders = AUTH_TOKEN
  ? { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" }
  : { "Content-Type": "application/json" };

export default function () {
  const health = http.get(`${BASE_URL}/health`);
  check(health, {
    "health status 200": (r) => r.status === 200,
  });

  const apiHealth = http.get(`${BASE_URL}/api/health`);
  check(apiHealth, {
    "api health status 200": (r) => r.status === 200,
  });

  if (AUTH_TOKEN) {
    const posts = http.get(`${BASE_URL}/api/posts?type=posts&feed=forYou&page=1&limit=20`, {
      headers: authHeaders,
    });
    check(posts, {
      "posts status 200": (r) => r.status === 200,
    });

    const wallet = http.get(`${BASE_URL}/api/wallet/overview?limit=20&page=1`, {
      headers: authHeaders,
    });
    check(wallet, {
      "wallet overview status 200": (r) => r.status === 200,
    });
  }

  sleep(1);
}
