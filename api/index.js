
import { Redis } from "@upstash/redis";
import { timingSafeEqual, randomUUID } from "node:crypto";

const redis = Redis.fromEnv();

const BRAND = {
  name: "RBX404 API",
  owner: "RBX404",
  credit: "Powered by RBX404",
  channel: "https://t.me/BlackoutZoneRBX404",
  group: "https://t.me/SkillShareBDCommunity"
};

const MAX_REQUESTS = 10;
const COUNTER_KEY = "rbx404:private-demo:total:v1";

const LIMIT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local maximum = tonumber(ARGV[1])

if current >= maximum then
  return {0, current}
end

local next_count = current + 1
redis.call("SET", KEYS[1], next_count)

return {1, next_count}
`;

function sendJSON(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body, null, 2));
}

function brandedResponse(status, message, extra = {}) {
  return {
    status,
    brand: BRAND.name,
    owner: BRAND.owner,
    credit: BRAND.credit,
    channel: BRAND.channel,
    group: BRAND.group,
    message,
    ...extra,
    timestamp: new Date().toISOString()
  };
}

function authorized(req) {
  const received = req.headers.authorization || "";
  const expected = `Bearer ${process.env.API_TOKEN || ""}`;

  if (!process.env.API_TOKEN || received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(received),
    Buffer.from(expected)
  );
}

export default async function handler(req, res) {
  const requestId = randomUUID();

  // Only POST requests
  if (req.method !== "POST") {
    return sendJSON(res, 405,
      brandedResponse(false, "Method not allowed", {
        allowed_method: "POST"
      })
    );
  }

  // Private API authentication
  if (!authorized(req)) {
    return sendJSON(res, 401,
      brandedResponse(false, "Unauthorized access")
    );
  }

  // Required environment configuration
  const required = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "UPSTREAM_URL",
    "TEST_NUMBER"
  ];

  if (required.some(key => !process.env[key])) {
    return sendJSON(res, 503,
      brandedResponse(false, "Server configuration incomplete")
    );
  }

  // Fixed test number only
  const number = process.env.TEST_NUMBER;

  if (!/^\+?[0-9]{8,15}$/.test(number)) {
    return sendJSON(res, 500,
      brandedResponse(false, "Invalid test configuration")
    );
  }

  // Restrict backend to the authorized host
  let upstream;

  try {
    upstream = new URL(process.env.UPSTREAM_URL);

    if (
      upstream.protocol !== "https:" ||
      upstream.hostname !== "nid.proo.one" ||
      upstream.pathname !== "/sms.php"
    ) {
      throw new Error("Invalid endpoint configuration");
    }
  } catch {
    return sendJSON(res, 500,
      brandedResponse(false, "Backend configuration invalid")
    );
  }

  // Atomically reserve one of the 10 total requests
  let limitResult;

  try {
    limitResult = await redis.eval(
      LIMIT_SCRIPT,
      [COUNTER_KEY],
      [MAX_REQUESTS]
    );
  } catch {
    return sendJSON(res, 503,
      brandedResponse(false, "Request counter unavailable")
    );
  }

  const allowed = Number(limitResult[0]) === 1;
  const used = Number(limitResult[1]);

  if (!allowed) {
    return sendJSON(res, 429,
      brandedResponse(false, "Demo request limit exhausted", {
        requests_used: used,
        requests_remaining: 0,
        maximum_requests: MAX_REQUESTS
      })
    );
  }

  // Forward only the fixed authorized test number
  upstream.searchParams.set("number", number);

  try {
    const response = await fetch(upstream, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      headers: {
        "Accept": "application/json"
      }
    });

    // Never expose backend response content
    if (!response.ok) {
      return sendJSON(res, 502,
        brandedResponse(false, "Test backend request failed", {
          request_id: requestId,
          requests_used: used,
          requests_remaining: MAX_REQUESTS - used
        })
      );
    }

    // Consume and discard response body
    await response.arrayBuffer();

    return sendJSON(res, 200,
      brandedResponse(
        true,
        "Request successfully forwarded to test backend",
        {
          request_id: requestId,
          backend_result: "HTTP_SUCCESS",
          delivery_confirmation: false,
          requests_used: used,
          requests_remaining: MAX_REQUESTS - used,
          maximum_requests: MAX_REQUESTS
        }
      )
    );

  } catch {
    return sendJSON(res, 502,
      brandedResponse(false, "Test backend unavailable", {
        request_id: requestId,
        requests_used: used,
        requests_remaining: MAX_REQUESTS - used
      })
    );
  }
}
